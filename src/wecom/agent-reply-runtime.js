function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`resolveWecomAgentReplyRuntimePolicy: ${name} is required`);
  }
}

export function createWecomAgentDispatchState() {
  return {
    hasDeliveredReply: false,
    hasDeliveredPartialReply: false,
    hasSentProgressNotice: false,
    blockTextFallback: "",
    streamChunkBuffer: "",
    streamChunkLastSentAt: 0,
    streamChunkSentCount: 0,
    streamChunkSendChain: Promise.resolve(),
    suppressLateDispatcherDeliveries: false,
  };
}

export function resolveWecomAgentReplyRuntimePolicy({
  cfg,
  asNumber,
  requireEnv,
  minReplyTimeoutMs = 15000,
  defaultReplyTimeoutMs = 90000,
  defaultLateReplyWatchMs = 180000,
  defaultLateReplyPollMs = 2000,
} = {}) {
  assertFunction("asNumber", asNumber);
  assertFunction("requireEnv", requireEnv);
  const replyTimeoutMs = Math.max(
    Math.max(1, Number(minReplyTimeoutMs) || 1),
    asNumber(cfg?.env?.vars?.WECOM_REPLY_TIMEOUT_MS ?? requireEnv("WECOM_REPLY_TIMEOUT_MS"), defaultReplyTimeoutMs),
  );
  const progressNoticeDelayMs = Math.max(
    0,
    asNumber(cfg?.env?.vars?.WECOM_PROGRESS_NOTICE_MS ?? requireEnv("WECOM_PROGRESS_NOTICE_MS"), 0),
  );
  const lateReplyWatchMs = Math.max(
    30000,
    Math.min(
      10 * 60 * 1000,
      asNumber(
        cfg?.env?.vars?.WECOM_LATE_REPLY_WATCH_MS ?? requireEnv("WECOM_LATE_REPLY_WATCH_MS"),
        Math.max(replyTimeoutMs, defaultLateReplyWatchMs),
      ),
    ),
  );
  const lateReplyPollMs = Math.max(
    500,
    Math.min(
      10000,
      asNumber(
        cfg?.env?.vars?.WECOM_LATE_REPLY_POLL_MS ?? requireEnv("WECOM_LATE_REPLY_POLL_MS"),
        defaultLateReplyPollMs,
      ),
    ),
  );
  return {
    replyTimeoutMs,
    progressNoticeDelayMs,
    lateReplyWatchMs,
    lateReplyPollMs,
  };
}
