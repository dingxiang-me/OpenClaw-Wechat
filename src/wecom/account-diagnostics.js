import { normalizePluginHttpPath } from "./http-path.js";
import { buildDefaultAgentWebhookPath, buildDefaultBotWebhookPath } from "./account-paths.js";

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function pushMapList(map, key, value) {
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function detectDuplicateMapEntries(map, minimum = 2) {
  const out = [];
  for (const [key, values] of map.entries()) {
    if (!Array.isArray(values) || values.length < minimum) continue;
    out.push({ key, values: [...values] });
  }
  return out;
}

export function analyzeWecomAccountConflicts({ accounts = [], botConfigs = [] } = {}) {
  const issues = [];
  const enabledAccounts = (Array.isArray(accounts) ? accounts : []).filter((item) => item?.enabled !== false);
  const enabledBotConfigs = (Array.isArray(botConfigs) ? botConfigs : []).filter((item) => item?.enabled === true);

  const agentTokenToAccounts = new Map();
  const corpAgentToAccounts = new Map();
  const agentPathToAccounts = new Map();
  const botTokenToAccounts = new Map();
  const botPathToAccounts = new Map();

  for (const account of enabledAccounts) {
    const accountId = normalizeAccountId(account?.accountId);
    const callbackToken = String(account?.callbackToken ?? "").trim();
    const corpId = String(account?.corpId ?? "").trim().toLowerCase();
    const agentId = String(account?.agentId ?? "").trim();
    const normalizedPath =
      normalizePluginHttpPath(
        String(account?.webhookPath ?? "").trim() || buildDefaultAgentWebhookPath(accountId),
        "/wecom/callback",
      ) ?? "/wecom/callback";

    if (callbackToken) pushMapList(agentTokenToAccounts, callbackToken, accountId);
    if (corpId && agentId) pushMapList(corpAgentToAccounts, `${corpId}:${agentId}`, accountId);
    pushMapList(agentPathToAccounts, normalizedPath, accountId);
  }

  for (const botConfig of enabledBotConfigs) {
    const accountId = normalizeAccountId(botConfig?.accountId);
    const token = String(botConfig?.token ?? "").trim();
    const normalizedPath =
      normalizePluginHttpPath(
        String(botConfig?.webhookPath ?? "").trim() || buildDefaultBotWebhookPath(accountId),
        "/wecom/bot/callback",
      ) ?? "/wecom/bot/callback";
    if (token) pushMapList(botTokenToAccounts, token, accountId);
    pushMapList(botPathToAccounts, normalizedPath, accountId);
  }

  for (const dup of detectDuplicateMapEntries(agentTokenToAccounts)) {
    issues.push({
      severity: "warn",
      code: "agent-duplicate-callback-token",
      message: `Agent callbackToken duplicated across accounts: ${dup.values.join(", ")}`,
      value: dup.key,
      accounts: dup.values,
    });
  }
  for (const dup of detectDuplicateMapEntries(corpAgentToAccounts)) {
    issues.push({
      severity: "warn",
      code: "agent-duplicate-corp-agent",
      message: `Agent corpId+agentId duplicated across accounts: ${dup.values.join(", ")}`,
      value: dup.key,
      accounts: dup.values,
    });
  }
  for (const dup of detectDuplicateMapEntries(botTokenToAccounts)) {
    issues.push({
      severity: "warn",
      code: "bot-duplicate-token",
      message: `Bot token duplicated across accounts: ${dup.values.join(", ")}`,
      value: dup.key,
      accounts: dup.values,
    });
  }
  for (const dup of detectDuplicateMapEntries(agentPathToAccounts)) {
    issues.push({
      severity: "info",
      code: "agent-shared-webhook-path",
      message: `Agent webhook path shared by accounts: ${dup.key} <- ${dup.values.join(", ")}`,
      value: dup.key,
      accounts: dup.values,
    });
  }
  for (const dup of detectDuplicateMapEntries(botPathToAccounts)) {
    issues.push({
      severity: "info",
      code: "bot-shared-webhook-path",
      message: `Bot webhook path shared by accounts: ${dup.key} <- ${dup.values.join(", ")}`,
      value: dup.key,
      accounts: dup.values,
    });
  }

  return {
    ok: !issues.some((item) => item.severity === "warn"),
    issues,
    counts: {
      accounts: enabledAccounts.length,
      botAccounts: enabledBotConfigs.length,
      warnings: issues.filter((item) => item.severity === "warn").length,
      info: issues.filter((item) => item.severity === "info").length,
    },
  };
}

