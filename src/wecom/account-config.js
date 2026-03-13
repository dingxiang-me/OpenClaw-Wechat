import {
  collectWecomEnvAccountIds,
  createRequireEnv,
  normalizeAccountConfig,
  normalizeAccountId,
  readAccountConfigFromEnv,
} from "./account-config-core.js";
import { normalizePluginHttpPath } from "./http-path.js";

const LEGACY_INLINE_ACCOUNT_RESERVED_KEYS = new Set([
  "name",
  "enabled",
  "corpId",
  "corpSecret",
  "agentId",
  "callbackToken",
  "token",
  "callbackAesKey",
  "encodingAesKey",
  "webhookPath",
  "outboundProxy",
  "apiProxy",
  "proxyUrl",
  "proxy",
  "webhooks",
  "allowFrom",
  "allowFromRejectMessage",
  "rejectUnauthorizedMessage",
  "adminUsers",
  "commandAllowlist",
  "commandBlockMessage",
  "commands",
  "workspaceTemplate",
  "groupChat",
  "dynamicAgent",
  "dynamicAgents",
  "dm",
  "debounce",
  "streaming",
  "bot",
  "delivery",
  "webhookBot",
  "stream",
  "observability",
  "voiceTranscription",
  "defaultAccount",
  "tools",
  "accounts",
  "agent",
]);

