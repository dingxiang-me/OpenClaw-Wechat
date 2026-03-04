import assert from "node:assert/strict";
import test from "node:test";

import {
  bindSessionKeyToAgent,
  buildDeterministicWecomAgentId,
  extractWecomMentionCandidates,
  resolveWecomAgentRoute,
} from "../src/core/agent-routing.js";
import {
  buildWecomBotMixedPayload,
  extractWecomXmlInboundEnvelope,
  parseWecomBotInboundMessage,
} from "../src/wecom/webhook-adapter.js";

function createRuntimeMock(baseRoute) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({ ...baseRoute }),
      },
    },
  };
}

test("resolveWecomAgentRoute applies user dynamic map and binds session key", () => {
  const runtime = createRuntimeMock({
    agentId: "main",
    sessionKey: "agent:main:wecom:alice",
    matchedBy: "default",
    accountId: "default",
  });
  const route = resolveWecomAgentRoute({
    runtime,
    cfg: {
      agents: {
        list: [{ id: "main" }, { id: "sales" }],
      },
    },
    channel: "wecom",
    accountId: "default",
    sessionKey: "wecom:alice",
    fromUser: "Alice",
    dynamicConfig: {
      enabled: true,
      userMap: { alice: "sales" },
      groupMap: {},
      mentionMap: {},
      forceAgentSessionKey: true,
    },
  });
  assert.equal(route.agentId, "sales");
  assert.equal(route.dynamicMatchedBy, "dynamic.user");
  assert.equal(route.sessionKey, "agent:sales:wecom:alice");
});

test("resolveWecomAgentRoute supports mention map in group chat", () => {
  const runtime = createRuntimeMock({
    agentId: "main",
    sessionKey: "agent:main:wecom:group:chat_1",
    matchedBy: "default",
    accountId: "default",
  });
  const route = resolveWecomAgentRoute({
    runtime,
    cfg: {
      agents: {
        list: [{ id: "main" }, { id: "helper" }],
      },
    },
    channel: "wecom",
    accountId: "default",
    sessionKey: "wecom:alice",
    fromUser: "Alice",
    chatId: "chat_1",
    isGroupChat: true,
    content: "@AI助手 帮我看下",
    mentionPatterns: ["@", "@AI助手"],
    dynamicConfig: {
      enabled: true,
      userMap: {},
      groupMap: {},
      mentionMap: { "ai助手": "helper" },
      preferMentionMap: true,
      forceAgentSessionKey: true,
    },
  });
  assert.equal(route.agentId, "helper");
  assert.equal(route.dynamicMatchedBy, "dynamic.mention");
  assert.equal(route.sessionKey, "agent:helper:wecom:alice");
});

test("resolveWecomAgentRoute supports deterministic mode", () => {
  const runtime = createRuntimeMock({
    agentId: "main",
    sessionKey: "agent:main:wecom:alice",
    matchedBy: "default",
    accountId: "default",
  });
  const route = resolveWecomAgentRoute({
    runtime,
    cfg: {
      agents: {
        list: [{ id: "main" }],
      },
    },
    channel: "wecom",
    accountId: "sales",
    sessionKey: "wecom:alice",
    fromUser: "Alice",
    dynamicConfig: {
      enabled: true,
      mode: "deterministic",
      deterministicPrefix: "wecom",
      autoProvision: true,
      allowUnknownAgentId: true,
      forceAgentSessionKey: true,
    },
  });
  assert.equal(route.dynamicMatchedBy, "dynamic.deterministic.user");
  assert.equal(route.allowUnknownAgentId, true);
  assert.equal(route.agentId.startsWith("wecom-dm-sales-alice-"), true);
  assert.equal(route.sessionKey.startsWith(`agent:${route.agentId}:wecom:alice`), true);
});

test("buildDeterministicWecomAgentId is stable for same input", () => {
  const a = buildDeterministicWecomAgentId({
    accountId: "Sales",
    fromUser: "Alice",
    isGroupChat: false,
    prefix: "wecom",
  });
  const b = buildDeterministicWecomAgentId({
    accountId: "sales",
    fromUser: "Alice",
    isGroupChat: false,
    prefix: "wecom",
  });
  assert.equal(a, b);
});

test("extractWecomMentionCandidates keeps mention names", () => {
  const mentions = extractWecomMentionCandidates("你好 @AI助手 请看下 @ops_bot", ["@", "@AI助手"]);
  assert.deepEqual(mentions.sort(), ["ai助手", "ops_bot"]);
});

