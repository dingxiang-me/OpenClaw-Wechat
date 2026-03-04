import assert from "node:assert/strict";
import test from "node:test";

import { createWecomRouteRegistrar } from "../src/wecom/route-registration.js";

function createRegistrar(overrides = {}) {
  return createWecomRouteRegistrar({
    resolveWecomBotConfig: () => ({ enabled: true, token: "t", encodingAesKey: "k", webhookPath: "/wecom/bot/callback", streamExpireMs: 600000 }),
    resolveWecomBotConfigs: () => [
      {
        accountId: "default",
        enabled: true,
        token: "t",
        encodingAesKey: "k",
        webhookPath: "/wecom/bot/callback",
        streamExpireMs: 600000,
      },
    ],
    normalizePluginHttpPath: (p) => p,
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
    describeWecomBotParsedMessage: () => "desc",
    markInboundMessageSeen: () => true,
    extractWecomXmlInboundEnvelope: () => ({}),
    buildWecomSessionId: (u) => `wecom:${u}`,
    buildWecomBotSessionId: (u) => `wecom-bot:${u}`,
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
    ...overrides,
  });
}

test("registerWecomBotWebhookRoute registers bot callback", () => {
  const routes = [];
  const registrar = createRegistrar();
  const api = {
    logger: { info() {}, warn() {}, error() {} },
    registerHttpRoute(route) {
      routes.push(route);
    },
  };

  const ok = registrar.registerWecomBotWebhookRoute(api);
  assert.equal(ok, true);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/wecom/bot/callback");
});

test("registerWecomAgentWebhookRoutes registers grouped routes", () => {
  const routes = [];
  const groups = new Map([["/wecom/callback", [{ accountId: "default" }]]]);
  const registrar = createRegistrar({
    groupAccountsByWebhookPath: () => groups,
  });
  const api = {
    logger: { info() {}, warn() {}, error() {} },
    registerHttpRoute(route) {
      routes.push(route);
    },
  };

  const returned = registrar.registerWecomAgentWebhookRoutes(api);
  assert.equal(returned, groups);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/wecom/callback");
});

test("registerWecomBotWebhookRoute groups multiple accounts by webhook path", () => {
  const routes = [];
  const registrar = createRegistrar({
    resolveWecomBotConfigs: () => [
      {
        accountId: "default",
        enabled: true,
        token: "t-default",
        encodingAesKey: "k-default",
        webhookPath: "/wecom/bot/callback",
        streamExpireMs: 600000,
      },
      {
        accountId: "sales",
        enabled: true,
        token: "t-sales",
        encodingAesKey: "k-sales",
        webhookPath: "/wecom/bot/callback",
        streamExpireMs: 120000,
      },
      {
        accountId: "ops",
        enabled: true,
        token: "t-ops",
        encodingAesKey: "k-ops",
        webhookPath: "/wecom/ops/bot/callback",
        streamExpireMs: 180000,
      },
    ],
  });
  const api = {
    logger: { info() {}, warn() {}, error() {} },
    registerHttpRoute(route) {
      routes.push(route);
    },
  };

  const ok = registrar.registerWecomBotWebhookRoute(api);
  assert.equal(ok, true);
  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.map((item) => item.path).sort(),
    ["/wecom/bot/callback", "/wecom/ops/bot/callback"],
  );
});
