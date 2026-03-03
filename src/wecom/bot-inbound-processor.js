import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { buildWecomBotInboundContextPayload, buildWecomBotInboundEnvelopePayload } from "./bot-context.js";
import { createWecomBotDispatchHandlers } from "./bot-dispatch-handlers.js";
import { applyWecomBotCommandAndSenderGuard, applyWecomBotGroupChatGuard } from "./bot-inbound-guards.js";
import {
  createWecomBotDispatchState,
  createWecomBotLateReplyRuntime,
  resolveWecomBotReplyRuntimePolicy,
} from "./bot-reply-runtime.js";
import { prepareWecomBotRuntimeContext } from "./bot-runtime-context.js";
import { createWecomBotTranscriptFallbackReader } from "./bot-transcript-fallback.js";

export function createWecomBotInboundProcessor(deps = {}) {
  const {
    buildWecomBotSessionId,
    resolveWecomBotConfig,
    resolveWecomBotProxyConfig,
    normalizeWecomBotOutboundMediaUrls,
    resolveWecomGroupChatPolicy,
    resolveWecomDynamicAgentPolicy,
    hasBotStream,
    finishBotStream,
    deliverBotReplyText,
    shouldTriggerWecomGroupResponse,
    shouldStripWecomGroupMentions,
    stripWecomGroupMentions,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    isWecomSenderAllowed,
    extractLeadingSlashCommand,
    buildWecomBotHelpText,
    buildWecomBotStatusText,
    buildBotInboundContent,
    resolveWecomAgentRoute,
    seedDynamicAgentWorkspace,
    resolveSessionTranscriptFilePath,
    readTranscriptAppendedChunk,
    parseLateAssistantReplyFromTranscriptLine,
    hasTranscriptReplyBeenDelivered,
    markTranscriptReplyDelivered,
    markdownToWecomText,
    sleep,
    withTimeout,
    isDispatchTimeoutError,
    queueBotStreamMedia,
    updateBotStream,
    isAgentFailureText,
    scheduleTempFileCleanup,
    ACTIVE_LATE_REPLY_WATCHERS,
  } = deps;

  let lateReplyWatcherRunner = null;
  let transcriptFallbackReader = null;
  function ensureLateReplyWatcherRunner() {
    if (lateReplyWatcherRunner) return lateReplyWatcherRunner;
    lateReplyWatcherRunner = createWecomLateReplyWatcher({
      resolveSessionTranscriptFilePath,
      readTranscriptAppendedChunk,
      parseLateAssistantReplyFromTranscriptLine,
      hasTranscriptReplyBeenDelivered,
      markTranscriptReplyDelivered,
      sleep,
      markdownToWecomText,
    });
    return lateReplyWatcherRunner;
  }
  function ensureTranscriptFallbackReader() {
    if (transcriptFallbackReader) return transcriptFallbackReader;
    transcriptFallbackReader = createWecomBotTranscriptFallbackReader({
      resolveSessionTranscriptFilePath,
      readTranscriptAppendedChunk,
      parseLateAssistantReplyFromTranscriptLine,
      hasTranscriptReplyBeenDelivered,
      markdownToWecomText,
    });
    return transcriptFallbackReader;
  }

async function processBotInboundMessage({
  api,
  streamId,
  fromUser,
  content,
  msgType = "text",
  msgId,
  chatId,
  isGroupChat = false,
  imageUrls = [],
  fileUrl = "",
  fileName = "",
  quote = null,
  responseUrl = "",
}) {
  const runtime = api.runtime;
  const cfg = api.config;
  const baseSessionId = buildWecomBotSessionId(fromUser);
  let sessionId = baseSessionId;
  let routedAgentId = "";
  const fromAddress = `wecom-bot:${fromUser}`;
  const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
  const originalContent = String(content ?? "");
  let commandBody = originalContent;
  const dispatchStartedAt = Date.now();
  const tempPathsToCleanup = [];
  const botModeConfig = resolveWecomBotConfig(api);
  const botProxyUrl = resolveWecomBotProxyConfig(api);
  const normalizedFileUrl = String(fileUrl ?? "").trim();
  const normalizedFileName = String(fileName ?? "").trim();
  const normalizedQuote =
    quote && typeof quote === "object"
      ? {
          msgType: String(quote.msgType ?? "").trim().toLowerCase(),
          content: String(quote.content ?? "").trim(),
        }
      : null;
  const normalizedImageUrls = Array.from(
    new Set(
      (Array.isArray(imageUrls) ? imageUrls : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
  const groupChatPolicy = resolveWecomGroupChatPolicy(api);
  const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
  let isAdminUser = false;

  const safeFinishStream = (text) => {
    if (!hasBotStream(streamId)) return;
    finishBotStream(streamId, String(text ?? ""));
  };
  const safeDeliverReply = async (reply, reason = "reply") => {
    const normalizedReply =
      typeof reply === "string"
        ? { text: reply }
        : reply && typeof reply === "object"
          ? reply
          : { text: "" };
    const contentText = String(normalizedReply.text ?? "").trim();
    const replyMediaUrls = normalizeWecomBotOutboundMediaUrls(normalizedReply);
    if (!contentText && replyMediaUrls.length === 0) return false;
    const result = await deliverBotReplyText({
      api,
      fromUser,
      sessionId,
      streamId,
      responseUrl,
      text: contentText,
      mediaUrls: replyMediaUrls,
      mediaType: String(normalizedReply.mediaType ?? "").trim().toLowerCase() || undefined,
      reason,
    });
    if (!result?.ok && hasBotStream(streamId)) {
      finishBotStream(streamId, contentText || "已收到模型返回的媒体结果，请稍后刷新。");
    }
    return result?.ok === true;
  };
  let startLateReplyWatcher = () => false;
  let readTranscriptFallbackResult = async () => ({ text: "", transcriptMessageId: "" });

  try {
    const groupGuardResult = applyWecomBotGroupChatGuard({
      isGroupChat,
      msgType,
      commandBody,
      groupChatPolicy,
      shouldTriggerWecomGroupResponse,
      shouldStripWecomGroupMentions,
      stripWecomGroupMentions,
    });
    if (!groupGuardResult.ok) {
      safeFinishStream(groupGuardResult.finishText);
      return;
    }
    commandBody = groupGuardResult.commandBody;

    const commandGuardResult = applyWecomBotCommandAndSenderGuard({
      api,
      fromUser,
      msgType,
      commandBody,
      normalizedFromUser,
      resolveWecomCommandPolicy,
      resolveWecomAllowFromPolicy,
      isWecomSenderAllowed,
      extractLeadingSlashCommand,
      buildWecomBotHelpText,
      buildWecomBotStatusText,
    });
    isAdminUser = commandGuardResult.isAdminUser === true;
    commandBody = commandGuardResult.commandBody;
    if (!commandGuardResult.ok) {
      safeFinishStream(commandGuardResult.finishText);
      return;
    }

    const inboundContentResult = await buildBotInboundContent({
      api,
      botModeConfig,
      botProxyUrl,
      msgType,
      commandBody,
      normalizedImageUrls,
      normalizedFileUrl,
      normalizedFileName,
      normalizedQuote,
    });
    if (Array.isArray(inboundContentResult.tempPathsToCleanup)) {
      tempPathsToCleanup.push(...inboundContentResult.tempPathsToCleanup);
    }
    if (inboundContentResult.aborted) {
      safeFinishStream(inboundContentResult.abortText || "消息处理失败，请稍后重试。");
      return;
    }
    const messageText = String(inboundContentResult.messageText ?? "").trim();

    if (!messageText) {
      safeFinishStream("消息内容为空，请发送有效文本。");
      return;
    }

    const runtimeContext = await prepareWecomBotRuntimeContext({
      api,
      runtime,
      cfg,
      baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      msgId,
      messageText,
      commandBody,
      originalContent,
      fromAddress,
      groupChatPolicy,
      dynamicAgentPolicy,
      isAdminUser,
      resolveWecomAgentRoute,
      seedDynamicAgentWorkspace,
      buildWecomBotInboundEnvelopePayload,
      buildWecomBotInboundContextPayload,
    });
    routedAgentId = runtimeContext.routedAgentId;
    sessionId = runtimeContext.sessionId;
    const storePath = runtimeContext.storePath;
    const ctxPayload = runtimeContext.ctxPayload;
    const sessionRuntimeId = runtimeContext.sessionRuntimeId;

    const dispatchState = createWecomBotDispatchState();
    const replyRuntimePolicy = resolveWecomBotReplyRuntimePolicy({ botModeConfig });
    const replyTimeoutMs = replyRuntimePolicy.replyTimeoutMs;
    const lateReplyWatchMs = replyRuntimePolicy.lateReplyWatchMs;
    const lateReplyPollMs = replyRuntimePolicy.lateReplyPollMs;
    const readTranscriptFallback = ensureTranscriptFallbackReader();
    const lateReplyRuntime = createWecomBotLateReplyRuntime({
      logger: api.logger,
      sessionId,
      sessionRuntimeId,
      msgId,
      storePath,
      dispatchState,
      dispatchStartedAt,
      lateReplyWatchMs,
      lateReplyPollMs,
      readTranscriptFallback,
      markTranscriptReplyDelivered,
      safeDeliverReply,
      runLateReplyWatcher: ensureLateReplyWatcherRunner(),
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
                  accountId: "bot",
                }
              : undefined,
        },
        dispatcherOptions: {
          deliver: dispatchHandlers.deliver,
          onError: dispatchHandlers.onError,
        },
      }),
      replyTimeoutMs,
      `dispatch timed out after ${replyTimeoutMs}ms`,
    );

    if (!dispatchState.streamFinished) {
      const filledFromTranscript = await tryFinishFromTranscript(dispatchStartedAt);
      if (filledFromTranscript) return;
      const fallback = markdownToWecomText(dispatchState.blockText).trim();
      if (fallback) {
        await safeDeliverReply(fallback, "block-fallback");
      } else {
        const watcherStarted = startLateReplyWatcher("dispatch-finished-without-final", dispatchStartedAt);
        if (watcherStarted) return;
        api.logger.warn?.(
          `wecom(bot): dispatch finished without deliverable content; late watcher unavailable, fallback to timeout text session=${sessionId}`,
        );
        await safeDeliverReply("抱歉，当前模型请求超时或网络不稳定，请稍后重试。", "timeout-fallback");
      }
    }
  } catch (err) {
    api.logger.warn?.(`wecom(bot): processing failed: ${String(err?.message || err)}`);
    if (isDispatchTimeoutError(err)) {
      const watcherStarted = (() => {
        try {
          return startLateReplyWatcher("dispatch-timeout", dispatchStartedAt);
        } catch {
          return false;
        }
      })();
      if (watcherStarted) return;
    }
    try {
      const runtimeSessionId = sessionId || buildWecomBotSessionId(fromUser);
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
        return;
      }
    } catch {
      // ignore transcript fallback errors in catch block
    }
    await safeDeliverReply(
      `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
      "catch-timeout-fallback",
    );
  } finally {
    for (const filePath of tempPathsToCleanup) {
      scheduleTempFileCleanup(filePath, api.logger);
    }
  }
}


  return processBotInboundMessage;
}
