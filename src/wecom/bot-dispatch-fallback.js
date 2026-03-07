import { parseThinkingContent } from "./thinking-parser.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`bot-dispatch-fallback: ${name} is required`);
  }
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

  const parsed = parseThinkingContent(dispatchState.blockText);
  const fallback = markdownToWecomText(parsed.visibleContent).trim();
  const thinkingContent = markdownToWecomText(parsed.thinkingContent).trim();
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
  readTranscriptFallbackResult,
  safeDeliverReply,
  markTranscriptReplyDelivered,
} = {}) {
  assertFunction("isDispatchTimeoutError", isDispatchTimeoutError);
  assertFunction("startLateReplyWatcher", startLateReplyWatcher);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("readTranscriptFallbackResult", readTranscriptFallbackResult);
  assertFunction("safeDeliverReply", safeDeliverReply);
  assertFunction("markTranscriptReplyDelivered", markTranscriptReplyDelivered);

  api?.logger?.warn?.(`wecom(bot): processing failed: ${String(err?.message || err)}`);
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
