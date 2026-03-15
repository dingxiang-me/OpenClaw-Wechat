import { applyWecomReasoningPolicy } from "./reasoning-visibility.js";
import { extractWecomReplyDirectives } from "./reply-output-policy.js";
import { parseThinkingContent } from "./thinking-parser.js";

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
  sessionId = "",
  runtimeAccountId = "default",
  fromUser,
  routedAgentId = "",
  corpId = "",
  corpSecret = "",
  agentId = "",
  proxyUrl = "",
  apiBaseUrl = "",
  flushStreamingBuffer,
  sendFailureFallback,
  sendTextToUser,
  deliverAgentReply = null,
  markdownToWecomText,
  isAgentFailureText,
  computeStreamingTailText,
  autoSendWorkspaceFilesFromReplyText,
  buildWorkspaceAutoSendHints,
  sendWecomOutboundMediaBatch,
  reasoningPolicy = {},
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
          const blockParsed = parseThinkingContent(payload.text);
          const blockVisibleText = extractWecomReplyDirectives(markdownToWecomText(blockParsed.visibleContent).trim()).text;
          if (blockVisibleText) {
            state.blockTextFallback = appendWecomAgentBlockFallback(state.blockTextFallback, blockVisibleText);
          }
          if (streamingEnabled) {
            state.streamChunkBuffer += blockVisibleText || "";
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

        const parsedFinal = parseThinkingContent(payload.text);
        const parsedRawFinal = parseThinkingContent(String(payload.rawText ?? payload.text ?? ""));
        const reasoningPayload = applyWecomReasoningPolicy({
          text: markdownToWecomText(parsedFinal.visibleContent).trim(),
          thinkingContent: markdownToWecomText(parsedFinal.thinkingContent).trim(),
          policy: reasoningPolicy,
          transport: "agent",
          phase: "final",
        });
        const rawReasoningPayload = applyWecomReasoningPolicy({
          text: String(parsedRawFinal.visibleContent ?? "").trim(),
          thinkingContent: String(payload.rawThinkingContent ?? parsedRawFinal.thinkingContent ?? "").trim(),
          policy: reasoningPolicy,
          transport: "agent",
          phase: "final",
        });
        const effectiveFinalText = extractWecomReplyDirectives(String(reasoningPayload.text ?? "").trim()).text;
        const richFinalText = extractWecomReplyDirectives(String(rawReasoningPayload.text ?? "").trim()).text;

        logger?.info?.(`wecom: delivering ${info.kind} reply, length=${payload.text.length}`);
        if (streamingEnabled) {
          await flushStreamingBuffer({ force: true, reason: "final" });
          await state.streamChunkSendChain;
          if (state.streamChunkSentCount > 0) {
            const finalText = effectiveFinalText;
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
          const formattedReply = effectiveFinalText;
          const workspaceAutoMedia = await autoSendWorkspaceFilesFromReplyText({
            text: String(payload.rawText ?? payload.text ?? formattedReply),
            routeAgentId: routedAgentId,
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            logger,
            proxyUrl,
            apiBaseUrl,
          });
          const workspaceHints = buildWorkspaceAutoSendHints(workspaceAutoMedia);
          const finalReplyText = [formattedReply, ...workspaceHints].filter(Boolean).join("\n\n");
          if (typeof deliverAgentReply === "function") {
            const result = await deliverAgentReply({
              api,
              fromUser,
              accountId: runtimeAccountId,
              sessionId,
              text: finalReplyText,
              rawText: [richFinalText, ...workspaceHints].filter(Boolean).join("\n\n"),
              rawThinkingContent: String(rawReasoningPayload.thinkingContent ?? "").trim(),
              routeAgentId: routedAgentId,
              reason: "final-reply",
            });
            state.hasDeliveredReply = true;
            deliveredFinalText = result?.ok === true;
            if (!result?.ok) {
              logger?.warn?.(`wecom: final agent reply deferred to pending delivery session=${sessionId || "n/a"}`);
            }
          } else {
            await sendTextToUser(finalReplyText);
            state.hasDeliveredReply = true;
            deliveredFinalText = true;
          }
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
          apiBaseUrl,
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
