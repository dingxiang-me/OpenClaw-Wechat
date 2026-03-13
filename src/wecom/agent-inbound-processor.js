import { buildWecomInboundContextPayload, buildWecomInboundEnvelopePayload } from "./agent-context.js";
import { executeWecomAgentDispatchFlow } from "./agent-dispatch-executor.js";
import { handleWecomAgentInboundError } from "./agent-inbound-error.js";
import { applyWecomAgentInboundGuards } from "./agent-inbound-guards.js";
import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { prepareWecomAgentRuntimeContext } from "./agent-runtime-context.js";
import { createWecomAgentTextSender } from "./agent-text-sender.js";

export function createWecomAgentInboundProcessor(deps = {}) {
  const {
    getWecomConfig,
    buildWecomSessionId,
    resolveWecomGroupChatPolicy,
    resolveWecomDynamicAgentPolicy,
    shouldTriggerWecomGroupResponse,
    shouldStripWecomGroupMentions,
    stripWecomGroupMentions,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    resolveWecomDmPolicy,
    resolveWecomEventPolicy = () => ({
      enabled: true,
      enterAgentWelcomeEnabled: false,
      enterAgentWelcomeText: "",
    }),
    isWecomSenderAllowed,
    sendWecomText,
    extractLeadingSlashCommand,
    COMMANDS,
    buildInboundContent,
    resolveWecomAgentRoute,
    seedDynamicAgentWorkspace,
    resolveWecomReplyStreamingPolicy,
    asNumber,
    requireEnv,
    getByteLength,
    markdownToWecomText,
    autoSendWorkspaceFilesFromReplyText,
    sendWecomOutboundMediaBatch,
    sleep,
    resolveSessionTranscriptFilePath,
    readTranscriptAppendedChunk,
    parseLateAssistantReplyFromTranscriptLine,
    hasTranscriptReplyBeenDelivered,
    markTranscriptReplyDelivered,
    withTimeout,
    isDispatchTimeoutError,
    isAgentFailureText,
    scheduleTempFileCleanup,
    ACTIVE_LATE_REPLY_WATCHERS,
    resetWecomConversationSession,
    clearSessionStoreEntry,
  } = deps;

  let lateReplyWatcherRunner = null;
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

  async function processInboundMessage({
    api,
    accountId,
    fromUser,
    content,
    msgType,
    eventType,
    mediaId,
    picUrl,
    recognition,
    fileName,
    fileSize,
    linkTitle,
    linkDescription,
    linkUrl,
    chatId,
    isGroupChat,
    msgId,
  }) {
    const config = getWecomConfig(api, accountId);
    if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
      api.logger.warn?.("wecom: not configured (check channels.wecom in openclaw.json)");
      return;
    }

    const cfg = api.config;
    const runtime = api.runtime;
    const { corpId, corpSecret, agentId, outboundProxy: proxyUrl, apiProxy } = config;
    const sendTextToUser = createWecomAgentTextSender({
      sendWecomText,
      corpId,
      corpSecret,
      agentId,
      toUser: fromUser,
      logger: api.logger,
      proxyUrl,
      apiProxy,
    });

    try {
      const baseSessionId = buildWecomSessionId(fromUser, config.accountId || accountId || "default");
      let sessionId = baseSessionId;
      let routedAgentId = "";
      const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
      const fromAddress = `wecom:${normalizedFromUser}`;
      const originalContent = content || "";
      let commandBody = originalContent;
      const groupChatPolicy = resolveWecomGroupChatPolicy(api);
      const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
      api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`);

      const guardResult = await applyWecomAgentInboundGuards({
        api,
        config,
        accountId,
        fromUser,
        msgType,
        isGroupChat,
        chatId,
        commandBody,
        normalizedFromUser,
        groupChatPolicy,
        shouldTriggerWecomGroupResponse,
        shouldStripWecomGroupMentions,
        stripWecomGroupMentions,
        resolveWecomCommandPolicy,
        resolveWecomAllowFromPolicy,
        resolveWecomDmPolicy,
        isWecomSenderAllowed,
        extractLeadingSlashCommand,
        COMMANDS,
        sendTextToUser,
        commandHandlerContext: {
          api,
          fromUser,
          corpId,
          corpSecret,
          agentId,
          accountId: config.accountId || "default",
          proxyUrl,
          apiProxy,
          chatId,
          isGroupChat,
        },
      });

      if (String(msgType ?? "").trim().toLowerCase() === "event") {
        const normalizedEventType = String(eventType ?? "").trim().toLowerCase();
        const eventPolicy = resolveWecomEventPolicy(api, config.accountId || accountId, config);
        if (!eventPolicy?.enabled) {
          api.logger.info?.(`wecom: event skipped (disabled) type=${normalizedEventType || "unknown"}`);
          return;
        }
        if (normalizedEventType === "enter_agent" && eventPolicy.enterAgentWelcomeEnabled) {
          const welcomeText = String(eventPolicy.enterAgentWelcomeText ?? "").trim();
          if (welcomeText) {
            await sendTextToUser(welcomeText);
            api.logger.info?.(`wecom: enter_agent welcome sent account=${config.accountId || accountId}`);
          }
          return;
        }
        api.logger.info?.(`wecom: event ignored type=${normalizedEventType || "unknown"}`);
        return;
      }
      if (!guardResult.ok) return;
      commandBody = guardResult.commandBody;
      const isAdminUser = guardResult.isAdminUser === true;
      const commandKey = msgType === "text" ? extractLeadingSlashCommand(commandBody) : "";

      if (commandKey === "/reset") {
        if (typeof resetWecomConversationSession !== "function") {
          api.logger.warn?.("wecom: local /reset requested but resetWecomConversationSession is unavailable");
          await sendTextToUser("当前会话重置能力未启用，请联系管理员。");
          return;
        }
        await resetWecomConversationSession({
          api,
          runtime,
          cfg,
          baseSessionId,
          fromUser,
          chatId,
          isGroupChat,
          commandBody,
          accountId: config.accountId || accountId || "default",
          groupChatPolicy,
          dynamicAgentPolicy,
          isAdminUser,
          resolveWecomAgentRoute,
          activeLateReplyWatchers: ACTIVE_LATE_REPLY_WATCHERS,
        });
        await sendTextToUser("会话已重置。请继续发送你的新问题。");
        return;
      }

      const inboundResult = await buildInboundContent({
        api,
        corpId,
        corpSecret,
        agentId,
        proxyUrl,
        apiProxy,
        fromUser,
        msgType,
        baseText: msgType === "text" ? commandBody : originalContent,
        mediaId,
        picUrl,
        recognition,
        fileName,
        fileSize,
        linkTitle,
        linkDescription,
        linkUrl,
      });
      if (inboundResult.aborted) return;

      const messageText = String(inboundResult.messageText ?? "");
      const tempPathsToCleanup = Array.isArray(inboundResult.tempPathsToCleanup) ? inboundResult.tempPathsToCleanup : [];
      if (!messageText) {
        api.logger.warn?.("wecom: empty message content");
        return;
      }

      const runtimeContext = await prepareWecomAgentRuntimeContext({
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
        commandAuthorized: Boolean(extractLeadingSlashCommand(commandBody)),
        originalContent,
        fromAddress,
        accountId: config.accountId || "default",
        groupChatPolicy,
        dynamicAgentPolicy,
        isAdminUser,
        resolveWecomAgentRoute,
        seedDynamicAgentWorkspace,
        buildWecomInboundEnvelopePayload,
        buildWecomInboundContextPayload,
      });
      routedAgentId = runtimeContext.routedAgentId;
      sessionId = runtimeContext.sessionId;
      const storePath = runtimeContext.storePath;
      const ctxPayload = runtimeContext.ctxPayload;
      const runtimeAccountId = runtimeContext.accountId;

      api.logger.info?.(`wecom: dispatching message via agent runtime for session ${sessionId}`);
      await executeWecomAgentDispatchFlow({
        api,
        runtime,
        cfg,
        ctxPayload,
        sessionId,
        routedAgentId,
        runtimeAccountId,
        msgId,
        storePath,
        fromUser,
        corpId,
        corpSecret,
        agentId,
        proxyUrl,
        apiProxy,
        tempPathsToCleanup,
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
      });
    } catch (err) {
      await handleWecomAgentInboundError({ api, err, sendTextToUser });
    }
  }

  return processInboundMessage;
}
