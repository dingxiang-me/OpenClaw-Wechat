import { handleWecomBotPostDispatchFallback } from "./bot-dispatch-fallback.js";
import { createWecomBotDispatchHandlers } from "./bot-dispatch-handlers.js";
import {
  createWecomBotDispatchState,
  createWecomBotLateReplyRuntime,
  resolveWecomBotReplyRuntimePolicy,
} from "./bot-reply-runtime.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`executeWecomBotDispatchRuntime: ${name} is required`);
  }
}

export async function executeWecomBotDispatchRuntime({
  api,
  runtime,
  cfg,
  ctxPayload,
  streamId,
  accountId = "default",
  sessionId,
  routedAgentId,
  storePath,
  sessionRuntimeId,
  msgId,
  dispatchStartedAt,
  botModeConfig,
  hasBotStream,
  normalizeWecomBotOutboundMediaUrls,
  queueBotStreamMedia,
  updateBotStream,
  markdownToWecomText,
  isAgentFailureText,
  safeDeliverReply,
  markTranscriptReplyDelivered,
  ACTIVE_LATE_REPLY_WATCHERS,
  ensureTranscriptFallbackReader,
  ensureLateReplyWatcherRunner,
  withTimeout,
} = {}) {
  assertFunction("ensureTranscriptFallbackReader", ensureTranscriptFallbackReader);
  assertFunction("ensureLateReplyWatcherRunner", ensureLateReplyWatcherRunner);
  assertFunction("withTimeout", withTimeout);

  let startLateReplyWatcher = () => false;
  let readTranscriptFallbackResult = async () => ({ text: "", transcriptMessageId: "" });

  const dispatchState = createWecomBotDispatchState();
  const replyRuntimePolicy = resolveWecomBotReplyRuntimePolicy({ botModeConfig });
  const readTranscriptFallback = ensureTranscriptFallbackReader();
  assertFunction("readTranscriptFallback", readTranscriptFallback);
  const runLateReplyWatcher = ensureLateReplyWatcherRunner();
  assertFunction("runLateReplyWatcher", runLateReplyWatcher);

  const lateReplyRuntime = createWecomBotLateReplyRuntime({
    logger: api.logger,
    sessionId,
    sessionRuntimeId,
    msgId,
    storePath,
    dispatchState,
    dispatchStartedAt,
    lateReplyWatchMs: replyRuntimePolicy.lateReplyWatchMs,
    lateReplyPollMs: replyRuntimePolicy.lateReplyPollMs,
    readTranscriptFallback,
    markTranscriptReplyDelivered,
    safeDeliverReply,
    runLateReplyWatcher,
    activeWatchers: ACTIVE_LATE_REPLY_WATCHERS,
  });
  readTranscriptFallbackResult = lateReplyRuntime.readTranscriptFallbackResult;
  const tryFinishFromTranscript = lateReplyRuntime.tryFinishFromTranscript;
  startLateReplyWatcher = lateReplyRuntime.startLateReplyWatcher;

  const dispatchHandlers = createWecomBotDispatchHandlers({
    api,
    streamId,
    state: dispatchState,
    hasBotStream,
    normalizeWecomBotOutboundMediaUrls,
    queueBotStreamMedia,
    updateBotStream,
    markdownToWecomText,
    isAgentFailureText,
    safeDeliverReply,
  });

  await withTimeout(
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      replyOptions: {
        disableBlockStreaming: false,
        routeOverrides:
          routedAgentId && sessionId
            ? {
                sessionKey: sessionId,
                agentId: routedAgentId,
                accountId,
              }
            : undefined,
      },
      dispatcherOptions: {
        deliver: dispatchHandlers.deliver,
        onError: dispatchHandlers.onError,
      },
    }),
    replyRuntimePolicy.replyTimeoutMs,
    `dispatch timed out after ${replyRuntimePolicy.replyTimeoutMs}ms`,
  );

  const shouldReturnAfterFallback = await handleWecomBotPostDispatchFallback({
    api,
    sessionId,
    dispatchState,
    dispatchStartedAt,
    tryFinishFromTranscript,
    markdownToWecomText,
    safeDeliverReply,
    startLateReplyWatcher,
  });

  return {
    shouldReturnAfterFallback,
    startLateReplyWatcher,
    readTranscriptFallbackResult,
  };
}
