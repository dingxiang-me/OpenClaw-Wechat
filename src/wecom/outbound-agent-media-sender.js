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
    mediaType,
    logger,
    proxyUrl,
    apiProxy,
    maxBytes = 20 * 1024 * 1024,
  } = {}) {
    const candidates = normalizeOutboundMediaUrls({ mediaUrl, mediaUrls });
    if (candidates.length === 0) {
      return { total: 0, sentCount: 0, failed: [] };
    }

    let sentCount = 0;
    const failed = [];

    for (const candidate of candidates) {
      try {
        const target = resolveWecomOutboundMediaTarget({
          mediaUrl: candidate,
          mediaType: candidates.length === 1 ? mediaType : undefined,
        });
        const { buffer } = await fetchMediaFromUrl(candidate, {
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
            apiProxy,
          });
          logger?.info?.(
            `wecom: tiny file fallback as text (${buffer.length} bytes) target=${candidate.slice(0, 120)}`,
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
            apiProxy,
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
            apiProxy,
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
            apiProxy,
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
            apiProxy,
          });
        }
        sentCount += 1;
      } catch (err) {
        failed.push({
          url: candidate,
          reason: String(err?.message || err),
        });
        logger?.warn?.(`wecom: failed to send outbound media ${candidate}: ${String(err?.message || err)}`);
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
