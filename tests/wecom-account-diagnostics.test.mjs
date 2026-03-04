import assert from "node:assert/strict";
import test from "node:test";

import { analyzeWecomAccountConflicts } from "../src/wecom/account-diagnostics.js";

test("analyzeWecomAccountConflicts returns warning for duplicate agent callback token", () => {
  const result = analyzeWecomAccountConflicts({
    accounts: [
      {
        accountId: "default",
        enabled: true,
        corpId: "ww-a",
        agentId: "1001",
        callbackToken: "token-same",
        webhookPath: "/wecom/callback",
      },
      {
        accountId: "sales",
        enabled: true,
        corpId: "ww-b",
        agentId: "1002",
        callbackToken: "token-same",
        webhookPath: "/wecom/sales/callback",
      },
    ],
    botConfigs: [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "agent-duplicate-callback-token"));
});

test("analyzeWecomAccountConflicts reports shared webhook path as info", () => {
  const result = analyzeWecomAccountConflicts({
    accounts: [
      {
        accountId: "default",
        enabled: true,
        corpId: "ww-a",
        agentId: "1001",
        callbackToken: "token-a",
        webhookPath: "/wecom/shared/callback",
      },
      {
        accountId: "sales",
        enabled: true,
        corpId: "ww-b",
        agentId: "1002",
        callbackToken: "token-b",
        webhookPath: "/wecom/shared/callback",
      },
    ],
    botConfigs: [],
  });

  assert.equal(result.ok, true);
  assert.ok(result.issues.some((item) => item.code === "agent-shared-webhook-path"));
});

test("analyzeWecomAccountConflicts warns for duplicate bot token", () => {
  const result = analyzeWecomAccountConflicts({
    accounts: [],
    botConfigs: [
      {
        accountId: "default",
        enabled: true,
        token: "bot-token",
        webhookPath: "/wecom/bot/callback",
      },
      {
        accountId: "sales",
        enabled: true,
        token: "bot-token",
        webhookPath: "/wecom/sales/bot/callback",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "bot-duplicate-token"));
});

