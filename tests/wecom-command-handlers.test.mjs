import assert from "node:assert/strict";
import test from "node:test";

import { createWecomCommandHandlers } from "../src/wecom/command-handlers.js";
import { buildWecomSessionId } from "../src/core.js";
import { buildWecomBotSessionId } from "../src/wecom/runtime-utils.js";

function createHandlers(overrides = {}) {
  const sent = [];
  const handlers = createWecomCommandHandlers({
    sendWecomText: async (payload) => {
      sent.push(payload);
    },
    getWecomConfig: () => ({
      accountId: "default",
      corpId: "ww1",
      corpSecret: "s",
      agentId: "1000002",
      callbackToken: "token",
      callbackAesKey: "aes",
      outboundProxy: "",
      webhookPath: "/wecom/callback",
      tools: { doc: true },
    }),
    listWecomAccountIds: () => ["default"],
    listWebhookTargetAliases: () => ["ops"],
    listAllWebhookTargetAliases: () => ["ops", "alerts"],
    resolveWecomVoiceTranscriptionConfig: () => ({ enabled: true, provider: "local-whisper", model: "base", modelPath: "" }),
    inspectWecomVoiceTranscriptionRuntime: async () => ({
      resolvedCommand: "whisper",
      commandCandidates: ["whisper"],
      ffmpegEnabled: true,
      ffmpegAvailable: true,
      issues: [],
    }),
    resolveWecomCommandPolicy: () => ({ enabled: true, allowlist: ["/help"], adminUsers: ["u1"] }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"] }),
    resolveWecomDmPolicy: () => ({ mode: "open", allowFrom: [] }),
    resolveWecomGroupChatPolicy: () => ({ enabled: true, triggerMode: "mention", triggerKeywords: [] }),
    resolveWecomTextDebouncePolicy: () => ({ enabled: true, windowMs: 500, maxBatch: 3 }),
    resolveWecomReplyStreamingPolicy: () => ({ enabled: true, minChars: 40, minIntervalMs: 800 }),
    resolveWecomDeliveryFallbackPolicy: () => ({ enabled: true, order: ["active_stream", "agent_push"] }),
    resolveWecomPendingReplyPolicy: () => ({ enabled: true, maxRetries: 3, retryBackoffMs: 15000, expireMs: 600000 }),
    resolveWecomQuotaTrackingPolicy: () => ({ enabled: true }),
    resolveWecomReasoningPolicy: () => ({ mode: "append", title: "内部推理", maxChars: 600 }),
    resolveWecomReplyFormatPolicy: () => ({ mode: "markdown" }),
    resolveWecomStreamManagerPolicy: () => ({ enabled: true, maxConcurrentPerSession: 1 }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({ enabled: true }),
    resolveWecomDynamicAgentPolicy: () => ({ enabled: true, mode: "manual", userMap: { u1: "main" }, groupMap: {} }),
    resolveWecomBotConfig: () => ({ webhookPath: "/wecom/bot/callback" }),
    buildWecomSessionId,
    buildWecomBotSessionId,
    getWecomReliableDeliverySnapshot: ({ mode, sessionId }) => ({
      account: {
        accountId: "default",
        replyWindowState: "reply_window_open",
        proactiveQuotaState: "proactive_quota_available",
        pendingCount: 1,
      },
      session: {
        mode,
        sessionId,
        replyWindowState: "reply_window_open",
        pendingCount: 1,
        lastFailureReason: "rejected_transport fetch failed",
      },
    }),
    getWecomObservabilityMetrics: () => ({ inboundTotal: 3, deliveryTotal: 2, deliverySuccess: 2, deliveryFailed: 0, errorsTotal: 0 }),
    pluginVersion: "0.5.3",
    ...overrides,
  });
  return { handlers, sent };
}

test("/help command sends help text", async () => {
  const { handlers, sent } = createHandlers();
  await handlers.COMMANDS["/help"]({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    corpId: "ww1",
    corpSecret: "s",
    agentId: "1000002",
    proxyUrl: "",
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/help/);
  assert.match(sent[0].text, /AI 助手使用帮助/);
});

test("/status command sends status text", async () => {
  const { handlers, sent } = createHandlers();
  await handlers.COMMANDS["/status"]({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    corpId: "ww1",
    corpSecret: "s",
    agentId: "1000002",
    accountId: "default",
    proxyUrl: "",
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /插件版本：0\.5\.3/);
  assert.match(sent[0].text, /收消息：Agent 回调已配置/);
  assert.match(sent[0].text, /命名 Webhook 目标/);
  assert.match(sent[0].text, /命令 whisper/);
  assert.match(sent[0].text, /路由策略：动态 Agent/);
  assert.match(sent[0].text, /微信插件入口联系人：Agent 模式可见/);
  assert.match(sent[0].text, /可靠投递：窗口 open \/ 主动发送 available \/ Pending Reply 1 条/);
  assert.match(sent[0].text, /当前会话：窗口 open \/ 待补发 1 条/);
  assert.match(sent[0].text, /推理展示：合并到最终回复/);
  assert.match(sent[0].text, /最终回复格式：优先 markdown/);
});

test("/status command renders current group authorization summary", async () => {
  const { handlers, sent } = createHandlers({
    resolveWecomGroupChatPolicy: () => ({
      enabled: true,
      policyMode: "allowlist",
      policySource: "account.group.policy",
      triggerSource: "account.group.requireMention",
      triggerMode: "mention",
      triggerKeywords: [],
      allowFrom: ["alice", "bob"],
      allowFromSource: "account.group.allowFrom",
      rejectMessage: "当前群仅限值班同学触发。",
      rejectMessageSource: "account.group.rejectMessage",
      matchedGroupOverride: true,
      configuredGroupCount: 2,
    }),
  });
  await handlers.COMMANDS["/status"]({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    corpId: "ww1",
    corpSecret: "s",
    agentId: "1000002",
    accountId: "default",
    proxyUrl: "",
    chatId: "roomA",
    isGroupChat: true,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /当前群ID：roomA/);
  assert.match(sent[0].text, /群聊授权：白名单（2 个成员）（当前群已应用专属规则）/);
  assert.match(sent[0].text, /群规则来源：准入=当前账号当前群覆盖 \/ 触发=当前账号当前群覆盖 \/ 成员=当前账号当前群覆盖 \/ 拒绝文案=当前账号当前群覆盖/);
  assert.match(sent[0].text, /群拒绝文案：当前群仅限值班同学触发。/);
});

test("buildWecomBotStatusText renders bot webhook and features", () => {
  const { handlers } = createHandlers();
  const text = handlers.buildWecomBotStatusText({ logger: {} }, "dingxiang");
  assert.match(text, /企业微信 AI 机器人/);
  assert.match(text, /收消息：缺少 Bot webhook 或长连接凭证|收消息：Bot/);
  assert.match(text, /Bot Webhook：\/wecom\/bot\/callback/);
  assert.match(text, /回包兜底链路/);
  assert.match(text, /企业微信 Bot 平台限制/);
  assert.match(text, /微信插件入口联系人：Bot 模式通常不显示/);
  assert.match(text, /可靠投递：窗口 open \/ 主动发送 available \/ Pending Reply 1 条/);
  assert.match(text, /推理展示：合并到最终回复/);
  assert.match(text, /最终回复格式：优先 markdown/);
});

test("buildWecomBotStatusText renders group authorization summary for current chat", () => {
  const { handlers } = createHandlers({
    resolveWecomGroupChatPolicy: () => ({
      enabled: true,
      policyMode: "allowlist",
      policySource: "channel.group.policy",
      triggerMode: "mention",
      allowFrom: ["ops"],
      allowFromSource: "channel.group.allowFrom",
      matchedGroupOverride: true,
      configuredGroupCount: 1,
    }),
  });
  const text = handlers.buildWecomBotStatusText(
    { logger: {} },
    "dingxiang",
    { accountId: "default", chatId: "roomB", isGroupChat: true },
  );
  assert.match(text, /当前群ID：roomB/);
  assert.match(text, /群聊授权：白名单（1 个成员）（当前群已应用专属规则）/);
});

test("/status command explains inactive group allowFrom under open policy", async () => {
  const { handlers, sent } = createHandlers({
    resolveWecomGroupChatPolicy: () => ({
      enabled: true,
      policyMode: "open",
      policySource: "channel.root.groupPolicy",
      triggerMode: "direct",
      allowFrom: ["ops"],
      allowFromSource: "channel.root.groupAllowFrom",
      matchedGroupOverride: false,
      configuredGroupCount: 0,
    }),
  });
  await handlers.COMMANDS["/status"]({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    corpId: "ww1",
    corpSecret: "s",
    agentId: "1000002",
    accountId: "default",
    proxyUrl: "",
    chatId: "roomA",
    isGroupChat: true,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /群聊授权：开放（open）/);
  assert.match(sent[0].text, /群成员白名单：已配置 1 个成员，但当前 open 模式不会限制触发/);
});

test("/status command renders deny group authorization summary", async () => {
  const { handlers, sent } = createHandlers({
    resolveWecomGroupChatPolicy: () => ({
      enabled: false,
      policyMode: "deny",
      triggerMode: "direct",
      allowFrom: [],
      matchedGroupOverride: false,
      configuredGroupCount: 0,
    }),
  });
  await handlers.COMMANDS["/status"]({
    api: { logger: { info() {}, warn() {}, error() {} } },
    fromUser: "dingxiang",
    corpId: "ww1",
    corpSecret: "s",
    agentId: "1000002",
    accountId: "default",
    proxyUrl: "",
    chatId: "roomA",
    isGroupChat: true,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /群聊授权：已关闭（deny）/);
});
