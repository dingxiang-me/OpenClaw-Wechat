import { buildWecomBotInboundContextPayload, buildWecomBotInboundEnvelopePayload } from "./bot-context.js";
import { handleWecomBotDispatchError } from "./bot-dispatch-fallback.js";
import {
  assertWecomBotInboundFlowDeps,
  createWecomBotInboundFlowState,
  createWecomBotSafeReplyHelpers,
} from "./bot-inbound-executor-helpers.js";
import { executeWecomBotDispatchRuntime } from "./bot-inbound-dispatch-runtime.js";
import { applyWecomBotCommandAndSenderGuard, applyWecomBotGroupChatGuard } from "./bot-inbound-guards.js";
import { prepareWecomBotRuntimeContext } from "./bot-runtime-context.js";

export async function executeWecomBotInboundFlow(payload = {}) {
  const {
    api,
    streamId,
    accountId = "default",
    fromUser,
    content,
    msgType = "text",
    msgId,
    chatId,
    isGroupChat = false,
    imageUrls = [],
    imageEntries = [],
    fileUrl = "",
    fileName = "",
    fileAesKey = "",
    voiceUrl = "",
    voiceMediaId = "",
    voiceContentType = "",
    quote = null,
    responseUrl = "",
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
    resolveWecomDmPolicy,
    resolveWecomReasoningPolicy,
    isWecomSenderAllowed,
    extractLeadingSlashCommand,
    buildWecomBotHelpText,
    buildWecomBotStatusText,
    buildBotInboundContent,
    resolveWecomAgentRoute,
    seedDynamicAgentWorkspace,
    markTranscriptReplyDelivered,
    markdownToWecomText,
    withTimeout,
    isDispatchTimeoutError,
    queueBotStreamMedia,
    updateBotStream,
    pushWecomBotLongConnectionStreamUpdate,
    isAgentFailureText,
    scheduleTempFileCleanup,
    ACTIVE_LATE_REPLY_WATCHERS,
    ensureLateReplyWatcherRunner,
    ensureTranscriptFallbackReader,
    resetWecomConversationSession,
    clearSessionStoreEntry,
    markWecomReliableInboundActivity = () => null,
    flushWecomSessionPendingReplies = async () => {},
  } = payload;

  assertWecomBotInboundFlowDeps({
    ...payload,
    api,
  });

  const state = createWecomBotInboundFlowState({
    api,
    accountId,
    fromUser,
    chatId,
    content,
    imageEntries,
    imageUrls,
    fileUrl,
    fileName,
    fileAesKey,
    voiceUrl,
    voiceMediaId,
    voiceContentType,
    quote,
    buildWecomBotSessionId,
    resolveWecomBotConfig,
    resolveWecomBotProxyConfig,
    resolveWecomGroupChatPolicy,
    resolveWecomDynamicAgentPolicy,
  });
  markWecomReliableInboundActivity({
    mode: "bot",
    accountId: state.accountId,
    sessionId: state.baseSessionId,
    fromUser,
  });
  const { runtime, cfg } = state;
  const { safeFinishStream, safeDeliverReply } = createWecomBotSafeReplyHelpers({
    api,
    fromUser,
    streamId,
    responseUrl,
    state,
    hasBotStream,
    finishBotStream,
    normalizeWecomBotOutboundMediaUrls,
    deliverBotReplyText,
  });

  let startLateReplyWatcher = () => false;
  let readTranscriptFallbackResult = async () => ({ text: "", transcriptMessageId: "" });

  try {
    const groupGuardResult = applyWecomBotGroupChatGuard({
      isGroupChat,
      msgType,
      commandBody: state.commandBody,
      groupChatPolicy: state.groupChatPolicy,
      shouldTriggerWecomGroupResponse,
      shouldStripWecomGroupMentions,
      stripWecomGroupMentions,
    });
    if (!groupGuardResult.ok) {
      safeFinishStream(groupGuardResult.finishText);
      return;
    }
    state.commandBody = groupGuardResult.commandBody;

    const commandGuardResult = await applyWecomBotCommandAndSenderGuard({
      api,
      accountId: state.accountId,
      fromUser,
      chatId,
      isGroupChat,
      msgType,
      commandBody: state.commandBody,
      normalizedFromUser: state.normalizedFromUser,
      groupChatPolicy: state.groupChatPolicy,
      resolveWecomCommandPolicy,
      resolveWecomAllowFromPolicy,
      resolveWecomDmPolicy,
      isWecomSenderAllowed,
      extractLeadingSlashCommand,
      buildWecomBotHelpText,
      buildWecomBotStatusText,
    });
    state.isAdminUser = commandGuardResult.isAdminUser === true;
    state.commandBody = commandGuardResult.commandBody;
    if (!commandGuardResult.ok) {
      safeFinishStream(commandGuardResult.finishText);
      return;
    }
    const commandKey = msgType === "text" ? extractLeadingSlashCommand(state.commandBody) : "";
    if (commandKey === "/reset") {
      if (typeof resetWecomConversationSession !== "function") {
        safeFinishStream("当前会话重置能力未启用，请联系管理员。");
        return;
      }
      await resetWecomConversationSession({
        api,
        runtime,
        cfg,
        baseSessionId: state.baseSessionId,
        fromUser,
        chatId,
        isGroupChat,
        commandBody: state.commandBody,
        accountId: state.accountId,
        groupChatPolicy: state.groupChatPolicy,
        dynamicAgentPolicy: state.dynamicAgentPolicy,
        isAdminUser: state.isAdminUser,
        resolveWecomAgentRoute,
        activeLateReplyWatchers: ACTIVE_LATE_REPLY_WATCHERS,
      });
      safeFinishStream("会话已重置。请继续发送你的新问题。");
      return;
    }

    const inboundContentResult = await buildBotInboundContent({
      api,
      botModeConfig: state.botModeConfig,
      botProxyUrl: state.botProxyUrl,
      msgType,
      commandBody: state.commandBody,
      normalizedImageEntries: state.normalizedImageEntries,
      normalizedImageUrls: state.normalizedImageUrls,
      normalizedFileUrl: state.normalizedFileUrl,
      normalizedFileName: state.normalizedFileName,
      normalizedFileAesKey: state.normalizedFileAesKey,
      normalizedVoiceUrl: state.normalizedVoiceUrl,
      normalizedVoiceMediaId: state.normalizedVoiceMediaId,
      normalizedVoiceContentType: state.normalizedVoiceContentType,
      voiceInputMessageId: msgId,
      normalizedQuote: state.normalizedQuote,
    });
    if (Array.isArray(inboundContentResult.tempPathsToCleanup)) {
      state.tempPathsToCleanup.push(...inboundContentResult.tempPathsToCleanup);
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
      baseSessionId: state.baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      msgId,
      messageText,
      commandBody: state.commandBody,
      commandAuthorized: Boolean(extractLeadingSlashCommand(state.commandBody)),
      originalContent: state.originalContent,
      fromAddress: state.fromAddress,
      accountId: state.accountId,
      groupChatPolicy: state.groupChatPolicy,
      dynamicAgentPolicy: state.dynamicAgentPolicy,
      isAdminUser: state.isAdminUser,
      resolveWecomAgentRoute,
      seedDynamicAgentWorkspace,
      buildWecomBotInboundEnvelopePayload,
      buildWecomBotInboundContextPayload,
    });
    state.routedAgentId = runtimeContext.routedAgentId;
    state.sessionId = runtimeContext.sessionId;
    const storePath = runtimeContext.storePath;
    const ctxPayload = runtimeContext.ctxPayload;
    const sessionRuntimeId = runtimeContext.sessionRuntimeId;
    markWecomReliableInboundActivity({
      mode: "bot",
      accountId: state.accountId,
      sessionId: state.sessionId,
      fromUser,
    });
    await flushWecomSessionPendingReplies({
      mode: "bot",
      accountId: state.accountId,
      sessionId: state.sessionId,
    });

    const dispatchResult = await executeWecomBotDispatchRuntime({
      api,
      runtime,
      cfg,
      flowState: state,
      ctxPayload,
      streamId,
      accountId: state.accountId,
      sessionId: state.sessionId,
      routedAgentId: state.routedAgentId,
      storePath,
      sessionRuntimeId,
      msgId,
      dispatchStartedAt: state.dispatchStartedAt,
      botModeConfig: state.botModeConfig,
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
    });
    startLateReplyWatcher = dispatchResult.startLateReplyWatcher;
    readTranscriptFallbackResult = dispatchResult.readTranscriptFallbackResult;
    if (dispatchResult.shouldReturnAfterFallback) return;
  } catch (err) {
    const shouldReturnFromError = await handleWecomBotDispatchError({
      api,
      err,
      dispatchStartedAt: state.dispatchStartedAt,
      isDispatchTimeoutError,
      startLateReplyWatcher,
      sessionId: state.sessionId,
      fromUser,
      buildWecomBotSessionId,
      runtime,
      cfg,
      routedAgentId: state.routedAgentId,
      dispatchState: state.dispatchState || null,
      markdownToWecomText,
      readTranscriptFallbackResult,
      safeDeliverReply,
      markTranscriptReplyDelivered,
      accountId: state.accountId,
    });
    if (shouldReturnFromError) return;
  } finally {
    for (const filePath of state.tempPathsToCleanup) {
      scheduleTempFileCleanup(filePath, api.logger);
    }
  }
}
