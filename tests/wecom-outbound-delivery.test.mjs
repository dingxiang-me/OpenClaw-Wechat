import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotReplyDeliverer } from "../src/wecom/outbound-delivery.js";

function createApiMock() {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function createDeliverer(overrides = {}) {
  const responseUrlCache = new Map();
  const finishedStreams = [];
  const sentMessages = [];

  const base = {
    attachWecomProxyDispatcher: (_url, options) => options,
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: false,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({
      enabled: false,
      url: "",
      key: "",
      timeoutMs: 8000,
    }),
    resolveWecomObservabilityPolicy: () => ({ enabled: false, logPayloadMeta: true }),
    resolveWecomBotProxyConfig: () => "",
    resolveWecomBotConfig: () => ({
      longConnection: {
        enabled: false,
      },
      card: {
        enabled: false,
        mode: "markdown",
        responseUrlEnabled: true,
        webhookBotEnabled: true,
      },
    }),
    resolveWecomBotLongConnectionReplyContext: () => null,
    pushWecomBotLongConnectionStreamUpdate: async () => ({ ok: false, reason: "context-missing" }),
    buildWecomBotSessionId: (fromUser) => `wecom-bot:${String(fromUser ?? "").trim().toLowerCase()}`,
    upsertBotResponseUrlCache: ({ sessionId, responseUrl }) => {
      responseUrlCache.set(sessionId, {
        url: responseUrl,
        used: false,
      });
    },
    getBotResponseUrlCache: (sessionId) => responseUrlCache.get(sessionId) ?? null,
    markBotResponseUrlUsed: (sessionId) => {
      const row = responseUrlCache.get(sessionId);
      if (row) row.used = true;
    },
    createDeliveryTraceId: () => "trace-test",
    hasBotStream: (streamId) => streamId === "stream-ok",
    resolveActiveBotStreamId: () => "",
    finishBotStream: (streamId, content, options) => {
      finishedStreams.push({ streamId, content, options });
    },
    drainBotStreamMedia: () => [],
    getWecomConfig: () => ({
      accountId: "default",
      corpId: "ww-test",
      corpSecret: "secret",
      agentId: "1000002",
      outboundProxy: "",
    }),
    sendWecomText: async ({ toUser, text }) => {
      sentMessages.push({ toUser, text });
    },
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      contentType: "image/png",
    }),
  };

  return {
    ...createWecomBotReplyDeliverer({
      ...base,
      ...overrides,
    }),
    finishedStreams,
    sentMessages,
  };
}

test("deliverBotReplyText uses active_stream when available", async () => {
  const deliverer = createDeliverer();
  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "hello",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(result.deliveryPath, "active_stream");
  assert.equal(result.finalStatus, "ok");
  assert.deepEqual(deliverer.finishedStreams, [{ streamId: "stream-ok", content: "hello", options: { msgItem: [] } }]);
});

test("deliverBotReplyText prefers long_connection when reply context exists", async () => {
  const pushed = [];
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["long_connection", "active_stream", "agent_push"],
    }),
    resolveWecomBotLongConnectionReplyContext: () => ({
      accountId: "default",
      sessionId: "wecom-bot:dingxiang",
      streamId: "stream-longconn",
      msgId: "msg-001",
    }),
    pushWecomBotLongConnectionStreamUpdate: async (payload) => {
      pushed.push(payload);
      return { ok: true, mode: "long_connection" };
    },
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    accountId: "default",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-longconn",
    text: "hello over ws",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "long_connection");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].streamId, "stream-longconn");
  assert.equal(pushed[0].content, "hello over ws");
  assert.equal(pushed[0].finish, true);
});

