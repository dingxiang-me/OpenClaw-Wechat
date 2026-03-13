import assert from "node:assert/strict";
import test from "node:test";

import { resolveWecomProxyConfig, normalizeWecomWebhookTargetMap } from "../src/core.js";
import { createWecomAccountRegistry } from "../src/wecom/account-config.js";

function createRegistry() {
  return createWecomAccountRegistry({
    normalizeWecomWebhookTargetMap,
    resolveWecomProxyConfig,
    processEnv: {},
  });
}

function buildAccount(agentId, overrides = {}) {
  return {
    corpId: `ww-${agentId}`,
    corpSecret: `secret-${agentId}`,
    agentId,
    callbackToken: `token-${agentId}`,
    callbackAesKey: Buffer.alloc(32, Number(agentId) % 255 || 1).toString("base64").replace(/=+$/g, ""),
    ...overrides,
  };
}

test("account registry respects channels.wecom.defaultAccount", () => {
  const registry = createRegistry();
  const config = {
    channels: {
      wecom: {
        defaultAccount: "sales",
        accounts: {
          sales: buildAccount(1001),
          support: buildAccount(1002),
        },
      },
    },
  };

  const defaultConfig = registry.getWecomConfig({ gatewayRuntime: { config } });
  const missingFallback = registry.getWecomConfig({ gatewayRuntime: { config }, accountId: "missing" });

  assert.equal(defaultConfig?.accountId, "sales");
  assert.equal(missingFallback?.accountId, "sales");
});

test("account registry discovers legacy inline account entries", () => {
  const registry = createRegistry();
  const config = {
    channels: {
      wecom: {
        ...buildAccount(1001),
        legacy: buildAccount(1003, { webhookPath: "/wecom/legacy/callback" }),
      },
    },
  };

  assert.deepEqual(registry.listWecomAccountIds({ gatewayRuntime: { config } }), ["default", "legacy"]);
  assert.equal(
    registry.getWecomConfig({ gatewayRuntime: { config }, accountId: "legacy" })?.webhookPath,
    "/wecom/legacy/callback",
  );
});

test("account registry falls back to channel apiProxy for accounts", () => {
  const registry = createRegistry();
  const config = {
    channels: {
      wecom: {
        apiProxy: "https://wecom-proxy.example.com/base",
        accounts: {
          sales: buildAccount(1001),
          support: buildAccount(1002, { apiProxy: "https://wecom-proxy.example.com/support" }),
        },
      },
    },
  };

  assert.equal(
    registry.getWecomConfig({ gatewayRuntime: { config }, accountId: "sales" })?.apiProxy,
    "https://wecom-proxy.example.com/base",
  );
  assert.equal(
    registry.getWecomConfig({ gatewayRuntime: { config }, accountId: "support" })?.apiProxy,
    "https://wecom-proxy.example.com/support",
  );
});
