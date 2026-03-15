import assert from "node:assert/strict";
import test from "node:test";

import { applyWecomBotCommandAndSenderGuard, applyWecomBotGroupChatGuard } from "../src/wecom/bot-inbound-guards.js";

test("applyWecomBotGroupChatGuard rejects disabled group processing", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    groupChatPolicy: { enabled: false },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => text,
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "当前群聊消息处理未启用。");
});

test("applyWecomBotGroupChatGuard rejects untriggered mention mode with hint", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    groupChatPolicy: { enabled: true, triggerMode: "mention" },
    shouldTriggerWecomGroupResponse: () => false,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => text,
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "请先 @ 机器人后再发送消息。");
});

test("applyWecomBotGroupChatGuard strips mentions when configured", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "@bot hello",
    groupChatPolicy: { enabled: true, triggerMode: "mention", mentionPatterns: ["@bot"] },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => true,
    stripWecomGroupMentions: () => "hello",
  });
  assert.equal(result.ok, true);
  assert.equal(result.commandBody, "hello");
});

test("applyWecomBotCommandAndSenderGuard blocks unauthorized sender", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "u1",
    isGroupChat: false,
    resolveWecomCommandPolicy: () => ({ enabled: true, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u2"], rejectMessage: "当前账号未授权，请联系管理员。" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "当前账号未授权，请联系管理员。");
});

test("applyWecomBotCommandAndSenderGuard blocks unauthorized group sender by groupAllowFrom", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    accountId: "default",
    fromUser: "u1",
    chatId: "roomA",
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "u1",
    groupChatPolicy: {
      enabled: true,
      policyMode: "allowlist",
      triggerMode: "mention",
      allowFrom: ["u2"],
      rejectMessage: "group blocked",
    },
    resolveWecomCommandPolicy: () => ({ enabled: true, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "当前账号未授权，请联系管理员。" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "group blocked");
});

test("applyWecomBotCommandAndSenderGuard allows group sender when policyMode is open", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    accountId: "default",
    fromUser: "u1",
    chatId: "roomA",
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "u1",
    groupChatPolicy: {
      enabled: true,
      policyMode: "open",
      triggerMode: "mention",
      allowFrom: ["u2"],
      rejectMessage: "group blocked",
    },
    resolveWecomCommandPolicy: () => ({ enabled: true, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "当前账号未授权，请联系管理员。" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, true);
});

test("applyWecomBotCommandAndSenderGuard translates /clear to /reset", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    msgType: "text",
    commandBody: "/clear now",
    normalizedFromUser: "u1",
    isGroupChat: false,
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/clear", "/reset"],
      rejectMessage: "cmd blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: (text) => {
      if (text.startsWith("/clear")) return "/clear";
      if (text.startsWith("/reset")) return "/reset";
      return "";
    },
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, true);
  assert.equal(result.commandBody.startsWith("/reset"), true);
});

test("applyWecomBotCommandAndSenderGuard translates /new to /reset and allows /new allowlist", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    msgType: "text",
    commandBody: "/new chat",
    normalizedFromUser: "u1",
    isGroupChat: false,
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/new"],
      rejectMessage: "cmd blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: (text) => {
      if (text.startsWith("/new")) return "/new";
      if (text.startsWith("/reset")) return "/reset";
      return "";
    },
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, true);
  assert.equal(result.commandBody.startsWith("/reset"), true);
});

test("applyWecomBotCommandAndSenderGuard handles /help and /status directly", async () => {
  const common = {
    api: {},
    fromUser: "u1",
    msgType: "text",
    normalizedFromUser: "u1",
    isGroupChat: false,
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/help", "/status"],
      rejectMessage: "cmd blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    buildWecomBotHelpText: () => "help text",
    buildWecomBotStatusText: () => "status text",
  };

  const helpResult = await applyWecomBotCommandAndSenderGuard({
    ...common,
    commandBody: "/help",
    extractLeadingSlashCommand: () => "/help",
  });
  assert.equal(helpResult.ok, false);
  assert.equal(helpResult.finishText, "help text");

  const statusResult = await applyWecomBotCommandAndSenderGuard({
    ...common,
    commandBody: "/status",
    extractLeadingSlashCommand: () => "/status",
  });
  assert.equal(statusResult.ok, false);
  assert.equal(statusResult.finishText, "status text");
});

test("applyWecomBotCommandAndSenderGuard blocks direct message when dm policy deny", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    isGroupChat: false,
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "u1",
    resolveWecomCommandPolicy: () => ({ enabled: false, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    resolveWecomDmPolicy: () => ({ mode: "deny", allowFrom: [], rejectMessage: "dm disabled" }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "dm disabled");
});

test("applyWecomBotCommandAndSenderGuard returns pairing reply when pairing challenge is created", async () => {
  const result = await applyWecomBotCommandAndSenderGuard({
    api: {
      runtime: {
        channel: {
          pairing: {
            readAllowFromStore: async () => [],
            upsertPairingRequest: async () => ({ code: "XYZ789", created: true }),
            buildPairingReply: ({ code }) => `pairing:${code}`,
          },
        },
      },
    },
    accountId: "default",
    fromUser: "dingxiang",
    isGroupChat: false,
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "dingxiang",
    resolveWecomCommandPolicy: () => ({ enabled: false, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["*"], rejectMessage: "blocked" }),
    resolveWecomDmPolicy: () => ({ mode: "pairing", allowFrom: [], rejectMessage: "need pairing" }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes("*") || allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "pairing:XYZ789");
});
