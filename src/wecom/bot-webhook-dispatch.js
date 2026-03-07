function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotParsedDispatcher: ${name} is required`);
  }
}

function sendPlainText(res, statusCode, content) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(content);
}

function sendEncryptedJson(res, encryptedPayload) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(encryptedPayload);
}

function buildEncryptedStreamPayload({
  buildWecomBotEncryptedResponse,
  botConfig,
  timestamp,
  nonce,
  streamId,
  content,
  finish,
  msgItem,
  thinkingContent,
  feedbackId,
}) {
  const streamPayload = {
    id: streamId,
    content,
    finish,
  };
  if (Array.isArray(msgItem) && msgItem.length > 0) {
    streamPayload.msg_item = msgItem;
  }
  if (String(thinkingContent ?? "").trim()) {
    streamPayload.thinking_content = String(thinkingContent).trim();
  }
  if (feedbackId) {
    streamPayload.feedback = { id: feedbackId };
  }
  return buildWecomBotEncryptedResponse({
    token: botConfig.token,
    aesKey: botConfig.encodingAesKey,
    timestamp,
    nonce,
    plainPayload: {
      msgtype: "stream",
      stream: streamPayload,
    },
  });
}

export function createWecomBotParsedDispatcher({
  api,
  cleanupExpiredBotStreams,
  getBotStream,
  buildWecomBotEncryptedResponse,
  markInboundMessageSeen,
  buildWecomBotSessionId,
  createBotStream,
  upsertBotResponseUrlCache,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  processBotInboundMessage,
  deliverBotReplyText,
  finishBotStream,
  recordInboundMetric = () => {},
  recordRuntimeErrorMetric = () => {},
  randomUuid = () => "",
} = {}) {
  assertFunction("cleanupExpiredBotStreams", cleanupExpiredBotStreams);
  assertFunction("getBotStream", getBotStream);
  assertFunction("buildWecomBotEncryptedResponse", buildWecomBotEncryptedResponse);
  assertFunction("markInboundMessageSeen", markInboundMessageSeen);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("createBotStream", createBotStream);
  assertFunction("upsertBotResponseUrlCache", upsertBotResponseUrlCache);
  if (!messageProcessLimiter || typeof messageProcessLimiter.execute !== "function") {
    throw new Error("createWecomBotParsedDispatcher: messageProcessLimiter.execute is required");
  }
  assertFunction("executeInboundTaskWithSessionQueue", executeInboundTaskWithSessionQueue);
  assertFunction("processBotInboundMessage", processBotInboundMessage);
  assertFunction("deliverBotReplyText", deliverBotReplyText);
  assertFunction("finishBotStream", finishBotStream);
  assertFunction("randomUuid", randomUuid);

  function buildStreamId(accountId = "default") {
    const normalized = String(randomUuid() || "").trim();
    const accountSlug = String(accountId ?? "default")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_") || "default";
    if (normalized) return `stream_${normalized}`;
    return `stream_${accountSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function respondStreamRefresh({ parsed, res, timestamp, nonce }) {
    const activeBotConfig = parsed?._botConfig;
    if (!activeBotConfig?.token || !activeBotConfig?.encodingAesKey) {
      sendPlainText(res, 401, "Invalid bot account config");
      return;
    }
    cleanupExpiredBotStreams(activeBotConfig.streamExpireMs);
    const streamId = parsed.streamId || `stream-${Date.now()}`;
    const stream = getBotStream(streamId);
    const feedbackId = String(parsed.feedbackId || stream?.feedbackId || "").trim();
    const encryptedResponse = buildEncryptedStreamPayload({
      buildWecomBotEncryptedResponse,
      botConfig: activeBotConfig,
      timestamp,
      nonce,
      streamId,
      content: stream?.content ?? "会话已过期",
      finish: stream ? stream.finished === true : true,
      msgItem: stream?.msgItem,
      thinkingContent: stream?.thinkingContent,
      feedbackId,
    });
    sendEncryptedJson(res, encryptedResponse);
  }

  function scheduleBotInboundTask({ parsed, botSessionId, streamId }) {
    messageProcessLimiter
      .execute(() =>
        executeInboundTaskWithSessionQueue({
          api,
          sessionId: botSessionId,
          isBot: true,
          task: () =>
            processBotInboundMessage({
              api,
              streamId,
              fromUser: parsed.fromUser,
              content: parsed.content,
              msgType: parsed.msgType,
              msgId: parsed.msgId,
              chatId: parsed.chatId,
              isGroupChat: parsed.isGroupChat,
              imageUrls: parsed.imageUrls,
              fileUrl: parsed.fileUrl,
              fileName: parsed.fileName,
              quote: parsed.quote,
              responseUrl: parsed.responseUrl,
              accountId: parsed.accountId,
              voiceUrl: parsed.voiceUrl,
              voiceMediaId: parsed.voiceMediaId,
              voiceContentType: parsed.voiceContentType,
            }),
        }),
      )
      .catch((err) => {
        api.logger.error?.(`wecom(bot): async message processing failed: ${String(err?.message || err)}`);
        recordRuntimeErrorMetric({
          scope: "bot-dispatch",
          reason: String(err?.message || err),
          accountId: parsed.accountId,
        });
        deliverBotReplyText({
          api,
          fromUser: parsed.fromUser,
          sessionId: botSessionId,
          streamId,
          responseUrl: parsed.responseUrl,
          accountId: parsed.accountId,
          text: `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
          reason: "bot-async-processing-error",
        }).catch((deliveryErr) => {
          api.logger.warn?.(`wecom(bot): failed to deliver async error reply: ${String(deliveryErr?.message || deliveryErr)}`);
          finishBotStream(
            streamId,
            `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
          );
        });
      });
  }

  function respondMessage({ parsed, res, timestamp, nonce }) {
    const activeBotConfig = parsed?._botConfig;
    if (!activeBotConfig?.token || !activeBotConfig?.encodingAesKey) {
      sendPlainText(res, 401, "Invalid bot account config");
      return;
    }
    const accountId = String(parsed?.accountId ?? "default").trim().toLowerCase() || "default";
    recordInboundMetric({
      mode: "bot",
      msgType: parsed.msgType || parsed.kind || "unknown",
      accountId,
    });
    const dedupeStub = {
      MsgId: parsed.msgId,
      FromUserName: parsed.fromUser,
      MsgType: parsed.msgType,
      Content: parsed.content,
      CreateTime: String(Math.floor(Date.now() / 1000)),
    };
    if (!markInboundMessageSeen(dedupeStub, `bot:${accountId}`)) {
      sendPlainText(res, 200, "success");
      return;
    }

    const botSessionId = buildWecomBotSessionId(parsed.fromUser, accountId);
    const streamId = buildStreamId(accountId);
    const feedbackId = String(parsed.feedbackId ?? "").trim();
    createBotStream(streamId, activeBotConfig.placeholderText, {
      feedbackId,
      sessionId: botSessionId,
      accountId,
    });
    if (parsed.responseUrl) {
      upsertBotResponseUrlCache({
        sessionId: botSessionId,
        responseUrl: parsed.responseUrl,
      });
    }
    const encryptedResponse = buildEncryptedStreamPayload({
      buildWecomBotEncryptedResponse,
      botConfig: activeBotConfig,
      timestamp,
      nonce,
      streamId,
      content: activeBotConfig.placeholderText,
      finish: false,
      feedbackId,
    });
    sendEncryptedJson(res, encryptedResponse);
    scheduleBotInboundTask({
      parsed,
      botSessionId,
      streamId,
    });
  }

  return async function dispatchParsed({ parsed, res, timestamp, nonce, botConfig } = {}) {
    if (!parsed || typeof parsed !== "object") {
      sendPlainText(res, 200, "success");
      return true;
    }
    parsed._botConfig = botConfig;
    if (parsed.kind === "stream-refresh") {
      respondStreamRefresh({ parsed, res, timestamp, nonce });
      return true;
    }
    if (parsed.kind === "event" || parsed.kind === "unsupported" || parsed.kind === "invalid") {
      sendPlainText(res, 200, "success");
      return true;
    }
    if (parsed.kind === "message") {
      respondMessage({ parsed, res, timestamp, nonce });
      return true;
    }
    return false;
  };
}
