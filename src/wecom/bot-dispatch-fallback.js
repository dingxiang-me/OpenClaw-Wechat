import { parseThinkingContent } from "./thinking-parser.js";
import { applyWecomReasoningPolicy } from "./reasoning-visibility.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`bot-dispatch-fallback: ${name} is required`);
  }
}

export function buildWecomBotVisibleFallbackPayload(
  rawText = "",
  markdownToWecomText = (text) => String(text ?? ""),
  reasoningPolicy = {},
) {
  const parsed = parseThinkingContent(rawText);
  const visibleContent = markdownToWecomText(parsed.visibleContent).trim();
  const thinkingContent = markdownToWecomText(parsed.thinkingContent).trim();
  const resolved = applyWecomReasoningPolicy({
    text: visibleContent,
    thinkingContent,
    policy: reasoningPolicy,
    transport: "bot",
    phase: "final",
  });
  return {
    text: resolved.text,
    thinkingContent: resolved.thinkingContent,
  };
}

export async function handleWecomBotPostDispatchFallback({
  api,
  sessionId,
  dispatchState,
  dispatchStartedAt,
  tryFinishFromTranscript,
  markdownToWecomText,
  safeDeliverReply,
  startLateReplyWatcher,
  reasoningPolicy = {},
} = {}) {
  if (!dispatchState || typeof dispatchState !== "object") {
    throw new Error("handleWecomBotPostDispatchFallback: dispatchState is required");
  }
  assertFunction("tryFinishFromTranscript", tryFinishFromTranscript);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("safeDeliverReply", safeDeliverReply);
  assertFunction("startLateReplyWatcher", startLateReplyWatcher);

  if (dispatchState.streamFinished) return false;
  const filledFromTranscript = await tryFinishFromTranscript(dispatchStartedAt);
  if (filledFromTranscript) return false;

  const { text: fallback, thinkingContent } = buildWecomBotVisibleFallbackPayload(
    dispatchState.blockText,
    markdownToWecomText,
    reasoningPolicy,
  );
  if (fallback || thinkingContent) {
    await safeDeliverReply(
      {
        text: fallback,
        thinkingContent,
      },
      "block-fallback",
    );
    return false;
  }

  const watcherStarted = startLateReplyWatcher("dispatch-finished-without-final", dispatchStartedAt);
  if (watcherStarted) return true;

  api?.logger?.warn?.(
    `wecom(bot): dispatch finished without deliverable content; late watcher unavailable, fallback to timeout text session=${sessionId}`,
  );
  await safeDeliverReply("抱歉，当前模型请求超时或网络不稳定，请稍后重试。", "timeout-fallback");
  return false;
}

export async function handleWecomBotDispatchError({
  api,
  err,
  dispatchStartedAt,
  isDispatchTimeoutError,
  startLateReplyWatcher,
  sessionId,
  fromUser,
  accountId = "default",
  buildWecomBotSessionId,
  runtime,
  cfg,
  routedAgentId,
  dispatchState,
  markdownToWecomText,
  readTranscriptFallbackResult,
  safeDeliverReply,
  markTranscriptReplyDelivered,
  reasoningPolicy = {},
} = {}) {
  assertFunction("isDispatchTimeoutError", isDispatchTimeoutError);
  assertFunction("startLateReplyWatcher", startLateReplyWatcher);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("readTranscriptFallbackResult", readTranscriptFallbackResult);
  assertFunction("safeDeliverReply", safeDeliverReply);
  assertFunction("markTranscriptReplyDelivered", markTranscriptReplyDelivered);
  assertFunction("markdownToWecomText", markdownToWecomText);

  api?.logger?.warn?.(`wecom(bot): processing failed: ${String(err?.message || err)}`);
  if (dispatchState && typeof dispatchState === "object" && dispatchState.streamFinished !== true) {
    const partialPayload = buildWecomBotVisibleFallbackPayload(dispatchState.blockText, markdownToWecomText, reasoningPolicy);
    if (partialPayload.text || partialPayload.thinkingContent) {
      const delivered = await safeDeliverReply(partialPayload, "timeout-partial-fallback");
      if (delivered) return true;
    }
  }
  if (isDispatchTimeoutError(err)) {
    const watcherStarted = (() => {
      try {
        return startLateReplyWatcher("dispatch-timeout", dispatchStartedAt);
      } catch {
        return false;
      }
    })();
    if (watcherStarted) return true;
  }

  try {
    const runtimeSessionId = sessionId || buildWecomBotSessionId(fromUser, accountId);
    const runtimeStorePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: routedAgentId || "main",
    });
    const fallbackFromTranscript = await readTranscriptFallbackResult({
      runtimeStorePath,
      runtimeSessionId,
      runtimeTranscriptSessionId: runtimeSessionId,
      minTimestamp: dispatchStartedAt,
      logErrors: false,
    });
    if (fallbackFromTranscript.text) {
      const delivered = await safeDeliverReply(fallbackFromTranscript.text, "catch-transcript-fallback");
      if (delivered && fallbackFromTranscript.transcriptMessageId) {
        markTranscriptReplyDelivered(runtimeSessionId, fallbackFromTranscript.transcriptMessageId);
      }
      return true;
    }
  } catch {
    // ignore transcript fallback errors in catch block
  }

  await safeDeliverReply(
    `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
    "catch-timeout-fallback",
  );
  return false;
}
