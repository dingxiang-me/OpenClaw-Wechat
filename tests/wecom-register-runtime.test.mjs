import assert from "node:assert/strict";
import test from "node:test";

import { createWecomRegisterRuntime } from "../src/wecom/register-runtime.js";

function createLogger() {
  const logs = {
    info: [],
    warn: [],
    error: [],
  };
  return {
    logs,
    logger: {
      info(msg) {
        logs.info.push(String(msg));
      },
      warn(msg) {
        logs.warn.push(String(msg));
      },
      error(msg) {
        logs.error.push(String(msg));
      },
    },
  };
}

test("register logs startup and registers channel/routes", () => {
  const { logger, logs } = createLogger();
  const calls = {
    setRuntime: 0,
    registerChannel: 0,
    botRoute: 0,
    agentRoutes: 0,
  };

  const runtime = createWecomRegisterRuntime({
    setGatewayRuntime: () => {
      calls.setRuntime += 1;
    },
    syncWecomSessionQueuePolicy: () => ({ enabled: true, timeoutMs: 9000, maxConcurrentPerSession: 1 }),
    resolveWecomDeliveryFallbackPolicy: () => ({ enabled: true, order: ["active_stream", "agent_push"] }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({ enabled: true, url: "", key: "" }),
    resolveWecomObservabilityPolicy: () => ({ enabled: true, logPayloadMeta: true }),
    resolveWecomDynamicAgentPolicy: () => ({ enabled: true, mode: "manual", userMap: { u1: "main" }, groupMap: {}, mentionMap: {} }),
    resolveWecomBotConfig: () => ({ enabled: false, webhookPath: "/wecom/bot/callback", streamExpireMs: 600000 }),
    resolveWecomBotConfigs: () => [{ accountId: "default", enabled: false }],
    getWecomConfig: () => ({ corpId: "ww12345678", outboundProxy: "" }),
    wecomChannelPlugin: { id: "wecom" },
    wecomRouteRegistrar: {
      registerWecomBotWebhookRoute() {
        calls.botRoute += 1;
        return true;
      },
      registerWecomAgentWebhookRoutes() {
        calls.agentRoutes += 1;
        return new Map([["/wecom/callback", [{ accountId: "default" }]]]);
      },
    },
  });

  runtime.register({
    runtime: { any: true },
    logger,
    registerChannel() {
      calls.registerChannel += 1;
    },
  });

  assert.equal(calls.setRuntime, 1);
  assert.equal(calls.registerChannel, 1);
  assert.equal(calls.botRoute, 1);
  assert.equal(calls.agentRoutes, 1);
  assert.ok(logs.info.some((line) => line.includes("wecom: config loaded")));
  assert.ok(logs.info.some((line) => line.includes("wecom: stream.manager")));
});

test("register warns when no route available", () => {
  const { logger, logs } = createLogger();
  const runtime = createWecomRegisterRuntime({
    setGatewayRuntime: () => {},
    syncWecomSessionQueuePolicy: () => ({ enabled: false, timeoutMs: 9000, maxConcurrentPerSession: 1 }),
    resolveWecomDeliveryFallbackPolicy: () => ({ enabled: false, order: ["active_stream"] }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({ enabled: false, url: "", key: "" }),
    resolveWecomObservabilityPolicy: () => ({ enabled: false, logPayloadMeta: false }),
    resolveWecomDynamicAgentPolicy: () => ({ enabled: false, mode: "manual", userMap: {}, groupMap: {}, mentionMap: {} }),
    resolveWecomBotConfig: () => ({ enabled: false, webhookPath: "/wecom/bot/callback", streamExpireMs: 600000 }),
    resolveWecomBotConfigs: () => [{ accountId: "default", enabled: false }],
    getWecomConfig: () => null,
    wecomChannelPlugin: { id: "wecom" },
    wecomRouteRegistrar: {
      registerWecomBotWebhookRoute() {
        return false;
      },
      registerWecomAgentWebhookRoutes() {
        return new Map();
      },
    },
  });

  runtime.register({
    runtime: {},
    logger,
    registerChannel() {},
  });

  assert.ok(logs.warn.some((line) => line.includes("no enabled account with valid config")));
});
