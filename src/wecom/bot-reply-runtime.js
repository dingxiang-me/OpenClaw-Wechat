function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotLateReplyRuntime: ${name} is required`);
  }
}

export function createWecomBotDispatchState() {
  return {
    blockText: "",
    streamFinished: false,
  };
}

export function resolveWecomBotReplyRuntimePolicy({
  botModeConfig = {},
  minReplyTimeoutMs = 15000,
  defaultReplyTimeoutMs = 90000,
  defaultLateReplyWatchMs = 180000,
  defaultLateReplyPollMs = 2000,
} = {}) {
  return {
    replyTimeoutMs: Math.max(
      Math.max(1, Number(minReplyTimeoutMs) || 1),
      Number(botModeConfig?.replyTimeoutMs) || defaultReplyTimeoutMs,
    ),
    lateReplyWatchMs: Math.max(
      30000,
      Number(botModeConfig?.lateReplyWatchMs) || defaultLateReplyWatchMs,
    ),
    lateReplyPollMs: Math.max(
      500,
      Number(botModeConfig?.lateReplyPollMs) || defaultLateReplyPollMs,
    ),
  };
}

export function createWecomBotLateReplyRuntime({
  logger,
  sessionId,
  sessionRuntimeId = "",
  msgId = "",
  storePath,
  dispatchState,
  dispatchStartedAt = Date.now(),
  lateReplyWatchMs,
  lateReplyPollMs,
  readTranscriptFallback,
  markTranscriptReplyDelivered,
  safeDeliverReply,
  runLateReplyWatcher,
  activeWatchers,
  now = () => Date.now(),
  randomToken = () => Math.random().toString(36).slice(2, 8),
} = {}) {
  if (!dispatchState || typeof dispatchState !== "object") {
    throw new Error("createWecomBotLateReplyRuntime: dispatchState is required");
  }
  assertFunction("readTranscriptFallback", readTranscriptFallback);
  assertFunction("markTranscriptReplyDelivered", markTranscriptReplyDelivered);
  assertFunction("safeDeliverReply", safeDeliverReply);
  assertFunction("runLateReplyWatcher", runLateReplyWatcher);
  assertFunction("now", now);
  assertFunction("randomToken", randomToken);

  let lateReplyWatcherPromise = null;

  const readTranscriptFallbackResult = async ({
    runtimeStorePath = storePath,
    runtimeSessionId = sessionId,
    runtimeTranscriptSessionId = sessionRuntimeId || sessionId,
    minTimestamp = dispatchStartedAt,
    logErrors = true,
  } = {}) =>
    readTranscriptFallback({
      storePath: runtimeStorePath,
      sessionId: runtimeSessionId,
      transcriptSessionId: runtimeTranscriptSessionId,
      minTimestamp,
      logger,
      logErrors,
    });

  const tryFinishFromTranscript = async (minTimestamp = dispatchStartedAt) => {
    const fallback = await readTranscriptFallbackResult({
      runtimeStorePath: storePath,
      runtimeSessionId: sessionId,
      runtimeTranscriptSessionId: sessionRuntimeId || sessionId,
      minTimestamp,
    });
    if (!fallback.text) return false;
    dispatchState.streamFinished = await safeDeliverReply(fallback.text, "transcript-fallback");
    if (dispatchState.streamFinished && fallback.transcriptMessageId) {
      markTranscriptReplyDelivered(sessionId, fallback.transcriptMessageId);
      logger?.info?.(
        `wecom(bot): filled reply from transcript session=${sessionId} messageId=${fallback.transcriptMessageId}`,
      );
    }
    return dispatchState.streamFinished;
  };

  const startLateReplyWatcher = (reason = "dispatch-timeout", minTimestamp = dispatchStartedAt) => {
    if (dispatchState.streamFinished || lateReplyWatcherPromise) return false;
    const watchStartedAt = Math.max(now(), Number(minTimestamp) || 0);
    const watchId = `wecom-bot:${sessionId}:${msgId || watchStartedAt}:${randomToken()}`;
    lateReplyWatcherPromise = runLateReplyWatcher({
      watchId,
      reason,
      sessionId,
      sessionTranscriptId: sessionRuntimeId || sessionId,
      accountId: "bot",
      storePath,
      logger,
      watchStartedAt,
      watchMs: lateReplyWatchMs,
      pollMs: lateReplyPollMs,
      activeWatchers,
      isDelivered: () => dispatchState.streamFinished,
      markDelivered: () => {
        dispatchState.streamFinished = true;
      },
      sendText: async (text) => {
        const delivered = await safeDeliverReply(text, "late-transcript-fallback");
        if (!delivered) {
          throw new Error("late transcript delivery failed");
        }
      },
      onFailureFallback: async (watchErr) => {
        if (dispatchState.streamFinished) return;
        const reasonText = String(watchErr?.message || watchErr || "");
        const isTimeout = reasonText.includes("timed out");
        await safeDeliverReply(
          isTimeout
            ? "抱歉，当前模型请求超时或网络不稳定，请稍后重试。"
            : `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${reasonText.slice(0, 160)}`,
          isTimeout ? "late-timeout-fallback" : "late-watcher-error",
        );
      },
    }).finally(() => {
      lateReplyWatcherPromise = null;
    });
    return true;
  };

  return {
    readTranscriptFallbackResult,
    tryFinishFromTranscript,
    startLateReplyWatcher,
  };
}
