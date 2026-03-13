import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAccountConfig, readAccountConfigFromEnv } from "../src/wecom/account-config-core.js";

function normalizeWecomWebhookTargetMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return { ...input };
}

test("normalizeAccountConfig supports legacy token/encodingAesKey keys", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_test",
      corpSecret: "secret",
      agentId: 1000001,
      token: "legacy-token",
      encodingAesKey: "legacy-aes",
    },
    accountId: "default",
    normalizeWecomWebhookTargetMap,
  });

  assert.equal(normalized.callbackToken, "legacy-token");
  assert.equal(normalized.callbackAesKey, "legacy-aes");
});

test("normalizeAccountConfig prefers callbackToken/callbackAesKey over legacy keys", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_test",
      corpSecret: "secret",
      agentId: 1000001,
      callbackToken: "new-token",
      callbackAesKey: "new-aes",
      token: "legacy-token",
      encodingAesKey: "legacy-aes",
    },
    accountId: "default",
    normalizeWecomWebhookTargetMap,
  });

  assert.equal(normalized.callbackToken, "new-token");
  assert.equal(normalized.callbackAesKey, "new-aes");
});

test("readAccountConfigFromEnv supports legacy default env vars", () => {
  const processEnvStub = {
    WECOM_CORP_ID: "ww_env",
    WECOM_CORP_SECRET: "env-secret",
    WECOM_AGENT_ID: "1000002",
    WECOM_TOKEN: "legacy-token",
    WECOM_ENCODING_AES_KEY: "legacy-aes",
  };

  const normalized = readAccountConfigFromEnv({
    envVars: {},
    accountId: "default",
    requireEnv: (name) => processEnvStub[name],
    normalizeWecomWebhookTargetMap,
  });

  assert.equal(normalized.callbackToken, "legacy-token");
  assert.equal(normalized.callbackAesKey, "legacy-aes");
});

test("readAccountConfigFromEnv supports legacy scoped env vars", () => {
  const processEnvStub = {
    WECOM_BETA_CORP_ID: "ww_beta",
    WECOM_BETA_CORP_SECRET: "beta-secret",
    WECOM_BETA_AGENT_ID: "1000003",
    WECOM_BETA_TOKEN: "beta-legacy-token",
    WECOM_BETA_ENCODING_AES_KEY: "beta-legacy-aes",
  };

  const normalized = readAccountConfigFromEnv({
    envVars: {},
    accountId: "beta",
    requireEnv: (name) => processEnvStub[name],
    normalizeWecomWebhookTargetMap,
  });

  assert.equal(normalized.callbackToken, "beta-legacy-token");
  assert.equal(normalized.callbackAesKey, "beta-legacy-aes");
});

test("normalizeAccountConfig auto-assigns non-default webhookPath when missing", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_sales",
      corpSecret: "secret",
      agentId: 1000008,
    },
    accountId: "sales",
    normalizeWecomWebhookTargetMap,
  });
  assert.equal(normalized.webhookPath, "/wecom/sales/callback");
});

test("normalizeAccountConfig supports legacy agent block and keeps top-level token for bot", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      token: "legacy-bot-token",
      encodingAesKey: "legacy-bot-aes",
      agent: {
        corpId: "ww_legacy",
        corpSecret: "legacy-secret",
        agentId: 1000099,
        token: "agent-callback-token",
        encodingAesKey: "agent-callback-aes",
      },
    },
    accountId: "default",
    normalizeWecomWebhookTargetMap,
  });

  assert.equal(normalized.corpId, "ww_legacy");
  assert.equal(normalized.corpSecret, "legacy-secret");
  assert.equal(normalized.agentId, 1000099);
  assert.equal(normalized.callbackToken, "agent-callback-token");
  assert.equal(normalized.callbackAesKey, "agent-callback-aes");
  assert.equal(normalized.name, "default");
});

test("normalizeAccountConfig keeps explicit account name", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      name: "Sales Bot",
      corpId: "ww_sales",
      corpSecret: "sales-secret",
      agentId: 1000018,
    },
    accountId: "sales",
    normalizeWecomWebhookTargetMap,
  });
  assert.equal(normalized.name, "Sales Bot");
});

test("normalizeAccountConfig supports account-level dm.allowFrom alias", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_ops",
      corpSecret: "ops-secret",
      agentId: 1000077,
      dm: {
        allowFrom: ["wecom:alice", "user:bob"],
      },
    },
    accountId: "ops",
    normalizeWecomWebhookTargetMap,
  });
  assert.deepEqual(normalized.allowFrom, ["wecom:alice", "user:bob"]);
});

test("normalizeAccountConfig keeps account-level tool flags", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_docs",
      corpSecret: "docs-secret",
      agentId: 1000088,
      tools: {
        doc: false,
        docAutoGrantRequesterCollaborator: false,
      },
    },
    accountId: "docs",
    normalizeWecomWebhookTargetMap,
  });
  assert.deepEqual(normalized.tools, { doc: false, docAutoGrantRequesterCollaborator: false });
});

test("normalizeAccountConfig keeps apiProxy", () => {
  const normalized = normalizeAccountConfig({
    raw: {
      corpId: "ww_docs",
      corpSecret: "docs-secret",
      agentId: 1000088,
      apiProxy: "https://wecom-proxy.example.com",
    },
    accountId: "docs",
    normalizeWecomWebhookTargetMap,
  });
  assert.equal(normalized.apiProxy, "https://wecom-proxy.example.com");
});

test("readAccountConfigFromEnv auto-assigns non-default webhookPath when missing", () => {
  const processEnvStub = {
    WECOM_SALES_CORP_ID: "ww_sales",
    WECOM_SALES_CORP_SECRET: "sales-secret",
    WECOM_SALES_AGENT_ID: "1000010",
  };

  const normalized = readAccountConfigFromEnv({
    envVars: {},
    accountId: "sales",
    requireEnv: (name) => processEnvStub[name],
    normalizeWecomWebhookTargetMap,
  });
  assert.equal(normalized.webhookPath, "/wecom/sales/callback");
});

test("readAccountConfigFromEnv supports API proxy env vars", () => {
  const processEnvStub = {
    WECOM_SALES_CORP_ID: "ww_sales",
    WECOM_SALES_CORP_SECRET: "sales-secret",
    WECOM_SALES_AGENT_ID: "1000010",
    WECOM_SALES_API_PROXY: "https://wecom-proxy.example.com/sales",
  };

  const normalized = readAccountConfigFromEnv({
    envVars: {},
    accountId: "sales",
    requireEnv: (name) => processEnvStub[name],
    normalizeWecomWebhookTargetMap,
  });
  assert.equal(normalized.apiProxy, "https://wecom-proxy.example.com/sales");
});