function listLegacyInlineAccountEntries(channelConfig) {
  if (!channelConfig || typeof channelConfig !== "object") return [];
  const entries = [];
  for (const [rawKey, value] of Object.entries(channelConfig)) {
    const accountId = normalizeAccountId(rawKey);
    if (!accountId) continue;
    if (LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(accountId)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    entries.push([accountId, value]);
  }
  return entries;
}

export function createWecomAccountRegistry({
  normalizeWecomWebhookTargetMap,
  resolveWecomProxyConfig,
  processEnv = process.env,
} = {}) {
  if (typeof normalizeWecomWebhookTargetMap !== "function") {
    throw new Error("createWecomAccountRegistry requires normalizeWecomWebhookTargetMap");
  }
  if (typeof resolveWecomProxyConfig !== "function") {
    throw new Error("createWecomAccountRegistry requires resolveWecomProxyConfig");
  }

  const requireEnv = createRequireEnv(processEnv);
  const wecomAccounts = new Map();
  let defaultAccountId = "default";

  function rebuildWecomAccounts({ api, gatewayRuntime } = {}) {
    const cfg = api?.config ?? gatewayRuntime?.config ?? {};
    const channelConfig = cfg?.channels?.wecom;
    const envVars = cfg?.env?.vars ?? {};
    const channelApiProxy = String(channelConfig?.apiProxy ?? "").trim();
    const globalWebhookTargets = normalizeWecomWebhookTargetMap(
      channelConfig?.webhooks,
      envVars?.WECOM_WEBHOOK_TARGETS,
      processEnv.WECOM_WEBHOOK_TARGETS,
    );
    const resolved = new Map();

    const upsert = (accountId, rawConfig) => {
      const normalized = normalizeAccountConfig({
        raw: rawConfig,
        accountId,
        normalizeWecomWebhookTargetMap,
      });
      if (!normalized) return;
      resolved.set(normalized.accountId, normalized);
    };

    if (channelConfig && typeof channelConfig === "object") {
      upsert("default", channelConfig);
    }

    const channelAccounts = channelConfig?.accounts;
    if (channelAccounts && typeof channelAccounts === "object") {
      for (const [accountId, accountConfig] of Object.entries(channelAccounts)) {
        upsert(accountId, accountConfig);
      }
    }
    for (const [accountId, accountConfig] of listLegacyInlineAccountEntries(channelConfig)) {
      upsert(accountId, accountConfig);
    }

    const envAccountIds = collectWecomEnvAccountIds({ envVars, processEnv });
    for (const accountId of envAccountIds) {
      if (resolved.has(normalizeAccountId(accountId))) continue;
      const envConfig = readAccountConfigFromEnv({
        envVars,
        accountId,
        requireEnv,
        normalizeWecomWebhookTargetMap,
      });
      if (envConfig) resolved.set(envConfig.accountId, envConfig);
    }

    for (const [accountId, config] of resolved.entries()) {
      const mergedWebhookTargets = {
        ...globalWebhookTargets,
        ...normalizeWecomWebhookTargetMap(config?.webhooks),
      };
      config.webhooks = Object.keys(mergedWebhookTargets).length > 0 ? mergedWebhookTargets : undefined;
      config.outboundProxy = resolveWecomProxyConfig({
        channelConfig,
        accountConfig: config,
        envVars,
        processEnv,
        accountId,
      });
      config.apiProxy = String(config?.apiProxy ?? "").trim() || channelApiProxy || undefined;
    }

    wecomAccounts.clear();
    for (const [accountId, config] of resolved) {
      wecomAccounts.set(accountId, config);
    }

    const configuredDefaultAccountId = normalizeAccountId(channelConfig?.defaultAccount ?? "default");
    defaultAccountId = wecomAccounts.has(configuredDefaultAccountId)
      ? configuredDefaultAccountId
      : wecomAccounts.has("default")
        ? "default"
        : (Array.from(wecomAccounts.keys())[0] ?? "default");

    return wecomAccounts;
  }

  function getWecomConfig({ api, gatewayRuntime, accountId = null } = {}) {
    const accountMap = rebuildWecomAccounts({ api, gatewayRuntime });
    const targetAccountId = normalizeAccountId(accountId ?? defaultAccountId);

    if (accountMap.has(targetAccountId)) {
      return accountMap.get(targetAccountId);
    }

    if (targetAccountId !== defaultAccountId && accountMap.has(defaultAccountId)) {
      return accountMap.get(defaultAccountId);
    }

    if (targetAccountId !== "default" && accountMap.has("default")) {
      return accountMap.get("default");
    }

    return accountMap.values().next().value ?? null;
  }

  function listWecomAccountIds({ api, gatewayRuntime } = {}) {
    return Array.from(rebuildWecomAccounts({ api, gatewayRuntime }).keys());
  }

  function listEnabledWecomAccounts({ api, gatewayRuntime } = {}) {
    return Array.from(rebuildWecomAccounts({ api, gatewayRuntime }).values()).filter((cfg) => cfg?.enabled !== false);
  }

  function listWebhookTargetAliases(accountConfig) {
    const map = accountConfig?.webhooks;
    if (!map || typeof map !== "object") return [];
    const aliases = Object.keys(map)
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    aliases.sort();
    return aliases;
  }

  function listAllWebhookTargetAliases({ api, gatewayRuntime } = {}) {
    const aliases = new Set();
    for (const account of listEnabledWecomAccounts({ api, gatewayRuntime })) {
      for (const alias of listWebhookTargetAliases(account)) {
        aliases.add(alias);
      }
    }
    return Array.from(aliases).sort();
  }

  function groupAccountsByWebhookPath({ api, gatewayRuntime } = {}) {
    const grouped = new Map();
    for (const account of listEnabledWecomAccounts({ api, gatewayRuntime })) {
      const normalizedPath =
        normalizePluginHttpPath(account.webhookPath ?? "/wecom/callback", "/wecom/callback") ?? "/wecom/callback";
      const existing = grouped.get(normalizedPath);
      if (existing) existing.push(account);
      else grouped.set(normalizedPath, [account]);
    }
    return grouped;
  }

  return {
    normalizeAccountId,
    rebuildWecomAccounts,
    getWecomConfig,
    listWecomAccountIds,
    listEnabledWecomAccounts,
    listWebhookTargetAliases,
    listAllWebhookTargetAliases,
    groupAccountsByWebhookPath,
  };
}
