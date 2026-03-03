import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { buildWecomBotInboundContextPayload, buildWecomBotInboundEnvelopePayload } from "./bot-context.js";

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
    fetchMediaFromUrl,
    detectImageContentTypeFromBuffer,
    decryptWecomMediaBuffer,
    pickImageFileExtension,
    WECOM_TEMP_DIR_NAME,
    mkdir,
    tmpdir,
    join,
    writeFile,
    inferFilenameFromMediaDownload,
    smartDecryptWecomFileBuffer,
    basename,
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

  try {
    if (isGroupChat && msgType === "text") {
      if (!groupChatPolicy.enabled) {
        safeFinishStream("当前群聊消息处理未启用。");
        return;
      }
      if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
        const hint =
          groupChatPolicy.triggerMode === "mention"
            ? "请先 @ 机器人后再发送消息。"
            : groupChatPolicy.triggerMode === "keyword"
              ? "当前消息未命中群聊触发关键词。"
              : "当前消息不满足群聊触发条件。";
        safeFinishStream(hint);
        return;
      }
      if (shouldStripWecomGroupMentions(groupChatPolicy)) {
        commandBody = stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns);
      }
    }

    const commandPolicy = resolveWecomCommandPolicy(api);
    const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, "default", {});
    const senderAllowed = isAdminUser || isWecomSenderAllowed({
      senderId: normalizedFromUser,
      allowFrom: allowFromPolicy.allowFrom,
    });
    if (!senderAllowed) {
      safeFinishStream(allowFromPolicy.rejectMessage || "当前账号未授权，请联系管理员。");
      return;
    }

    if (msgType === "text") {
      let commandKey = extractLeadingSlashCommand(commandBody);
      if (commandKey === "/clear") {
        commandBody = commandBody.replace(/^\/clear\b/i, "/reset");
        commandKey = "/reset";
      }
      if (commandKey) {
        const commandAllowed =
          commandPolicy.allowlist.includes(commandKey) ||
          (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
        if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
          safeFinishStream(commandPolicy.rejectMessage);
          return;
        }
        if (commandKey === "/help") {
          safeFinishStream(buildWecomBotHelpText());
          return;
        }
        if (commandKey === "/status") {
          safeFinishStream(buildWecomBotStatusText(api, fromUser));
          return;
        }
      }
    }

    let messageText = String(commandBody ?? "").trim();
    if (normalizedImageUrls.length > 0) {
      const fetchedImagePaths = [];
      const imageUrlsToFetch = normalizedImageUrls.slice(0, 3);
      const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
      await mkdir(tempDir, { recursive: true });
      for (const imageUrl of imageUrlsToFetch) {
        try {
          const { buffer, contentType } = await fetchMediaFromUrl(imageUrl, {
            proxyUrl: botProxyUrl,
            logger: api.logger,
            forceProxy: Boolean(botProxyUrl),
            maxBytes: 8 * 1024 * 1024,
          });
          const normalizedType = String(contentType ?? "")
            .trim()
            .toLowerCase()
            .split(";")[0]
            .trim();
          let effectiveBuffer = buffer;
          let effectiveImageType =
            normalizedType.startsWith("image/") ? normalizedType : detectImageContentTypeFromBuffer(buffer);
          if (!effectiveImageType && botModeConfig?.encodingAesKey) {
            try {
              const decryptedBuffer = decryptWecomMediaBuffer({
                aesKey: botModeConfig.encodingAesKey,
                encryptedBuffer: buffer,
              });
              const decryptedImageType = detectImageContentTypeFromBuffer(decryptedBuffer);
              if (decryptedImageType) {
                effectiveBuffer = decryptedBuffer;
                effectiveImageType = decryptedImageType;
                api.logger.info?.(
                  `wecom(bot): decrypted media buffer from content-type=${normalizedType || "unknown"} to ${decryptedImageType}`,
                );
              }
            } catch (decryptErr) {
              api.logger.warn?.(`wecom(bot): media decrypt attempt failed: ${String(decryptErr?.message || decryptErr)}`);
            }
          }
          if (!effectiveImageType) {
            const headerHex = buffer.subarray(0, 16).toString("hex");
            throw new Error(`unexpected content-type: ${normalizedType || "unknown"} header=${headerHex}`);
          }
          const ext = pickImageFileExtension({ contentType: effectiveImageType, sourceUrl: imageUrl });
          const imageTempPath = join(
            tempDir,
            `bot-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`,
          );
          await writeFile(imageTempPath, effectiveBuffer);
          fetchedImagePaths.push(imageTempPath);
          tempPathsToCleanup.push(imageTempPath);
          api.logger.info?.(
            `wecom(bot): downloaded image from url, size=${effectiveBuffer.length} bytes, path=${imageTempPath}`,
          );
        } catch (imageErr) {
          api.logger.warn?.(`wecom(bot): failed to fetch image url: ${String(imageErr?.message || imageErr)}`);
        }
      }

      if (fetchedImagePaths.length > 0) {
        const intro = fetchedImagePaths.length > 1 ? "[用户发送了多张图片]" : "[用户发送了一张图片]";
        const parts = [];
        if (messageText) parts.push(messageText);
        parts.push(intro);
        for (let i = 0; i < fetchedImagePaths.length; i += 1) {
          parts.push(`图片${i + 1}: ${fetchedImagePaths[i]}`);
        }
        parts.push("请使用 Read 工具查看图片并基于图片内容回复用户。");
        messageText = parts.join("\n").trim();
      } else if (!messageText || messageText === "[图片]") {
        safeFinishStream("图片接收失败（下载失败或链接失效），请重新发送原图后重试。");
        return;
      } else {
        messageText = `${messageText}\n\n[附加说明] 用户还发送了图片，但插件下载失败。`;
      }
    }

    if (msgType === "file") {
      const displayName =
        inferFilenameFromMediaDownload({
          explicitName: normalizedFileName,
          sourceUrl: normalizedFileUrl,
          contentType: "",
        }) || "附件";
      if (normalizedFileUrl) {
        try {
          const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
          await mkdir(tempDir, { recursive: true });
          const downloaded = await fetchMediaFromUrl(normalizedFileUrl, {
            proxyUrl: botProxyUrl,
            logger: api.logger,
            forceProxy: Boolean(botProxyUrl),
            maxBytes: 20 * 1024 * 1024,
          });
          const resolvedName = inferFilenameFromMediaDownload({
            explicitName: normalizedFileName,
            contentDisposition: downloaded.contentDisposition,
            sourceUrl: downloaded.finalUrl || normalizedFileUrl,
            contentType: downloaded.contentType,
          });
          const decrypted = smartDecryptWecomFileBuffer({
            buffer: downloaded.buffer,
            aesKey: botModeConfig?.encodingAesKey,
            contentType: downloaded.contentType,
            sourceUrl: downloaded.finalUrl || normalizedFileUrl,
            decryptFn: decryptWecomMediaBuffer,
            logger: api.logger,
          });
          const safeName = basename(resolvedName) || `file-${Date.now()}.bin`;
          const fileTempPath = join(
            tempDir,
            `bot-file-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`,
          );
          await writeFile(fileTempPath, decrypted.buffer);
          tempPathsToCleanup.push(fileTempPath);
          messageText =
            `[用户发送了一个文件: ${safeName}，已保存到: ${fileTempPath}]` +
            "\n\n请根据文件内容回复用户；如需读取详情请使用 Read 工具。";
          api.logger.info?.(
            `wecom(bot): saved file to ${fileTempPath}, size=${decrypted.buffer.length} bytes` +
              `, decrypted=${decrypted.decrypted ? "yes" : "no"} source=${downloaded.source || "unknown"}`,
          );
        } catch (fileErr) {
          api.logger.warn?.(`wecom(bot): failed to fetch file url: ${String(fileErr?.message || fileErr)}`);
          messageText = `[用户发送了一个文件: ${displayName}，但下载失败]\n\n请提示用户重新发送文件。`;
        }
      } else if (!messageText) {
        messageText = `[用户发送了一个文件: ${displayName}]`;
      }
    }

    if (normalizedQuote?.content) {
      const quoteLabel = normalizedQuote.msgType === "image" ? "[引用图片]" : `> ${normalizedQuote.content}`;
      messageText = `${quoteLabel}\n\n${String(messageText ?? "").trim()}`.trim();
    }

    if (!messageText) {
      safeFinishStream("消息内容为空，请发送有效文本。");
      return;
    }

    const route = resolveWecomAgentRoute({
      runtime,
      cfg,
      channel: "wecom",
      accountId: "bot",
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
      `wecom(bot): routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
    );
    try {
      await seedDynamicAgentWorkspace({
        api,
        agentId: route.agentId,
        workspaceTemplate: dynamicAgentPolicy.workspaceTemplate,
      });
    } catch (seedErr) {
      api.logger.warn?.(`wecom(bot): workspace seed failed: ${String(seedErr?.message || seedErr)}`);
    }
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const contextTimestamp = Date.now();
    const body = runtime.channel.reply.formatInboundEnvelope({
      ...buildWecomBotInboundEnvelopePayload({
        fromUser,
        chatId,
        isGroupChat,
        messageText,
        timestamp: contextTimestamp,
      }),
      ...envelopeOptions,
    });
    const ctxPayload = runtime.channel.reply.finalizeInboundContext(
      buildWecomBotInboundContextPayload({
        body,
        messageText,
        originalContent,
        commandBody,
        fromAddress,
        sessionId,
        isGroupChat,
        chatId,
        fromUser,
        msgId,
        timestamp: contextTimestamp,
      }),
    );
    const sessionRuntimeId = String(ctxPayload.SessionId ?? "").trim();

    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "wecom",
        to: fromUser,
        accountId: "bot",
      },
      onRecordError: (err) => {
        api.logger.warn?.(`wecom(bot): failed to record session: ${err}`);
      },
    });

    runtime.channel.activity.record({
      channel: "wecom",
      accountId: "bot",
      direction: "inbound",
    });

    let blockText = "";
    let streamFinished = false;
    let lateReplyWatcherPromise = null;
    const replyTimeoutMs = Math.max(15000, Number(botModeConfig?.replyTimeoutMs) || 90000);
    const lateReplyWatchMs = Math.max(30000, Number(botModeConfig?.lateReplyWatchMs) || 180000);
    const lateReplyPollMs = Math.max(500, Number(botModeConfig?.lateReplyPollMs) || 2000);
    const readTranscriptFallback = async ({
      runtimeStorePath = storePath,
      runtimeSessionId = sessionId,
      runtimeTranscriptSessionId = sessionRuntimeId || sessionId,
      minTimestamp = dispatchStartedAt,
      logErrors = true,
    } = {}) => {
      try {
        const transcriptPath = await resolveSessionTranscriptFilePath({
          storePath: runtimeStorePath,
          sessionKey: runtimeSessionId,
          sessionId: runtimeTranscriptSessionId,
          logger: api.logger,
        });
        const { chunk } = await readTranscriptAppendedChunk(transcriptPath, 0);
        if (!chunk) return { text: "", transcriptMessageId: "" };
        const lines = chunk.split("\n");
        let latestReply = null;
        for (const line of lines) {
          const parsedReply = parseLateAssistantReplyFromTranscriptLine(line, minTimestamp);
          if (!parsedReply) continue;
          if (hasTranscriptReplyBeenDelivered(runtimeSessionId, parsedReply.transcriptMessageId)) continue;
          latestReply = parsedReply;
        }
        const text = latestReply?.text ? markdownToWecomText(latestReply.text).trim() : "";
        if (!text) return { text: "", transcriptMessageId: "" };
        return {
          text,
          transcriptMessageId: String(latestReply?.transcriptMessageId ?? "").trim(),
        };
      } catch (err) {
        if (logErrors) {
          api.logger.warn?.(`wecom(bot): transcript fallback failed: ${String(err?.message || err)}`);
        }
        return { text: "", transcriptMessageId: "" };
      }
    };
    const tryFinishFromTranscript = async (minTimestamp = dispatchStartedAt) => {
      const fallback = await readTranscriptFallback({
        runtimeStorePath: storePath,
        runtimeSessionId: sessionId,
        runtimeTranscriptSessionId: sessionRuntimeId || sessionId,
        minTimestamp,
      });
      if (!fallback.text) return false;
      streamFinished = await safeDeliverReply(fallback.text, "transcript-fallback");
      if (streamFinished && fallback.transcriptMessageId) {
        markTranscriptReplyDelivered(sessionId, fallback.transcriptMessageId);
        api.logger.info?.(
          `wecom(bot): filled reply from transcript session=${sessionId} messageId=${fallback.transcriptMessageId}`,
        );
      }
      return streamFinished;
    };
    startLateReplyWatcher = (reason = "dispatch-timeout", minTimestamp = dispatchStartedAt) => {
      if (streamFinished || lateReplyWatcherPromise) return false;
      const watchStartedAt = Date.now();
      const watchId = `wecom-bot:${sessionId}:${msgId || watchStartedAt}:${Math.random().toString(36).slice(2, 8)}`;
      const runLateReplyWatcher = ensureLateReplyWatcherRunner();
      lateReplyWatcherPromise = runLateReplyWatcher({
        watchId,
        reason,
        sessionId,
        sessionTranscriptId: sessionRuntimeId || sessionId,
        accountId: "bot",
        storePath,
        logger: api.logger,
        watchStartedAt,
        watchMs: lateReplyWatchMs,
        pollMs: lateReplyPollMs,
        activeWatchers: ACTIVE_LATE_REPLY_WATCHERS,
        isDelivered: () => streamFinished,
        markDelivered: () => {
          streamFinished = true;
        },
        sendText: async (text) => {
          const delivered = await safeDeliverReply(text, "late-transcript-fallback");
          if (!delivered) {
            throw new Error("late transcript delivery failed");
          }
        },
        onFailureFallback: async (watchErr) => {
          if (streamFinished) return;
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
          deliver: async (payload, info) => {
            if (!hasBotStream(streamId)) return;
            if (info.kind === "block") {
              const blockMediaUrls = normalizeWecomBotOutboundMediaUrls(payload);
              if (blockMediaUrls.length > 0) {
                const blockMediaType = String(payload?.mediaType ?? "").trim().toLowerCase() || undefined;
                for (const mediaUrl of blockMediaUrls) {
                  queueBotStreamMedia(streamId, mediaUrl, { mediaType: blockMediaType });
                }
                api.logger.debug?.(
                  `wecom(bot): queued block media stream=${streamId} count=${blockMediaUrls.length} type=${blockMediaType || "unknown"}`,
                );
              }
              if (!payload?.text) return;
              const incomingBlock = String(payload.text);
              if (incomingBlock.startsWith(blockText)) {
                blockText = incomingBlock;
              } else if (!blockText.endsWith(incomingBlock)) {
                blockText += incomingBlock;
              }
              updateBotStream(streamId, markdownToWecomText(blockText), { append: false, finished: false });
              return;
            }
            if (info.kind !== "final") return;
            if (payload?.text) {
              if (isAgentFailureText(payload.text)) {
                streamFinished = await safeDeliverReply(`抱歉，请求失败：${payload.text}`, "upstream-failure");
                return;
              }
              const finalText = markdownToWecomText(payload.text).trim();
              if (finalText) {
                streamFinished = await safeDeliverReply(finalText, "final");
                return;
              }
            }
            if (payload?.mediaUrl || (payload?.mediaUrls?.length ?? 0) > 0) {
              streamFinished = await safeDeliverReply(
                {
                  text: "已收到模型返回的媒体结果。",
                  mediaUrl: payload.mediaUrl,
                  mediaUrls: payload.mediaUrls,
                },
                "final-media",
              );
              return;
            }
          },
          onError: async (err, info) => {
            api.logger.error?.(`wecom(bot): ${info.kind} reply failed: ${String(err)}`);
            streamFinished = await safeDeliverReply(
              `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
              `dispatch-${info.kind}-error`,
            );
          },
        },
      }),
      replyTimeoutMs,
      `dispatch timed out after ${replyTimeoutMs}ms`,
    );

    if (!streamFinished) {
      const filledFromTranscript = await tryFinishFromTranscript(dispatchStartedAt);
      if (filledFromTranscript) return;
      const fallback = markdownToWecomText(blockText).trim();
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
      const fallbackFromTranscript = await readTranscriptFallback({
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
