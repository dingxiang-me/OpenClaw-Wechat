import assert from "node:assert/strict";
import test from "node:test";

import { applyWecomAgentInboundGuards } from "../src/wecom/agent-inbound-guards.js";

function createCommon(overrides = {}) {
  const sent = [];
  const handled = [];
  const common = {
    api: { logger: { info() {}, warn() {} } },
    config: { accountId: "default" },
    accountId: "default",
    fromUser: "u1",
    msgType: "text",
    isGroupChat: false,
    chatId: "",
    commandBody: "hello",
    normalizedFromUser: "u1",
    groupChatPolicy: { enabled: true, triggerMode: "direct", mentionPatterns: ["@bot"] },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => String(text),
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/help", "/status", "/reset", "/clear"],
      rejectMessage: "command blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({
      allowFrom: ["u1"],
      rejectMessage: "sender blocked",
    }),
    resolveWecomDmPolicy: () => ({
      mode: "open",
      allowFrom: [],
      rejectMessage: "dm blocked",
    }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    COMMANDS: {},
    sendTextToUser: async (text) => {
      sent.push(String(text));
    },
    commandHandlerContext: {
      onHandled: () => handled.push("ok"),
    },
  };
  return {
    input: { ...common, ...overrides },
    sent,
    handled,
  };
}

test("applyWecomAgentInboundGuards blocks disabled group processing", async () => {
  const { input } = createCommon({
    isGroupChat: true,
    groupChatPolicy: { enabled: false, triggerMode: "mention" },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
});

test("applyWecomAgentInboundGuards strips mentions and returns command body", async () => {
  const { input } = createCommon({
    isGroupChat: true,
    commandBody: "@bot hello",
    shouldStripWecomGroupMentions: () => true,
    stripWecomGroupMentions: () => "hello",
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, true);
  assert.equal(result.commandBody, "hello");
});

test("applyWecomAgentInboundGuards blocks sender by allowFrom", async () => {
  const { input, sent } = createCommon({
    resolveWecomAllowFromPolicy: () => ({
      allowFrom: ["u2"],
      rejectMessage: "not allowed",
    }),
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, ["not allowed"]);
});

test("applyWecomAgentInboundGuards blocks unauthorized group sender by groupAllowFrom", async () => {
  const { input, sent } = createCommon({
    isGroupChat: true,
    chatId: "roomA",
    normalizedFromUser: "u1",
    groupChatPolicy: {
      enabled: true,
      policyMode: "allowlist",
      triggerMode: "direct",
      allowFrom: ["u2"],
      rejectMessage: "group blocked",
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, ["group blocked"]);
});

test("applyWecomAgentInboundGuards allows group sender when policyMode is open", async () => {
  const { input } = createCommon({
    isGroupChat: true,
    chatId: "roomA",
    normalizedFromUser: "u1",
    groupChatPolicy: {
      enabled: true,
      policyMode: "open",
      triggerMode: "direct",
      allowFrom: ["u2"],
      rejectMessage: "group blocked",
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, true);
});

test("applyWecomAgentInboundGuards blocks group sender when policyMode is deny", async () => {
  const { input, sent } = createCommon({
    isGroupChat: true,
    chatId: "roomA",
    normalizedFromUser: "u1",
    groupChatPolicy: {
      enabled: false,
      policyMode: "deny",
      triggerMode: "direct",
      rejectMessage: "group deny",
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
});

test("applyWecomAgentInboundGuards translates /clear and handles command", async () => {
  const { input, handled } = createCommon({
    commandBody: "/clear now",
    extractLeadingSlashCommand: (text) => {
      if (String(text).startsWith("/clear")) return "/clear";
      if (String(text).startsWith("/reset")) return "/reset";
      return "";
    },
    COMMANDS: {
      "/reset": async ({ onHandled }) => {
        onHandled();
      },
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.equal(result.commandHandled, true);
  assert.deepEqual(handled, ["ok"]);
});

test("applyWecomAgentInboundGuards translates /new to /reset and respects /new allowlist", async () => {
  const { input, handled } = createCommon({
    commandBody: "/new topic",
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/new"],
      rejectMessage: "command blocked",
    }),
    extractLeadingSlashCommand: (text) => {
      if (String(text).startsWith("/new")) return "/new";
      if (String(text).startsWith("/reset")) return "/reset";
      return "";
    },
    COMMANDS: {
      "/reset": async ({ onHandled }) => {
        onHandled();
      },
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.equal(result.commandHandled, true);
  assert.equal(result.commandBody.startsWith("/reset"), true);
  assert.deepEqual(handled, ["ok"]);
});

test("applyWecomAgentInboundGuards blocks unallowed command for non-admin", async () => {
  const { input, sent } = createCommon({
    commandBody: "/status",
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/help"],
      rejectMessage: "command denied",
    }),
    extractLeadingSlashCommand: () => "/status",
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, ["command denied"]);
});

test("applyWecomAgentInboundGuards blocks direct message when dm policy is deny", async () => {
  const { input, sent } = createCommon({
    resolveWecomDmPolicy: () => ({
      mode: "deny",
      allowFrom: [],
      rejectMessage: "dm deny",
    }),
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, ["dm deny"]);
});

test("applyWecomAgentInboundGuards creates pairing challenge for unknown DM sender", async () => {
  const sent = [];
  const { input } = createCommon({
    fromUser: "DingXiang",
    normalizedFromUser: "dingxiang",
    resolveWecomDmPolicy: () => ({
      mode: "pairing",
      allowFrom: [],
      rejectMessage: "need pairing",
    }),
    resolveWecomAllowFromPolicy: () => ({
      allowFrom: ["*"],
      rejectMessage: "blocked",
    }),
    sendTextToUser: async (text) => {
      sent.push(String(text));
    },
    api: {
      logger: { info() {}, warn() {} },
      runtime: {
        channel: {
          pairing: {
            readAllowFromStore: async () => [],
            upsertPairingRequest: async () => ({ code: "ABCD12", created: true }),
            buildPairingReply: ({ code }) => `pairing:${code}`,
          },
        },
      },
    },
  });
  const result = await applyWecomAgentInboundGuards(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sent, ["pairing:ABCD12"]);
});
