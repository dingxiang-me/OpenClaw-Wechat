import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWecomBotInboundContextPayload,
  buildWecomBotInboundEnvelopePayload,
} from "../src/wecom/bot-context.js";

test("buildWecomBotInboundEnvelopePayload builds direct payload", () => {
  const payload = buildWecomBotInboundEnvelopePayload({
    fromUser: "dingxiang",
    chatId: "",
    isGroupChat: false,
    messageText: "hello bot",
    timestamp: 123,
  });
  assert.deepEqual(payload, {
    channel: "WeCom Bot",
    from: "dingxiang",
    timestamp: 123,
    body: "hello bot",
    chatType: "direct",
    sender: {
      name: "dingxiang",
      id: "dingxiang",
    },
  });
});

test("buildWecomBotInboundContextPayload builds group payload with defaults", () => {
  const payload = buildWecomBotInboundContextPayload({
    body: "formatted",
    messageText: "raw",
    originalContent: "orig",
    commandBody: "cmd",
    fromAddress: "wecom-bot:dingxiang",
    sessionId: "wecom-bot:dingxiang",
    isGroupChat: true,
    chatId: "room-1",
    fromUser: "dingxiang",
    msgId: "",
    timestamp: 456,
  });
  assert.equal(payload.Body, "formatted");
  assert.equal(payload.BodyForAgent, "raw");
  assert.equal(payload.RawBody, "orig");
  assert.equal(payload.CommandBody, "cmd");
  assert.equal(payload.From, "wecom-bot:dingxiang");
  assert.equal(payload.To, "wecom-bot:dingxiang");
  assert.equal(payload.SessionKey, "wecom-bot:dingxiang");
  assert.equal(payload.AccountId, "bot");
  assert.equal(payload.ChatType, "group");
  assert.equal(payload.ConversationLabel, "group:room-1");
  assert.equal(payload.SenderName, "dingxiang");
  assert.equal(payload.SenderId, "dingxiang");
  assert.equal(payload.Provider, "wecom");
  assert.equal(payload.Surface, "wecom-bot");
  assert.equal(payload.MessageSid, "wecom-bot-456");
  assert.equal(payload.Timestamp, 456);
  assert.equal(payload.OriginatingChannel, "wecom");
  assert.equal(payload.OriginatingTo, "wecom-bot:dingxiang");
});
