function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentLateReplyRuntime: ${name} is required`);
  }
}

function isTimeoutLikeReason(reason) {
  return String(reason?.message || reason || "")
    .trim()
    .toLowerCase()
    .includes("timed out");
}

export function createWecomAgentLateReplyRuntime({
  dispatchState,
  api,
  fromUser,
  sessionId,
  msgId = "",
  transcriptSessionId = "",
  accountId = "default",
  storePath,
  lateReplyWatchMs,
  lateReplyPollMs,
  sendTextToUser,
  deliverAgentReply = null,
  ensureLateReplyWatcherRunner,
  activeWatchers,
  clearSessionStoreEntry = null,
  now = () => Date.now(),
  randomToken = () => Math.random().toString(36).slice(2, 8),
  logger,
} = {}) {
  if (!dispatchState || typeof dispatchState !== "object") {
    throw new Error("createWecomAgentLateReplyRuntime: dispatchState is required");
  }
  assertFunction("sendTextToUser", sendTextToUser);
  assertFunction("ensureLateReplyWatcherRunner", ensureLateReplyWatcherRunner);
  assertFunction("now", now);
  assertFunction("randomToken", randomToken);

  let lateReplyWatcherPromise = null;

  const autoResetTimedOutSession = async (reason) => {
    if (typeof clearSessionStoreEntry !== "function" || !isTimeoutLikeReason(reason)) return false;
    try {
      const result = await clearSessionStoreEntry({
        storePath,
        sessionKey: sessionId,
        logger,
      });
      logger?.info?.(
        `wecom: auto-reset timed out session=${sessionId} cleared=${result?.cleared === true ? "yes" : "no"}`,
      );
      return result?.cleared === true;
    } catch (err) {
      logger?.warn?.(`wecom: failed to auto-reset timed out session=${sessionId}: ${String(err?.message || err)}`);
      return false;
    }
  };

  const sendProgressNotice = async (text = "") => {
    const noticeText = String(text ?? "").trim();
    if (!noticeText) return false;
    if (dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply || dispatchState.hasSentProgressNotice) {
      return false;
    }
    dispatchState.hasSentProgressNotice = true;
    await sendTextToUser(noticeText);
    return true;
  };

  const sendFailureFallback = async (reason) => {
    if (dispatchState.hasDeliveredReply) return false;
    dispatchState.hasDeliveredReply = true;
    const reasonText = String(reason ?? "unknown").slice(0, 160);
    try {
      const fallbackText = `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${reasonText}`;
      if (typeof deliverAgentReply === "function") {
        await deliverAgentReply({
          api,
          fromUser,
          accountId,
          sessionId,
          text: fallbackText,
          reason: "late-timeout-fallback",
        });
      } else {
        await sendTextToUser(fallbackText);
      }
    } finally {
      await autoResetTimedOutSession(reasonText);
    }
    return true;
  };

  const startLateReplyWatcher = (reason = "pending-final") => {
    if (dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply || lateReplyWatcherPromise) return false;

    const watchStartedAt = now();
    const watchId = `${sessionId}:${msgId || watchStartedAt}:${randomToken()}`;
    lateReplyWatcherPromise = ensureLateReplyWatcherRunner()({
      watchId,
      reason,
      sessionId,
      sessionTranscriptId: transcriptSessionId || sessionId,
      accountId,
      storePath,
      logger,
      watchStartedAt,
      watchMs: lateReplyWatchMs,
      pollMs: lateReplyPollMs,
      activeWatchers,
      isDelivered: () => dispatchState.hasDeliveredReply,
      markDelivered: () => {
        dispatchState.hasDeliveredReply = true;
      },
      sendText: async (text) => {
        if (typeof deliverAgentReply === "function") {
          await deliverAgentReply({
            api,
            fromUser,
            accountId,
            sessionId,
            text,
            reason: "late-reply",
          });
          return;
        }
        await sendTextToUser(text);
      },
      onFailureFallback: async (err) => sendFailureFallback(err),
    }).finally(() => {
      lateReplyWatcherPromise = null;
    });
    return true;
  };

  return {
    sendProgressNotice,
    sendFailureFallback,
    startLateReplyWatcher,
  };
}