test("bindSessionKeyToAgent replaces existing agent prefix", () => {
  assert.equal(bindSessionKeyToAgent("agent:main:wecom:alice", "sales"), "agent:sales:wecom:alice");
  assert.equal(bindSessionKeyToAgent("wecom:alice", "sales"), "agent:sales:wecom:alice");
});

test("buildWecomBotMixedPayload returns mixed msg_item for media", () => {
  const payload = buildWecomBotMixedPayload({
    text: "这是结果",
    mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
  });
  assert.equal(payload.msgtype, "mixed");
  assert.equal(payload.mixed.msg_item.length, 3);
  assert.equal(payload.mixed.msg_item[0].msgtype, "text");
  assert.equal(payload.mixed.msg_item[1].msgtype, "image");
});

test("parseWecomBotInboundMessage parses mixed text and image url", () => {
  const parsed = parseWecomBotInboundMessage({
    msgtype: "mixed",
    msgid: "m1",
    from: { userid: "dingxiang" },
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "hello" } },
        { msgtype: "image", image: { url: "https://example.com/a.png" } },
      ],
    },
  });
  assert.equal(parsed.kind, "message");
  assert.equal(parsed.msgType, "mixed");
  assert.equal(parsed.content, "hello\n[图片]");
  assert.deepEqual(parsed.imageUrls, ["https://example.com/a.png"]);
});

test("parseWecomBotInboundMessage parses file payload", () => {
  const parsed = parseWecomBotInboundMessage({
    msgtype: "file",
    msgid: "f1",
    from: { userid: "dingxiang" },
    file: {
      url: "https://example.com/demo.pdf",
      name: "demo.pdf",
    },
  });
  assert.equal(parsed.kind, "message");
  assert.equal(parsed.msgType, "file");
  assert.equal(parsed.fileUrl, "https://example.com/demo.pdf");
  assert.equal(parsed.fileName, "demo.pdf");
  assert.match(parsed.content, /\[文件\]/);
});

test("parseWecomBotInboundMessage parses voice payload url/media metadata", () => {
  const parsed = parseWecomBotInboundMessage({
    msgtype: "voice",
    msgid: "v1",
    from: { userid: "dingxiang" },
    voice: {
      url: "https://example.com/voice.amr",
      media_id: "media-voice-1",
      content_type: "audio/amr",
      content: "",
    },
  });
  assert.equal(parsed.kind, "message");
  assert.equal(parsed.msgType, "voice");
  assert.equal(parsed.voiceUrl, "https://example.com/voice.amr");
  assert.equal(parsed.voiceMediaId, "media-voice-1");
  assert.equal(parsed.voiceContentType, "audio/amr");
});

test("parseWecomBotInboundMessage parses quote metadata", () => {
  const parsed = parseWecomBotInboundMessage({
    msgtype: "text",
    msgid: "q1",
    from: { userid: "dingxiang" },
    text: { content: "新消息" },
    quote: {
      msgtype: "text",
      text: { content: "被引用消息" },
    },
  });
  assert.equal(parsed.kind, "message");
  assert.equal(parsed.msgType, "text");
  assert.equal(parsed.quote?.msgType, "text");
  assert.equal(parsed.quote?.content, "被引用消息");
});

test("parseWecomBotInboundMessage parses feedback id", () => {
  const parsed = parseWecomBotInboundMessage({
    msgtype: "text",
    msgid: "fb1",
    from: { userid: "dingxiang" },
    text: { content: "hello" },
    feedback: { id: "feedback-001" },
  });
  assert.equal(parsed.kind, "message");
  assert.equal(parsed.feedbackId, "feedback-001");

  const refresh = parseWecomBotInboundMessage({
    msgtype: "stream",
    stream: { id: "stream-x", feedback: { id: "feedback-002" } },
  });
  assert.equal(refresh.kind, "stream-refresh");
  assert.equal(refresh.feedbackId, "feedback-002");
});

test("extractWecomXmlInboundEnvelope normalizes fields", () => {
  const envelope = extractWecomXmlInboundEnvelope({
    MsgType: "text",
    FromUserName: "dingxiang",
    ChatId: "chat_1",
    MsgId: "123",
    Content: "hello",
  });
  assert.equal(envelope.msgType, "text");
  assert.equal(envelope.fromUser, "dingxiang");
  assert.equal(envelope.chatId, "chat_1");
  assert.equal(envelope.msgId, "123");
  assert.equal(envelope.content, "hello");
});
