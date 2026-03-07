function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomActiveStreamDeliverer: ${name} is required`);
  }
}

export function createWecomActiveStreamDeliverer({
  hasBotStream,
  resolveActiveBotStreamId,
  drainBotStreamMedia,
  normalizeWecomBotOutboundMediaUrls,
  buildActiveStreamMsgItems,
  finishBotStream,
  fetchMediaFromUrl,
} = {}) {
  assertFunction("hasBotStream", hasBotStream);
  assertFunction("resolveActiveBotStreamId", resolveActiveBotStreamId);
  assertFunction("drainBotStreamMedia", drainBotStreamMedia);
  assertFunction("normalizeWecomBotOutboundMediaUrls", normalizeWecomBotOutboundMediaUrls);
  assertFunction("buildActiveStreamMsgItems", buildActiveStreamMsgItems);
  assertFunction("finishBotStream", finishBotStream);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);

  return async function deliverActiveStreamReply({
    streamId,
    sessionId,
    content = "",
    thinkingContent = "",
    normalizedMediaUrls = [],
    mediaType,
    normalizedText = "",
    fallbackText = "",
    botProxyUrl = "",
    logger,
  } = {}) {
    let targetStreamId = String(streamId ?? "").trim();
    let recoveredBySession = false;
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!targetStreamId || !hasBotStream(targetStreamId)) {
      const recovered = String(resolveActiveBotStreamId(normalizedSessionId) ?? "").trim();
      if (recovered && hasBotStream(recovered)) {
        targetStreamId = recovered;
        recoveredBySession = true;
      }
    }
    if (!targetStreamId || !hasBotStream(targetStreamId)) {
      return { ok: false, reason: "stream-missing" };
    }

    const drainedQueuedMedia = drainBotStreamMedia(targetStreamId);
    const queuedMedia = Array.isArray(drainedQueuedMedia) ? drainedQueuedMedia : [];
    const queuedMediaUrls = [];
    let queuedMediaType = "";
    for (const item of queuedMedia) {
      const url = String(item?.url ?? "").trim();
      if (!url) continue;
      queuedMediaUrls.push(url);
      if (!queuedMediaType) {
        queuedMediaType = String(item?.mediaType ?? "").trim().toLowerCase();
      }
    }
    const mergedMediaUrls = normalizeWecomBotOutboundMediaUrls({
      mediaUrls: [...normalizedMediaUrls, ...queuedMediaUrls],
    });
    const effectiveMediaType = String(mediaType ?? "").trim().toLowerCase() || queuedMediaType || undefined;

    let streamMsgItem = [];
    let fallbackMediaUrls = mergedMediaUrls;
    if (mergedMediaUrls.length > 0) {
      const processed = await buildActiveStreamMsgItems({
        mediaUrls: mergedMediaUrls,
        mediaType: effectiveMediaType,
        fetchMediaFromUrl,
        proxyUrl: botProxyUrl,
        logger,
      });
      streamMsgItem = processed.msgItem;
      fallbackMediaUrls = processed.fallbackUrls;
    }

    let streamContent = String(content ?? "").trim();
    const normalizedThinkingContent = String(thinkingContent ?? "").trim();
    if (!streamContent) {
      if (fallbackMediaUrls.length > 0) {
        streamContent = fallbackText;
      } else if (streamMsgItem.length > 0) {
        streamContent = "已收到模型返回的媒体结果。";
      } else if (normalizedThinkingContent) {
        streamContent = "";
      } else {
        streamContent = "";
      }
    }
    if (!normalizedText && streamMsgItem.length > 0 && fallbackMediaUrls.length === 0 && streamContent === fallbackText) {
      streamContent = "已收到模型返回的媒体结果。";
    }
    if (fallbackMediaUrls.length > 0) {
      const suffix = `\n\n媒体链接：\n${fallbackMediaUrls.join("\n")}`;
      streamContent = `${streamContent}${suffix}`.trim();
    }
    if (!streamContent && !normalizedThinkingContent) {
      streamContent = "已收到模型返回的结果。";
    }

    const finishOptions = { msgItem: streamMsgItem };
    if (normalizedThinkingContent) {
      finishOptions.thinkingContent = normalizedThinkingContent;
    }
    finishBotStream(targetStreamId, streamContent, finishOptions);
    return {
      ok: true,
      meta: {
        streamId: targetStreamId,
        recoveredBySession,
        mediaAsLinks: fallbackMediaUrls.length > 0,
        msgItemCount: streamMsgItem.length,
        queuedMediaCount: queuedMediaUrls.length,
      },
    };
  };
}
