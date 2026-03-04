import assert from "node:assert/strict";
import test from "node:test";

import { createWecomPluginRouteRuntime } from "../src/wecom/plugin-route-runtime.js";

function createRouteRegistrarDeps() {
  return {
    resolveWecomBotConfig: () => ({
      enabled: true,
      token: "token",
      encodingAesKey: "aes",
      webhookPath: "/wecom/bot/callback",
      streamExpireMs: 600000,
    }),
    resolveWecomBotConfigs: () => [
      {
        accountId: "default",
        enabled: true,
        token: "token",
        encodingAesKey: "aes",
        webhookPath: "/wecom/bot/callback",
        streamExpireMs: 600000,
      },
    ],
    normalizePluginHttpPath: (path) => path,
    ensureBotStreamCleanupTimer: () => {},
    cleanupExpiredBotStreams: () => {},
    createWecomBotWebhookHandler: () => async () => {},
    createWecomAgentWebhookHandler: () => async () => {},
    readRequestBody: async () => "",
    parseIncomingJson: () => ({}),
    parseIncomingXml: () => ({}),
    pickAccountBySignature: () => null,
    decryptWecom: () => ({ msg: "", corpId: "" }),
    computeMsgSignature: () => "sig",
    parseWecomBotInboundMessage: () => ({}),
    describeWecomBotParsedMessage: () => "ok",
    markInboundMessageSeen: () => true,
    extractWecomXmlInboundEnvelope: () => ({}),
    buildWecomSessionId: (user) => `wecom:${user}`,
    buildWecomBotSessionId: (user) => `wecom-bot:${user}`,
    buildWecomBotEncryptedResponse: () => "{}",
    createBotStream: () => ({}),
    getBotStream: () => null,
    upsertBotResponseUrlCache: () => {},
    messageProcessLimiter: { execute: async (fn) => fn() },
    executeInboundTaskWithSessionQueue: async ({ task }) => task(),
    processBotInboundMessage: async () => {},
    processInboundMessage: async () => {},
    scheduleTextInboundProcessing: () => {},
    deliverBotReplyText: async () => ({ ok: true }),
    finishBotStream: () => {},
    groupAccountsByWebhookPath: () => new Map(),
  };
}

function createRegisterRuntimeDeps() {
  return {
    setGatewayRuntime: () => {},
    syncWecomSessionQueuePolicy: () => ({
      enabled: true,
      timeoutMs: 30000,
      maxConcurrentPerSession: 1,
    }),
    resolveWecomDeliveryFallbackPolicy: () => ({ enabled: true, order: ["stream", "agent_push"] }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({ enabled: false, url: "", key: "" }),
    resolveWecomObservabilityPolicy: () => ({ enabled: false, logPayloadMeta: false }),
    resolveWecomDynamicAgentPolicy: () => ({ enabled: false, mode: "mapping", userMap: {}, groupMap: {}, mentionMap: {} }),
    resolveWecomBotConfig: () => ({ enabled: false }),
    resolveWecomBotConfigs: () => [{ accountId: "default", enabled: false }],
    getWecomConfig: () => ({
      corpId: "ww1",
      corpSecret: "sec",
      agentId: "1000001",
    }),
    wecomChannelPlugin: { id: "wecom" },
  };
}

test("createWecomPluginRouteRuntime builds register function", () => {
  const routeRuntime = createWecomPluginRouteRuntime({
    routeRegistrarDeps: createRouteRegistrarDeps(),
    registerRuntimeDeps: createRegisterRuntimeDeps(),
  });

  assert.equal(typeof routeRuntime.wecomRouteRegistrar, "object");
  assert.equal(typeof routeRuntime.registerWecomRuntime, "function");
});