test("deliverBotReplyText falls back to active_stream when long_connection reply push misses", async () => {
  const pushed = [];
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["long_connection", "active_stream", "response_url", "webhook_bot", "agent_push"],
    }),
    resolveWecomBotLongConnectionReplyContext: () => ({
      accountId: "default",
      sessionId: "wecom-bot:dingxiang",
      streamId: "stream-ok",
      msgId: "msg-002",
    }),
    pushWecomBotLongConnectionStreamUpdate: async (payload) => {
      pushed.push(payload);
      return { ok: false, reason: "connection-missing" };
    },
    hasBotStream: (streamId) => streamId === "stream-ok",
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    accountId: "default",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "fallback via active stream",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(result.finalStatus, "degraded");
  assert.equal(pushed.length, 1);
  assert.deepEqual(deliverer.finishedStreams, [
    { streamId: "stream-ok", content: "fallback via active stream", options: { msgItem: [] } },
  ]);
});

test("deliverBotReplyText falls back to agent_push with media links", async () => {
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    }),
    hasBotStream: () => false,
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "已完成",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "agent_push");
  assert.equal(result.deliveryPath, "agent_push");
  assert.equal(result.finalStatus, "degraded");
  assert.equal(result.attempts[0].status, "miss");
  assert.equal(result.attempts[result.attempts.length - 1].status, "ok");
  assert.equal(deliverer.sentMessages.length, 1);
  assert.match(deliverer.sentMessages[0].text, /媒体链接/);
  assert.match(deliverer.sentMessages[0].text, /https:\/\/example.com\/a\.png/);
});

test("deliverBotReplyText sends webhook media when webhook bot enabled", async () => {
  const webhookCalls = {
    text: [],
    image: [],
  };
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["active_stream", "webhook_bot", "agent_push"],
    }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({
      enabled: true,
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      key: "",
      timeoutMs: 8000,
    }),
    hasBotStream: () => false,
    resolveWebhookBotSendUrlFn: () => "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
    webhookSendTextFn: async (payload) => {
      webhookCalls.text.push(payload);
    },
    webhookSendImageFn: async (payload) => {
      webhookCalls.image.push(payload);
    },
    webhookSendFileBufferFn: async () => {},
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("image-binary"),
      contentType: "image/png",
    }),
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "这是结果",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "webhook_bot");
  assert.equal(webhookCalls.text.length, 1);
  assert.equal(webhookCalls.image.length, 1);
});

test("deliverBotReplyText sends card payload via response_url when bot card is enabled", async () => {
  const responsePayloads = [];
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["response_url", "agent_push"],
    }),
    hasBotStream: () => false,
    resolveWecomBotConfig: () => ({
      card: {
        enabled: true,
        mode: "markdown",
        title: "Bot 卡片",
        subtitle: "处理中",
        footer: "OpenClaw-Wechat",
        responseUrlEnabled: true,
        webhookBotEnabled: true,
      },
    }),
    fetchImpl: async (_url, options) => {
      responsePayloads.push(JSON.parse(String(options?.body ?? "{}")));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ errcode: 0, errmsg: "ok" }),
      };
    },
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    responseUrl: "https://example.com/response-url",
    text: "卡片正文内容",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "response_url");
  assert.equal(responsePayloads.length, 1);
  assert.equal(responsePayloads[0]?.msgtype, "markdown");
  assert.match(String(responsePayloads[0]?.markdown?.content ?? ""), /Bot 卡片/);
});

test("deliverBotReplyText can recover active stream by session id", async () => {
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-recovered",
    resolveActiveBotStreamId: (sessionId) =>
      sessionId === "wecom-bot:dingxiang" ? "stream-recovered" : "",
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "hello recovered",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.deepEqual(deliverer.finishedStreams, [
    { streamId: "stream-recovered", content: "hello recovered", options: { msgItem: [] } },
  ]);
});

test("deliverBotReplyText sends image msg_item via active_stream when stream exists", async () => {
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-ok",
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "媒体结果",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(deliverer.finishedStreams.length, 1);
  assert.equal(deliverer.finishedStreams[0].content, "媒体结果");
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.length, 1);
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.[0]?.msgtype, "image");
});

