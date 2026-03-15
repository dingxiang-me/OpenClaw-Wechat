function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentMediaSender: ${name} is required`);
  }
}

export function createWecomAgentMediaSender({
  normalizeOutboundMediaUrls,
  resolveWecomOutboundMediaTarget,
  fetchMediaFromUrl,
  buildTinyFileFallbackText,
  sendWecomText,
  uploadWecomMedia,
  sendWecomImage,
  sendWecomVideo,
  sendWecomVoice,
  sendWecomFile,
  minFileSize = 5,
} = {}) {
  assertFunction("normalizeOutboundMediaUrls", normalizeOutboundMediaUrls);
  assertFunction("resolveWecomOutboundMediaTarget", resolveWecomOutboundMediaTarget);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("buildTinyFileFallbackText", buildTinyFileFallbackText);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("uploadWecomMedia", uploadWecomMedia);
  assertFunction("sendWecomImage", sendWecomImage);
  assertFunction("sendWecomVideo", sendWecomVideo);
  assertFunction("sendWecomVoice", sendWecomVoice);
  assertFunction("sendWecomFile", sendWecomFile);

  async function sendWecomOutboundMediaBatch({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    mediaUrl,
    mediaUrls,
    mediaItems,
    mediaType,
    logger,
    proxyUrl,
    apiBaseUrl,
    maxBytes = 20 * 1024 * 1024,
  } = {}) {
    const rawItems = [
      ...[mediaUrl, ...(Array.isArray(mediaUrls) ? mediaUrls : [])]
        .map((url) => ({
          url,
          mediaType,
        }))
        .filter((item) => String(item?.url ?? "").trim()),
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
    if (candidates.length === 0) {
      return { total: 0, sentCount: 0, failed: [] };
    }

    let sentCount = 0;
    const failed = [];

    for (const candidate of candidates) {
      try {
        const target = resolveWecomOutboundMediaTarget({
          mediaUrl: candidate.url,
          mediaType: candidate.mediaType ?? (candidates.length === 1 ? mediaType : undefined),
        });
        const { buffer } = await fetchMediaFromUrl(candidate.url, {
          proxyUrl,
          logger,
          forceProxy: Boolean(proxyUrl),
          maxBytes,
        });
        if (target.type === "file" && buffer.length < minFileSize) {
          const fallbackText = buildTinyFileFallbackText({
            fileName: target.filename,
            buffer,
          });
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser,
            toParty,
            toTag,
            chatId,
            text: fallbackText,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
          logger?.info?.(
            `wecom: tiny file fallback as text (${buffer.length} bytes) target=${candidate.url.slice(0, 120)}`,
          );
          sentCount += 1;
          continue;
        }
        const mediaId = await uploadWecomMedia({
          corpId,
          corpSecret,
          type: target.type === "voice" ? "voice" : target.type,
          buffer,
          filename: target.filename,
          logger,
          proxyUrl,
          apiBaseUrl,
        });
        if (target.type === "image") {
          await sendWecomImage({
            corpId,
            corpSecret,
            agentId,
            toUser,
            toParty,
            toTag,
            chatId,
            mediaId,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
        } else if (target.type === "video") {
          await sendWecomVideo({
            corpId,
            corpSecret,
            agentId,
            toUser,
            toParty,
            toTag,
            chatId,
            mediaId,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
        } else if (target.type === "voice") {
          await sendWecomVoice({
            corpId,
            corpSecret,
            agentId,
            toUser,
            toParty,
            toTag,
            chatId,
            mediaId,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
        } else {
          await sendWecomFile({
            corpId,
            corpSecret,
            agentId,
            toUser,
            toParty,
            toTag,
            chatId,
            mediaId,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
        }
        sentCount += 1;
      } catch (err) {
        failed.push({
          url: candidate.url,
          reason: String(err?.message || err),
        });
        logger?.warn?.(`wecom: failed to send outbound media ${candidate.url}: ${String(err?.message || err)}`);
      }
    }

    return {
      total: candidates.length,
      sentCount,
      failed,
    };
  }

  return {
    sendWecomOutboundMediaBatch,
  };
}
