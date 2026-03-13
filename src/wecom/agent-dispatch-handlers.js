function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentDispatchHandlers: ${name} is required`);
  }
}

export function appendWecomAgentBlockFallback(currentText = "", incomingText = "") {
  const current = String(currentText ?? "");
  const incoming = String(incomingText ?? "").trim();
  if (!incoming) return current;
  if (!current) return incoming;
  return `${current}\n${incoming}`;
}

export function createWecomAgentDispatchHandlers({
  api,
  state,
  streamingEnabled = false,
  fromUser,
  routedAgentId = "",
  corpId = "",
  corpSecret = "",
  agentId = "",
  proxyUrl = "",
  apiProxy = "",
  flushStreamingBuffer,
  sendFailureFallback,
  sendTextToUser,
  markdownToWecomText,
  isAgentFailureText,
  computeStreamingTailText,
  autoSendWorkspaceFilesFromReplyText,
  buildWorkspaceAutoSendHints,
  sendWecomOutboundMediaBatch,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("createWecomAgentDispatchHandlers: state is required");
  }
  if (!("hasDeliveredReply" in state)) state.hasDeliveredReply = false;
  if (!("hasDeliveredPartialReply" in state)) state.hasDeliveredPartialReply = false;
  if (!("blockTextFallback" in state)) state.blockTextFallback = "";
  if (!("streamChunkBuffer" in state)) state.streamChunkBuffer = "";
  if (!("streamChunkSentCount" in state)) state.streamChunkSentCount = 0;
  if (!("streamChunkSendChain" in state)) state.streamChunkSendChain = Promise.resolve();
  if (!("suppressLateDispatcherDeliveries" in state)) state.suppressLateDispatcherDeliveries = false;

  assertFunction("flushStreamingBuffer", flushStreamingBuffer);
  assertFunction("sendFailureFallback", sendFailureFallback);
  assertFunction("sendTextToUser", sendTextToUser);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("isAgentFailureText", isAgentFailureText);
  assertFunction("computeStreamingTailText", computeStreamingTailText);
  assertFunction("autoSendWorkspaceFilesFromReplyText", autoSendWorkspaceFilesFromReplyText);
  assertFunction("buildWorkspaceAutoSendHints", buildWorkspaceAutoSendHints);
  assertFunction("sendWecomOutboundMediaBatch", sendWecomOutboundMediaBatch);

  const logger = api?.logger;

  return {
    deliver: async (payload, info) => {
      if (state.suppressLateDispatcherDeliveries) {
        logger?.info?.("wecom: suppressed late dispatcher delivery after timeout handoff");
        return;
      }
      if (state.hasDeliveredReply) {
        logger?.info?.("wecom: ignoring late reply because a reply was already delivered");
        return;
      }
      if (info.kind === "block") {
        if (payload.text) {
          state.blockTextFallback = appendWecomAgentBlockFallback(state.blockTextFallback, payload.text);
          if (streamingEnabled) {
            state.streamChunkBuffer += payload.text;
            await flushStreamingBuffer({ force: false, reason: "block" });
          }
        }
        return;
      }
      if (info.kind !== "final") return;

      let deliveredFinalText = false;
      if (payload.text) {
        if (isAgentFailureText(payload.text)) {
          logger?.warn?.(`wecom: upstream returned failure-like payload: ${payload.text}`);
          await sendFailureFallback(payload.text);
          return;
        }

        logger?.info?.(`wecom: delivering ${info.kind} reply, length=${payload.text.length}`);
        if (streamingEnabled) {
          await flushStreamingBuffer({ force: true, reason: "final" });
          await state.streamChunkSendChain;
          if (state.streamChunkSentCount > 0) {
            const finalText = markdownToWecomText(payload.text).trim();
            const streamedText = markdownToWecomText(state.blockTextFallback).trim();
            const tailText = computeStreamingTailText({ finalText, streamedText });
            if (tailText) {
              await sendTextToUser(tailText);
            }
            state.hasDeliveredReply = true;
            deliveredFinalText = true;
            logger?.info?.(
              `wecom: streaming reply completed for ${fromUser}, chunks=${state.streamChunkSentCount}${tailText ? " +tail" : ""}`,
            );
          }
        }

        if (!deliveredFinalText) {
          const formattedReply = markdownToWecomText(payload.text);
          const workspaceAutoMedia = await autoSendWorkspaceFilesFromReplyText({
            text: formattedReply,
            routeAgentId: routedAgentId,
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            logger,
            proxyUrl,
            apiProxy,
          });
          const workspaceHints = buildWorkspaceAutoSendHints(workspaceAutoMedia);
          const finalReplyText = [formattedReply, ...workspaceHints].filter(Boolean).join("\n\n");
          await sendTextToUser(finalReplyText);
          state.hasDeliveredReply = true;
          deliveredFinalText = true;
          logger?.info?.(`wecom: sent AI reply to ${fromUser}: ${finalReplyText.slice(0, 50)}...`);
        }
      }

      if (payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0) {
        const mediaResult = await sendWecomOutboundMediaBatch({
          corpId,
          corpSecret,
          agentId,
          toUser: fromUser,
          mediaUrl: payload.mediaUrl,
          mediaUrls: payload.mediaUrls,
          mediaType: payload.mediaType,
          logger,
          proxyUrl,
          apiProxy,
        });
        if (mediaResult.sentCount > 0) {
          state.hasDeliveredReply = true;
        }
        if (mediaResult.failed.length > 0 && mediaResult.sentCount > 0) {
          await sendTextToUser(`已回传 ${mediaResult.sentCount} 个媒体，另有 ${mediaResult.failed.length} 个失败。`);
        }
        if (mediaResult.sentCount === 0 && !deliveredFinalText) {
          await sendTextToUser("已收到模型返回的媒体结果，但媒体回传失败，请稍后重试。");
          state.hasDeliveredReply = true;
        }
      }
    },
    onError: async (err, info) => {
      if (state.suppressLateDispatcherDeliveries) return;
      logger?.error?.(`wecom: ${info.kind} reply failed: ${String(err)}`);
      try {
        await sendFailureFallback(err);
      } catch (fallbackErr) {
        logger?.error?.(`wecom: failed to send fallback reply: ${fallbackErr.message}`);
      }
    },
  };
}
