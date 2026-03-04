import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotParsedDispatcher } from "../src/wecom/bot-webhook-dispatch.js";

function createResponseMock() {
  const headers = {};
  let body = "";
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(chunk = "") {
      body = String(chunk ?? "");
      this.writableEnded = true;
    },
  };
  return {
    res,
    getBody: () => body,
    getHeader: (name) => headers[String(name).toLowerCase()],
  };
}

function createDispatcher(overrides = {}) {
  const state = {
    encryptedPayloads: [],
    createdStreams: [],
    queuedTasks: [],
    processedMessages: [],
    upsertedResponseUrls: [],
    finishedStreams: [],
    deliveredErrors: [],
    cleanupCalls: [],
  };
  const activeBotConfig = {
    token: "token",
    encodingAesKey: "a".repeat(43),
    placeholderText: "处理中",
    streamExpireMs: 600000,
  };

  const dispatcher = createWecomBotParsedDispatcher({
    api: {
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
    cleanupExpiredBotStreams: (expireMs) => state.cleanupCalls.push(expireMs),
    getBotStream: () => null,
    buildWecomBotEncryptedResponse: ({ plainPayload }) => {
      state.encryptedPayloads.push(plainPayload);
      return JSON.stringify({ ok: true, plainPayload });
    },
    markInboundMessageSeen: () => true,
    buildWecomBotSessionId: (fromUser) => `wecom-bot:${fromUser}`,
    createBotStream: (streamId, content, options) => {
      state.createdStreams.push({ streamId, content, options });
    },
    upsertBotResponseUrlCache: (payload) => state.upsertedResponseUrls.push(payload),
    messageProcessLimiter: {
      execute(fn) {
        state.queuedTasks.push("execute");
        return Promise.resolve().then(fn);
      },
    },
    executeInboundTaskWithSessionQueue: async ({ sessionId, isBot, task }) => {
      state.queuedTasks.push({ sessionId, isBot });
      return task();
    },
    processBotInboundMessage: async (payload) => {
      state.processedMessages.push(payload);
    },
    deliverBotReplyText: async (payload) => {
      state.deliveredErrors.push(payload);
      return { ok: true };
    },
    finishBotStream: (streamId, content) => {
      state.finishedStreams.push({ streamId, content });
    },
    randomUuid: () => "uuid-fixed",
    ...overrides,
  });

  return {
    dispatcher,
    state,
    activeBotConfig,
  };
}

test("dispatchParsed handles stream-refresh and returns encrypted stream payload", async () => {
  const { dispatcher, state, activeBotConfig } = createDispatcher({
    getBotStream: () => ({
      content: "增量内容",
      finished: false,
      msgItem: [{ msgtype: "image" }],
      feedbackId: "fb-1",
    }),
  });
  const { res, getHeader } = createResponseMock();

  const handled = await dispatcher({
    parsed: {
      kind: "stream-refresh",
      streamId: "stream-1",
      feedbackId: "",
    },
    res,
    timestamp: "1",
    nonce: "2",
    botConfig: activeBotConfig,
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(getHeader("content-type"), "application/json; charset=utf-8");
  assert.equal(state.cleanupCalls.length, 1);
  assert.equal(state.encryptedPayloads.length, 1);
  assert.equal(state.encryptedPayloads[0].msgtype, "stream");
  assert.equal(state.encryptedPayloads[0].stream.id, "stream-1");
  assert.equal(state.encryptedPayloads[0].stream.content, "增量内容");
  assert.equal(state.encryptedPayloads[0].stream.finish, false);
  assert.equal(state.encryptedPayloads[0].stream.feedback.id, "fb-1");
  assert.equal(state.encryptedPayloads[0].stream.msg_item.length, 1);
});

test("dispatchParsed handles message and schedules async bot processing", async () => {
  const { dispatcher, state, activeBotConfig } = createDispatcher();
  const { res, getHeader } = createResponseMock();

  const handled = await dispatcher({
    parsed: {
      kind: "message",
      fromUser: "dingxiang",
      content: "你好",
      msgType: "text",
      msgId: "msg-1",
      responseUrl: "https://example.com/response",
      chatId: "chat-1",
      isGroupChat: true,
      imageUrls: [],
      fileUrl: "",
      fileName: "",
      quote: null,
      feedbackId: "fb-2",
    },
    res,
    timestamp: "1",
    nonce: "2",
    botConfig: activeBotConfig,
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(getHeader("content-type"), "application/json; charset=utf-8");
  assert.equal(state.createdStreams.length, 1);
  assert.equal(state.createdStreams[0].streamId, "stream_uuid-fixed");
  assert.equal(state.createdStreams[0].content, "处理中");
  assert.equal(state.upsertedResponseUrls.length, 1);
  assert.equal(state.upsertedResponseUrls[0].sessionId, "wecom-bot:dingxiang");
  assert.equal(state.upsertedResponseUrls[0].responseUrl, "https://example.com/response");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.queuedTasks[0], "execute");
  assert.deepEqual(state.queuedTasks[1], { sessionId: "wecom-bot:dingxiang", isBot: true });
  assert.equal(state.processedMessages.length, 1);
  assert.equal(state.processedMessages[0].streamId, "stream_uuid-fixed");
  assert.equal(state.processedMessages[0].fromUser, "dingxiang");
});

test("dispatchParsed returns success and skips duplicate bot message", async () => {
  const { dispatcher, state, activeBotConfig } = createDispatcher({
    markInboundMessageSeen: () => false,
  });
  const { res, getBody, getHeader } = createResponseMock();

  const handled = await dispatcher({
    parsed: {
      kind: "message",
      fromUser: "dingxiang",
      content: "你好",
      msgType: "text",
      msgId: "msg-dup",
    },
    res,
    timestamp: "1",
    nonce: "2",
    botConfig: activeBotConfig,
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(getHeader("content-type"), "text/plain; charset=utf-8");
  assert.equal(getBody(), "success");
  assert.equal(state.createdStreams.length, 0);
  assert.equal(state.queuedTasks.length, 0);
});

test("dispatchParsed returns false for unknown parsed kind", async () => {
  const { dispatcher } = createDispatcher();
  const { res } = createResponseMock();

  const handled = await dispatcher({
    parsed: { kind: "unknown" },
    res,
    timestamp: "1",
    nonce: "2",
  });

  assert.equal(handled, false);
  assert.equal(res.writableEnded, false);
});
