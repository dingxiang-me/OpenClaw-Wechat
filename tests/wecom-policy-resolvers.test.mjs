import assert from "node:assert/strict";
import test from "node:test";

import { createWecomPolicyResolvers } from "../src/wecom/policy-resolvers.js";

test("createWecomPolicyResolvers uses gateway runtime config fallback", () => {
  const policy = createWecomPolicyResolvers({
    getGatewayRuntime: () => ({
      config: {
        channels: { wecom: { enabled: true } },
        env: { vars: { WECOM_ENABLED: "1" } },
      },
    }),
    normalizeAccountId: (id) => String(id ?? "").trim().toLowerCase() || "default",
    resolveWecomBotModeConfig: (inputs) => ({ enabled: Boolean(inputs.channelConfig?.enabled) }),
    resolveWecomBotModeAccountsConfig: () => [
      { accountId: "default", enabled: true },
      { accountId: "sales", enabled: true, token: "sales-token" },
    ],
    resolveWecomProxyConfig: () => "",
    resolveWecomCommandPolicyConfig: () => ({ enabled: true }),
    resolveWecomAllowFromPolicyConfig: (inputs) => ({ accountId: inputs.accountId }),
    resolveWecomGroupChatConfig: () => ({ enabled: true }),
    resolveWecomDebounceConfig: () => ({ enabled: true }),
    resolveWecomStreamingConfig: () => ({ enabled: true }),
    resolveWecomDeliveryFallbackConfig: () => ({ enabled: true, order: ["active_stream"] }),
    resolveWecomWebhookBotDeliveryConfig: () => ({ enabled: true }),
    resolveWecomStreamManagerConfig: () => ({ enabled: true, maxConcurrentPerSession: 1 }),
    resolveWecomObservabilityConfig: () => ({ enabled: true }),
    resolveWecomDynamicAgentConfig: () => ({ enabled: false }),
    processEnv: {},
  });

  const botCfg = policy.resolveWecomBotConfig({});
  const botConfigs = policy.resolveWecomBotConfigs({});
  const allowFrom = policy.resolveWecomAllowFromPolicy({}, " OPS ", {});
  const fallback = policy.resolveWecomDeliveryFallbackPolicy({});

  assert.equal(botCfg.enabled, true);
  assert.equal(botCfg.accountId, "default");
  assert.equal(botConfigs.length, 2);
  assert.equal(allowFrom.accountId, "ops");
  assert.equal(fallback.enabled, true);
});
