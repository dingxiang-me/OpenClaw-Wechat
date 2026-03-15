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
  flowState,
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
  pushWecomBotLongConnectionStreamUpdate,
  markdownToWecomText,
  isAgentFailureText,
  safeDeliverReply,
  resolveWecomReasoningPolicy,
  markTranscriptReplyDelivered,
  ACTIVE_LATE_REPLY_WATCHERS,
  ensureTranscriptFallbackReader,
  ensureLateReplyWatcherRunner,
  withTimeout,
  clearSessionStoreEntry,
} = {}) {
  assertFunction("ensureTranscriptFallbackReader", ensureTranscriptFallbackReader);
  assertFunction("ensureLateReplyWatcherRunner", ensureLateReplyWatcherRunner);
  assertFunction("withTimeout", withTimeout);

  let startLateReplyWatcher = () => false;
  let readTranscriptFallbackResult = async () => ({ text: "", transcriptMessageId: "" });

  const dispatchState = createWecomBotDispatchState();
  if (flowState && typeof flowState === "object") {
    flowState.dispatchState = dispatchState;
  }
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
    clearSessionStoreEntry,
  });
  readTranscriptFallbackResult = lateReplyRuntime.readTranscriptFallbackResult;
  const tryFinishFromTranscript = lateReplyRuntime.tryFinishFromTranscript;
  startLateReplyWatcher = lateReplyRuntime.startLateReplyWatcher;

  const dispatchHandlers = createWecomBotDispatchHandlers({
    api,
    streamId,
    sessionId,
    state: dispatchState,
    accountId,
    hasBotStream,
    normalizeWecomBotOutboundMediaUrls,
    queueBotStreamMedia,
    updateBotStream,
    pushWecomBotLongConnectionStreamUpdate,
    markdownToWecomText,
    isAgentFailureText,
    safeDeliverReply,
    reasoningPolicy: resolveWecomReasoningPolicy?.(api) ?? {},
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
    reasoningPolicy: resolveWecomReasoningPolicy?.(api) ?? {},
  });

  return {
    shouldReturnAfterFallback,
    startLateReplyWatcher,
    readTranscriptFallbackResult,
  };
}
