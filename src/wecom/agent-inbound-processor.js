import { buildWecomInboundContextPayload, buildWecomInboundEnvelopePayload } from "./agent-context.js";
import { createWecomAgentDispatchHandlers } from "./agent-dispatch-handlers.js";
import { handleWecomAgentPostDispatchFallback } from "./agent-dispatch-fallback.js";
import { createWecomAgentDispatchState, resolveWecomAgentReplyRuntimePolicy } from "./agent-reply-runtime.js";
import { createWecomAgentStreamingChunkManager } from "./agent-streaming-chunks.js";
import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { buildWorkspaceAutoSendHints, computeStreamingTailText } from "./agent-reply-format.js";
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
  mediaId,
  picUrl,
  recognition,
  thumbMediaId,
  fileName,
  fileSize,
  linkTitle,
  linkDescription,
  linkUrl,
  linkPicUrl,
  chatId,
  isGroupChat,
  msgId,
}) {
  const config = getWecomConfig(api, accountId);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
    api.logger.warn?.("wecom: not configured (check channels.wecom in openclaw.json)");
    return;
  }

  const { corpId, corpSecret, agentId, outboundProxy: proxyUrl } = config;
  const sendTextToUser = createWecomAgentTextSender({
    sendWecomText,
    corpId,
    corpSecret,
    agentId,
    toUser: fromUser,
    logger: api.logger,
    proxyUrl,
  });

  try {
    // 一用户一会话：群聊和私聊统一归并到 wecom:<userid>
    const baseSessionId = buildWecomSessionId(fromUser);
    let sessionId = baseSessionId;
    let routedAgentId = "";
    const fromAddress = `wecom:${fromUser}`;
    const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
    const originalContent = content || "";
    let commandBody = originalContent;
    const groupChatPolicy = resolveWecomGroupChatPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`);

    // 群聊触发策略（仅对文本消息）
    if (msgType === "text" && isGroupChat) {
      if (!groupChatPolicy.enabled) {
        api.logger.info?.(`wecom: group chat processing disabled, skipped chatId=${chatId || "unknown"}`);
        return;
      }
      if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
        api.logger.info?.(
          `wecom: group message skipped by trigger policy chatId=${chatId || "unknown"} mode=${groupChatPolicy.triggerMode || "direct"}`,
        );
        return;
      }
      if (shouldStripWecomGroupMentions(groupChatPolicy)) {
        commandBody = stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns);
      }
      if (!commandBody.trim()) {
        api.logger.info?.(`wecom: group message became empty after mention strip chatId=${chatId || "unknown"}`);
        return;
      }
    }

    const commandPolicy = resolveWecomCommandPolicy(api);
    const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, config.accountId || accountId || "default", config);
    const senderAllowed = isAdminUser || isWecomSenderAllowed({
      senderId: normalizedFromUser,
      allowFrom: allowFromPolicy.allowFrom,
    });
    if (!senderAllowed) {
      api.logger.warn?.(
        `wecom: sender blocked by allowFrom account=${config.accountId || "default"} user=${normalizedFromUser}`,
      );
      if (allowFromPolicy.rejectMessage) {
        await sendTextToUser(allowFromPolicy.rejectMessage);
      }
      return;
    }

    // 命令检测（仅对文本消息）
    if (msgType === "text") {
      let commandKey = extractLeadingSlashCommand(commandBody);
      if (commandKey === "/clear") {
        api.logger.info?.("wecom: translating /clear to native /reset command");
        commandBody = commandBody.replace(/^\/clear\b/i, "/reset");
        commandKey = "/reset";
      }
      if (commandKey) {
        const commandAllowed =
          commandPolicy.allowlist.includes(commandKey) ||
          (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
        if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
          api.logger.info?.(`wecom: command blocked by allowlist user=${fromUser} command=${commandKey}`);
          await sendTextToUser(commandPolicy.rejectMessage);
          return;
        }
        const handler = COMMANDS[commandKey];
        if (handler) {
          api.logger.info?.(`wecom: handling command ${commandKey}`);
          await handler({
            api,
            fromUser,
            corpId,
            corpSecret,
            agentId,
            accountId: config.accountId || "default",
            proxyUrl,
            chatId,
            isGroupChat,
          });
          return; // 命令已处理，不再调用 AI
        }
      }
    }

    const inboundResult = await buildInboundContent({
      api,
      corpId,
      corpSecret,
      agentId,
      proxyUrl,
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
    if (inboundResult.aborted) {
      return;
    }
    let messageText = String(inboundResult.messageText ?? "");
    const tempPathsToCleanup = Array.isArray(inboundResult.tempPathsToCleanup)
      ? inboundResult.tempPathsToCleanup
      : [];
    if (!messageText) {
      api.logger.warn?.("wecom: empty message content");
      return;
    }

    // 获取路由信息
    const route = resolveWecomAgentRoute({
      runtime,
      cfg,
      channel: "wecom",
      accountId: config.accountId || "default",
      sessionKey: baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      content: commandBody || messageText,
      mentionPatterns: groupChatPolicy.mentionPatterns,
      dynamicConfig: dynamicAgentPolicy,
      isAdminUser,
      logger: api.logger,
    });
    routedAgentId = String(route?.agentId ?? "").trim();
    sessionId = String(route?.sessionKey ?? "").trim() || baseSessionId;
    api.logger.info?.(
      `wecom: routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
    );
    try {
      await seedDynamicAgentWorkspace({
        api,
        agentId: route.agentId,
        workspaceTemplate: dynamicAgentPolicy.workspaceTemplate,
      });
    } catch (seedErr) {
      api.logger.warn?.(`wecom: workspace seed failed: ${String(seedErr?.message || seedErr)}`);
    }

    // 获取 storePath
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    // 格式化消息体
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = runtime.channel.reply.formatInboundEnvelope(
      {
        ...buildWecomInboundEnvelopePayload({
          fromUser,
          chatId,
          isGroupChat,
          messageText,
        }),
        ...envelopeOptions,
      },
    );

    // 构建 Session 上下文对象
    const ctxPayload = runtime.channel.reply.finalizeInboundContext(
      buildWecomInboundContextPayload({
        body,
        messageText,
        originalContent,
        commandBody,
        fromAddress,
        sessionId,
        accountId: config.accountId || "default",
        isGroupChat,
        chatId,
        fromUser,
        msgId,
      }),
    );

    // 注册会话到 Sessions UI
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "wecom",
        to: fromUser,
        accountId: config.accountId || "default",
      },
      onRecordError: (err) => {
        api.logger.warn?.(`wecom: failed to record session: ${err}`);
      },
    });
    api.logger.info?.(`wecom: session registered for ${sessionId}`);

    // 记录渠道活动
    runtime.channel.activity.record({
      channel: "wecom",
      accountId: config.accountId || "default",
      direction: "inbound",
    });

    api.logger.info?.(`wecom: dispatching message via agent runtime for session ${sessionId}`);

    // 使用 gateway 内部 agent runtime API 调用 AI
    // 对标 Telegram 的 dispatchReplyWithBufferedBlockDispatcher

    const dispatchState = createWecomAgentDispatchState();
    let progressNoticeTimer = null;
    let lateReplyWatcherPromise = null;
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
      logger: api.logger,
    });
    const sendProgressNotice = async (text = processingNoticeText) => {
      const noticeText = String(text ?? "").trim();
      if (!noticeText) return;
      if (dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply || dispatchState.hasSentProgressNotice) return;
      dispatchState.hasSentProgressNotice = true;
      await sendTextToUser(noticeText);
    };
    const sendFailureFallback = async (reason) => {
      if (dispatchState.hasDeliveredReply) return;
      dispatchState.hasDeliveredReply = true;
      const reasonText = String(reason ?? "unknown").slice(0, 160);
      await sendTextToUser(`抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${reasonText}`);
    };
    const startLateReplyWatcher = async (reason = "pending-final") => {
      if (dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply || lateReplyWatcherPromise) return;

      const watchStartedAt = Date.now();
      const watchId = `${sessionId}:${msgId || watchStartedAt}:${Math.random().toString(36).slice(2, 8)}`;
      lateReplyWatcherPromise = ensureLateReplyWatcherRunner()({
        watchId,
        reason,
        sessionId,
        sessionTranscriptId: ctxPayload.SessionId || sessionId,
        accountId: config.accountId || "default",
        storePath,
        logger: api.logger,
        watchStartedAt,
        watchMs: lateReplyWatchMs,
        pollMs: lateReplyPollMs,
        activeWatchers: ACTIVE_LATE_REPLY_WATCHERS,
        isDelivered: () => dispatchState.hasDeliveredReply,
        markDelivered: () => {
          dispatchState.hasDeliveredReply = true;
        },
        sendText: async (text) => sendTextToUser(text),
        onFailureFallback: async (err) => sendFailureFallback(err),
      }).finally(() => {
        lateReplyWatcherPromise = null;
      });
    };

    try {
      if (progressNoticeDelayMs > 0) {
        progressNoticeTimer = setTimeout(() => {
          sendProgressNotice().catch((noticeErr) => {
            api.logger.warn?.(`wecom: failed to send progress notice: ${String(noticeErr)}`);
          });
        }, progressNoticeDelayMs);
      }

      let dispatchResult = null;
      api.logger.info?.(`wecom: waiting for agent reply (timeout=${replyTimeoutMs}ms)`);
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
      dispatchResult = await withTimeout(
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
                    accountId: config.accountId || "default",
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
      api.logger.warn?.(`wecom: dispatch failed: ${String(dispatchErr)}`);
      if (isDispatchTimeoutError(dispatchErr)) {
        dispatchState.suppressLateDispatcherDeliveries = true;
        await sendProgressNotice(queuedNoticeText);
        await startLateReplyWatcher("dispatch-timeout");
      } else {
        await sendFailureFallback(dispatchErr);
      }
    } finally {
      if (progressNoticeTimer) clearTimeout(progressNoticeTimer);
      for (const filePath of tempPathsToCleanup) {
        scheduleTempFileCleanup(filePath, api.logger);
      }
    }

  } catch (err) {
    api.logger.error?.(`wecom: failed to process message: ${err.message}`);
    api.logger.error?.(`wecom: stack trace: ${err.stack}`);

    // 发送错误提示给用户
    try {
      await sendTextToUser(`抱歉，处理您的消息时出现错误，请稍后重试。\n错误: ${err.message?.slice(0, 100) || "未知错误"}`);
    } catch (sendErr) {
      api.logger.error?.(`wecom: failed to send error message: ${sendErr.message}`);
      api.logger.error?.(`wecom: send error stack: ${sendErr.stack}`);
      api.logger.error?.(`wecom: original error was: ${err.message}`);
    }
  }
  }


  return processInboundMessage;
}
