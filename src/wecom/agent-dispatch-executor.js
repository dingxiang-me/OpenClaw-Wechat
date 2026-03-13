import { createWecomAgentDispatchHandlers } from "./agent-dispatch-handlers.js";
import {
  finalizeWecomAgentVisiblePartialReply,
  handleWecomAgentPostDispatchFallback,
} from "./agent-dispatch-fallback.js";
import { createWecomAgentLateReplyRuntime } from "./agent-late-reply-runtime.js";
import { createWecomAgentDispatchState, resolveWecomAgentReplyRuntimePolicy } from "./agent-reply-runtime.js";
import { createWecomAgentStreamingChunkManager } from "./agent-streaming-chunks.js";
import { buildWorkspaceAutoSendHints, computeStreamingTailText } from "./agent-reply-format.js";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`executeWecomAgentDispatchFlow: ${name} is required`);
  }
}

export async function executeWecomAgentDispatchFlow({
  api,
  runtime,
  cfg,
  ctxPayload,
  sessionId,
  routedAgentId = "",
  runtimeAccountId = "default",
  msgId = "",
  storePath,
  fromUser,
  corpId,
  corpSecret,
  agentId,
  proxyUrl = "",
  apiProxy = "",
  tempPathsToCleanup = [],
  resolveWecomReplyStreamingPolicy,
  asNumber,
  requireEnv,
  getByteLength,
  markdownToWecomText,
  autoSendWorkspaceFilesFromReplyText,
  sendWecomOutboundMediaBatch,
  withTimeout,
  isDispatchTimeoutError,
  isAgentFailureText,
  scheduleTempFileCleanup,
  ensureLateReplyWatcherRunner,
  ACTIVE_LATE_REPLY_WATCHERS,
  sendTextToUser,
  clearSessionStoreEntry,
} = {}) {
  assertFunction("resolveWecomReplyStreamingPolicy", resolveWecomReplyStreamingPolicy);
  assertFunction("asNumber", asNumber);
  assertFunction("requireEnv", requireEnv);
  assertFunction("getByteLength", getByteLength);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("autoSendWorkspaceFilesFromReplyText", autoSendWorkspaceFilesFromReplyText);
  assertFunction("sendWecomOutboundMediaBatch", sendWecomOutboundMediaBatch);
  assertFunction("withTimeout", withTimeout);
  assertFunction("isDispatchTimeoutError", isDispatchTimeoutError);
  assertFunction("isAgentFailureText", isAgentFailureText);
  assertFunction("scheduleTempFileCleanup", scheduleTempFileCleanup);
  assertFunction("ensureLateReplyWatcherRunner", ensureLateReplyWatcherRunner);
  assertFunction("sendTextToUser", sendTextToUser);

  const dispatchState = createWecomAgentDispatchState();
  let progressNoticeTimer = null;
  const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
  const streamingEnabled = streamingPolicy.enabled === true;
  const { replyTimeoutMs, progressNoticeDelayMs, lateReplyWatchMs, lateReplyPollMs } =
    resolveWecomAgentReplyRuntimePolicy({
      cfg,
      asNumber,
      requireEnv,
    });
  // 自建应用模式默认不发送“处理中”提示，避免打扰用户。
  const processingNoticeText = "";
  const queuedNoticeText = "";
  const { flushStreamingBuffer } = createWecomAgentStreamingChunkManager({
    state: dispatchState,
    streamingEnabled,
    streamingPolicy,
    markdownToWecomText,
    getByteLength,
    sendTextToUser,
    logger: api?.logger,
  });
  const lateReplyRuntime = createWecomAgentLateReplyRuntime({
    dispatchState,
    sessionId,
    msgId,
    transcriptSessionId: ctxPayload?.SessionId || sessionId,
    accountId: runtimeAccountId,
    storePath,
    lateReplyWatchMs,
    lateReplyPollMs,
    sendTextToUser,
    ensureLateReplyWatcherRunner,
    activeWatchers: ACTIVE_LATE_REPLY_WATCHERS,
    clearSessionStoreEntry,
    logger: api?.logger,
  });
  const sendProgressNotice = lateReplyRuntime.sendProgressNotice;
  const sendFailureFallback = lateReplyRuntime.sendFailureFallback;
  const startLateReplyWatcher = lateReplyRuntime.startLateReplyWatcher;

  try {
    if (progressNoticeDelayMs > 0) {
      progressNoticeTimer = setTimeout(() => {
        sendProgressNotice().catch((noticeErr) => {
          api?.logger?.warn?.(`wecom: failed to send progress notice: ${String(noticeErr)}`);
        });
      }, progressNoticeDelayMs);
    }

    api?.logger?.info?.(`wecom: waiting for agent reply (timeout=${replyTimeoutMs}ms)`);
    const dispatchHandlers = createWecomAgentDispatchHandlers({
      api,
      state: dispatchState,
      streamingEnabled,
      fromUser,
      routedAgentId,
      corpId,
      corpSecret,
      agentId,
      proxyUrl,
      apiProxy,
      flushStreamingBuffer,
      sendFailureFallback,
      sendTextToUser,
      markdownToWecomText,
      isAgentFailureText,
      computeStreamingTailText,
      autoSendWorkspaceFilesFromReplyText,
      buildWorkspaceAutoSendHints,
      sendWecomOutboundMediaBatch,
    });
    const dispatchResult = await withTimeout(
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: dispatchHandlers.deliver,
          onError: dispatchHandlers.onError,
        },
        replyOptions: {
          // 企业微信不支持编辑消息；开启流式时会以“多条文本消息”模拟增量输出。
          disableBlockStreaming: !streamingEnabled,
          routeOverrides:
            routedAgentId && sessionId
              ? {
                  sessionKey: sessionId,
                  agentId: routedAgentId,
                  accountId: runtimeAccountId,
                }
              : undefined,
        },
      }),
      replyTimeoutMs,
      `dispatch timed out after ${replyTimeoutMs}ms`,
    );

    await handleWecomAgentPostDispatchFallback({
      api,
      state: dispatchState,
      streamingEnabled,
      flushStreamingBuffer,
      sendTextToUser,
      markdownToWecomText,
      sendProgressNotice,
      startLateReplyWatcher,
      processingNoticeText,
      queuedNoticeText,
      dispatchResult,
    });
  } catch (dispatchErr) {
    api?.logger?.warn?.(`wecom: dispatch failed: ${String(dispatchErr)}`);
    if (isDispatchTimeoutError(dispatchErr)) {
      dispatchState.suppressLateDispatcherDeliveries = true;
      const finalizedVisiblePartial = await finalizeWecomAgentVisiblePartialReply({
        api,
        state: dispatchState,
        flushStreamingBuffer,
        reason: "dispatch-timeout",
      });
      if (finalizedVisiblePartial) return;
      await sendProgressNotice(queuedNoticeText);
      await startLateReplyWatcher("dispatch-timeout");
    } else {
      await sendFailureFallback(dispatchErr);
    }
  } finally {
    if (progressNoticeTimer) clearTimeout(progressNoticeTimer);
    for (const filePath of tempPathsToCleanup) {
      scheduleTempFileCleanup(filePath, api?.logger);
    }
  }
}
