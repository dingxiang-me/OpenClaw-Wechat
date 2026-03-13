import assert from "node:assert/strict";
import test from "node:test";

import { createWecomCommandHandlers } from "../src/wecom/command-handlers.js";

function createHandlers(overrides = {}) {
  const sent = [];
  const handlers = createWecomCommandHandlers({
    sendWecomText: async (payload) => {
      sent.push(payload);
    },
    getWecomConfig: () => ({ accountId: "default", outboundProxy: "", webhookPath: "/wecom/bot/callback" }),
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
    resolveWecomStreamManagerPolicy: () => ({ enabled: true, maxConcurrentPerSession: 1 }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({ enabled: true }),
    resolveWecomDynamicAgentPolicy: () => ({ enabled: true, mode: "manual", userMap: { u1: "main" }, groupMap: {} }),
    resolveWecomBotConfig: () => ({ webhookPath: "/wecom/bot/callback" }),
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
    apiProxy: "https://wecom-proxy.example.com",
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/help/);
  assert.match(sent[0].text, /AI 助手使用帮助/);
  assert.equal(sent[0].apiProxy, "https://wecom-proxy.example.com");
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
  assert.match(sent[0].text, /命名 Webhook 目标/);
  assert.match(sent[0].text, /命令 whisper/);
  assert.match(sent[0].text, /微信插件入口联系人：Agent 模式可见/);
});

test("buildWecomBotStatusText renders bot webhook and features", () => {
  const { handlers } = createHandlers();
  const text = handlers.buildWecomBotStatusText({ logger: {} }, "dingxiang");
  assert.match(text, /企业微信 AI 机器人/);
  assert.match(text, /Bot Webhook：\/wecom\/bot\/callback/);
  assert.match(text, /回包兜底链路/);
  assert.match(text, /企业微信 Bot 平台限制/);
  assert.match(text, /微信插件入口联系人：Bot 模式通常不显示/);
});
