import crypto from "node:crypto";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomWebhookBotMediaSender: ${name} is required`);
  }
}

function resolveWebhookDispatcher(attachWecomProxyDispatcher, url, proxyUrl, logger) {
  const options = attachWecomProxyDispatcher(url, {}, { proxyUrl, logger });
  return options?.dispatcher;
}

export function createWecomWebhookBotMediaSender({
  resolveWebhookBotSendUrl,
  resolveWecomOutboundMediaTarget,
  fetchMediaFromUrl,
  webhookSendImage,
  webhookSendFileBuffer,
  attachWecomProxyDispatcher,
  fetchImpl = fetch,
} = {}) {
  assertFunction("resolveWebhookBotSendUrl", resolveWebhookBotSendUrl);
  assertFunction("resolveWecomOutboundMediaTarget", resolveWecomOutboundMediaTarget);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("webhookSendImage", webhookSendImage);
  assertFunction("webhookSendFileBuffer", webhookSendFileBuffer);
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);

  return async function sendWebhookBotMediaBatch({
    api,
    webhookBotPolicy,
    proxyUrl,
    mediaUrls,
    mediaItems,
    mediaType,
  }) {
    const sendUrl = resolveWebhookBotSendUrl({
      url: webhookBotPolicy?.url,
      key: webhookBotPolicy?.key,
    });
    if (!sendUrl) {
      return {
        sentCount: 0,
        failedCount: Array.isArray(mediaUrls) ? mediaUrls.length : 0,
        failedUrls: Array.isArray(mediaUrls) ? mediaUrls : [],
        reason: "webhook-bot-url-missing",
      };
    }

    const logger = api?.logger;
    const dispatcher = resolveWebhookDispatcher(attachWecomProxyDispatcher, sendUrl, proxyUrl, logger);
    let sentCount = 0;
    const failedUrls = [];
    const rawItems = [
      ...(Array.isArray(mediaUrls) ? mediaUrls : []).map((url) => ({
        url,
        mediaType,
      })),
      ...(Array.isArray(mediaItems) ? mediaItems : []),
    ];
    const dedupe = new Set();
    const candidateMediaItems = [];
    for (const item of rawItems) {
      const normalizedUrl = String(item?.url ?? "").trim();
      const normalizedType = String(item?.mediaType ?? "").trim().toLowerCase() || undefined;
      if (!normalizedUrl) continue;
      const dedupeKey = `${normalizedType || ""}:${normalizedUrl}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
      candidateMediaItems.push({
        url: normalizedUrl,
        mediaType: normalizedType,
      });
    }

    for (const mediaItem of candidateMediaItems) {
      const target = resolveWecomOutboundMediaTarget({
        mediaUrl: mediaItem.url,
        mediaType: mediaItem.mediaType ?? mediaType,
      });
      try {
        const { buffer } = await fetchMediaFromUrl(mediaItem.url, {
          proxyUrl,
          logger,
          forceProxy: Boolean(proxyUrl),
          maxBytes: 20 * 1024 * 1024,
        });
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error("empty media buffer");
        }

        if (target.type === "image") {
          const base64 = buffer.toString("base64");
          const md5 = crypto.createHash("md5").update(buffer).digest("hex");
          await webhookSendImage({
            url: webhookBotPolicy?.url,
            key: webhookBotPolicy?.key,
            base64,
            md5,
            timeoutMs: webhookBotPolicy?.timeoutMs,
            dispatcher,
            fetchImpl,
          });
        } else {
          await webhookSendFileBuffer({
            url: webhookBotPolicy?.url,
            key: webhookBotPolicy?.key,
            buffer,
            filename: target.filename,
            timeoutMs: webhookBotPolicy?.timeoutMs,
            dispatcher,
            fetchImpl,
          });
        }
        sentCount += 1;
      } catch (err) {
        failedUrls.push(mediaItem.url);
        logger?.warn?.(
          `wecom(bot): webhook media send failed target=${mediaItem.url} type=${target.type} reason=${String(err?.message || err)}`,
        );
      }
    }

    return {
      sentCount,
      failedCount: failedUrls.length,
      failedUrls,
      reason: failedUrls.length > 0 && sentCount === 0 ? "webhook-bot-media-failed" : "ok",
    };
  };
}
