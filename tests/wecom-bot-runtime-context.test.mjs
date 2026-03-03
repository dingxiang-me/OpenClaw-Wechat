import assert from "node:assert/strict";
import test from "node:test";

import { prepareWecomBotRuntimeContext } from "../src/wecom/bot-runtime-context.js";

function createRuntimeMocks() {
  const recordedSessions = [];
  const activities = [];
  return {
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_store, { agentId }) => `/tmp/store/${agentId || "main"}`,
          recordInboundSession: async (payload) => {
            recordedSessions.push(payload);
          },
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({ envelope: true }),
          formatInboundEnvelope: (payload) => ({ ...payload, formatted: true }),
          finalizeInboundContext: (payload) => ({ ...payload, SessionId: "runtime-session-1" }),
        },
        activity: {
          record: (payload) => activities.push(payload),
        },
      },
    },
    recordedSessions,
    activities,
  };
}

test("prepareWecomBotRuntimeContext builds route/context and records session", async () => {
  const logs = [];
  const { runtime, recordedSessions, activities } = createRuntimeMocks();
  const result = await prepareWecomBotRuntimeContext({
    api: {
      logger: {
        info: (line) => logs.push(String(line)),
        warn: (line) => logs.push(String(line)),
      },
    },
    runtime,
    cfg: { session: { store: "default" } },
    baseSessionId: "wecom-bot:user-a",
    fromUser: "user-a",
    chatId: "chat-1",
    isGroupChat: false,
    msgId: "msg-1",
    messageText: "hello",
    commandBody: "hello",
    originalContent: "hello",
    fromAddress: "wecom-bot:user-a",
    groupChatPolicy: { mentionPatterns: ["@bot"] },
    dynamicAgentPolicy: { workspaceTemplate: "tpl" },
    isAdminUser: false,
    resolveWecomAgentRoute: () => ({ agentId: "main", sessionKey: "wecom-bot:user-a" }),
    seedDynamicAgentWorkspace: async () => {},
    buildWecomBotInboundEnvelopePayload: ({ messageText }) => ({ text: messageText }),
    buildWecomBotInboundContextPayload: ({ messageText, sessionId }) => ({ messageText, sessionId }),
  });

  assert.equal(result.routedAgentId, "main");
  assert.equal(result.sessionId, "wecom-bot:user-a");
  assert.equal(result.storePath, "/tmp/store/main");
  assert.equal(result.sessionRuntimeId, "runtime-session-1");
  assert.equal(recordedSessions.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].channel, "wecom");
  assert.ok(logs.some((line) => line.includes("wecom(bot): routed agent=main")));
});

test("prepareWecomBotRuntimeContext swallows workspace seed failure", async () => {
  const warns = [];
  const { runtime } = createRuntimeMocks();
  const result = await prepareWecomBotRuntimeContext({
    api: {
      logger: {
        info() {},
        warn: (line) => warns.push(String(line)),
      },
    },
    runtime,
    cfg: { session: { store: "default" } },
    baseSessionId: "wecom-bot:user-b",
    fromUser: "user-b",
    chatId: "",
    isGroupChat: false,
    msgId: "msg-2",
    messageText: "hello",
    commandBody: "hello",
    originalContent: "hello",
    fromAddress: "wecom-bot:user-b",
    groupChatPolicy: {},
    dynamicAgentPolicy: {},
    isAdminUser: false,
    resolveWecomAgentRoute: () => ({ agentId: "main", sessionKey: "wecom-bot:user-b" }),
    seedDynamicAgentWorkspace: async () => {
      throw new Error("seed failed");
    },
    buildWecomBotInboundEnvelopePayload: ({ messageText }) => ({ text: messageText }),
    buildWecomBotInboundContextPayload: ({ messageText, sessionId }) => ({ messageText, sessionId }),
  });

  assert.equal(result.sessionId, "wecom-bot:user-b");
  assert.equal(warns.length > 0, true);
  assert.ok(warns.some((line) => line.includes("workspace seed failed")));
});