test("deliverBotReplyText falls back to media links when active_stream msg_item build fails", async () => {
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-ok",
    fetchMediaFromUrl: async () => {
      throw new Error("download failed");
    },
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "媒体结果",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(deliverer.finishedStreams.length, 1);
  assert.match(deliverer.finishedStreams[0].content, /媒体链接/);
  assert.match(deliverer.finishedStreams[0].content, /https:\/\/example.com\/a\.png/);
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.length, 0);
});

test("deliverBotReplyText falls back to media links when image format is unsupported", async () => {
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-ok",
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("not-a-jpg-or-png"),
      contentType: "application/octet-stream",
    }),
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(deliverer.finishedStreams.length, 1);
  assert.match(deliverer.finishedStreams[0].content, /媒体链接/);
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.length, 0);
});

test("deliverBotReplyText consumes queued stream media when final payload has no media", async () => {
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-ok",
    drainBotStreamMedia: (streamId) => {
      if (streamId !== "stream-ok") return [];
      return [{ url: "https://example.com/queued.png", mediaType: "image" }];
    },
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "使用队列媒体",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(deliverer.finishedStreams.length, 1);
  assert.equal(deliverer.finishedStreams[0].content, "使用队列媒体");
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.length, 1);
});

test("deliverBotReplyText packs local workspace image into active_stream msg_item", async () => {
  const fetched = [];
  const deliverer = createDeliverer({
    hasBotStream: (streamId) => streamId === "stream-ok",
    extractWorkspacePathsFromText: () => ["/workspace/output/chart.png"],
    resolveWorkspacePathToHost: ({ workspacePath, agentId }) =>
      workspacePath === "/workspace/output/chart.png" && agentId === "agent-sales"
        ? "/tmp/openclaw/agent-sales/chart.png"
        : "",
    statImpl: async (path) => ({
      isFile: () => path === "/tmp/openclaw/agent-sales/chart.png",
    }),
    fetchMediaFromUrl: async (mediaUrl) => {
      fetched.push(mediaUrl);
      return {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        contentType: "image/png",
      };
    },
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    accountId: "sales",
    sessionId: "wecom-bot:sales:dingxiang",
    streamId: "stream-ok",
    routeAgentId: "agent-sales",
    text: "请查看图表：/workspace/output/chart.png",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.deepEqual(fetched, ["/tmp/openclaw/agent-sales/chart.png"]);
  assert.equal(deliverer.finishedStreams.length, 1);
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.length, 1);
  assert.equal(deliverer.finishedStreams[0].options?.msgItem?.[0]?.msgtype, "image");
});

test("deliverBotReplyText sends markdown webhook reply and MEDIA directives without leaking directive text", async () => {
  const webhookCalls = {
    text: [],
    markdown: [],
    image: [],
  };
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["webhook_bot"],
    }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({
      enabled: true,
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      key: "",
      timeoutMs: 8000,
    }),
    resolveWecomReplyFormatPolicy: () => ({
      mode: "markdown",
    }),
    hasBotStream: () => false,
    webhookSendTextFn: async (payload) => {
      webhookCalls.text.push(payload);
    },
    webhookSendImageFn: async (payload) => {
      webhookCalls.image.push(payload);
    },
    webhookSendFileBufferFn: async () => {},
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("image-binary"),
      contentType: "image/png",
    }),
    resolveWecomBotConfig: () => ({
      longConnection: {
        enabled: false,
      },
      card: {
        enabled: false,
        mode: "markdown",
        responseUrlEnabled: true,
        webhookBotEnabled: true,
      },
    }),
    resolveWebhookBotSendUrlFn: () => "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "标题",
    rawText: "## 标题\nMEDIA: https://example.com/chart.png",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "webhook_bot");
  assert.equal(webhookCalls.text.length, 1);
  assert.equal(webhookCalls.text[0].content, "标题");
  assert.equal(webhookCalls.image.length, 1);
});
