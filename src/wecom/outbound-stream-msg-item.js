import crypto from "node:crypto";

import { resolveWecomOutboundMediaTarget } from "./media-url-utils.js";

const ACTIVE_STREAM_MSG_ITEM_LIMIT = 10;
const ACTIVE_STREAM_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function isSupportedActiveStreamMsgItemImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return false;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return true;
  if (buffer.length < 8) return false;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return pngSignature.every((byte, idx) => buffer[idx] === byte);
}

export async function buildActiveStreamMsgItems({
  mediaUrls,
  mediaItems,
  mediaType,
  fetchMediaFromUrl,
  proxyUrl,
  logger,
}) {
  const msgItem = [];
  const fallbackUrls = [];
  const rawItems = [
    ...(Array.isArray(mediaUrls) ? mediaUrls : []).map((url) => ({
      url,
      mediaType,
    })),
    ...(Array.isArray(mediaItems) ? mediaItems : []),
  ];
  const dedupe = new Set();
  const candidates = [];
  for (const item of rawItems) {
    const normalizedUrl = String(item?.url ?? "").trim();
    const normalizedType = String(item?.mediaType ?? "").trim().toLowerCase() || undefined;
    if (!normalizedUrl) continue;
    const dedupeKey = `${normalizedType || ""}:${normalizedUrl}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);
    candidates.push({
      url: normalizedUrl,
      mediaType: normalizedType,
    });
  }

  for (const mediaItem of candidates) {
    const mediaUrl = mediaItem.url;
    if (msgItem.length >= ACTIVE_STREAM_MSG_ITEM_LIMIT) {
      fallbackUrls.push(mediaUrl);
      continue;
    }
    const target = resolveWecomOutboundMediaTarget({ mediaUrl, mediaType: mediaItem.mediaType ?? mediaType });
    if (target.type !== "image") {
      fallbackUrls.push(mediaUrl);
      continue;
    }
    try {
      const { buffer } = await fetchMediaFromUrl(mediaUrl, {
        proxyUrl,
        logger,
        forceProxy: Boolean(proxyUrl),
        maxBytes: ACTIVE_STREAM_IMAGE_MAX_BYTES,
      });
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("empty image buffer");
      }
      if (buffer.length > ACTIVE_STREAM_IMAGE_MAX_BYTES) {
        throw new Error("image too large for stream msg_item");
      }
      if (!isSupportedActiveStreamMsgItemImage(buffer)) {
        throw new Error("unsupported image format for stream msg_item (jpg/png only)");
      }
      msgItem.push({
        msgtype: "image",
        image: {
          base64: buffer.toString("base64"),
          md5: crypto.createHash("md5").update(buffer).digest("hex"),
        },
      });
    } catch (err) {
      logger?.warn?.(`wecom(bot): active_stream msg_item image fallback ${mediaUrl}: ${String(err?.message || err)}`);
      fallbackUrls.push(mediaUrl);
    }
  }

  return { msgItem, fallbackUrls };
}
