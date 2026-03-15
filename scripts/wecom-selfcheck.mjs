#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";
import {
  collectWecomEnvAccountIds as collectSharedWecomEnvAccountIds,
  createRequireEnv as createSharedRequireEnv,
  normalizeAccountConfig as normalizeSharedAccountConfig,
  readAccountConfigFromEnv as readSharedAccountConfigFromEnv,
} from "../src/wecom/account-config-core.js";
import { resolveWecomBotModeConfig, resolveWecomGroupChatConfig } from "../src/core.js";
import { collectWecomMigrationDiagnostics, WECOM_MIGRATION_COMMAND } from "../src/wecom/migration-diagnostics.js";
import { buildWecomApiUrl, isWecomApiUrl, resolveWecomApiBaseUrl } from "../src/wecom/network-config.js";
import { PLUGIN_VERSION } from "../src/wecom/plugin-constants.js";

const PROXY_DISPATCHER_CACHE = new Map();
const INVALID_PROXY_CACHE = new Set();
const LEGACY_INLINE_ACCOUNT_RESERVED_KEYS = new Set([
  "name",
  "enabled",
  "botId",
  "botid",
  "secret",
  "corpId",
  "corpSecret",
  "agentId",
  "callbackToken",
  "token",
  "callbackAesKey",
  "encodingAesKey",
  "webhookPath",
  "outboundProxy",
  "proxyUrl",
  "proxy",
  "network",
  "apiBaseUrl",
  "webhooks",
  "allowFrom",
  "allowFromRejectMessage",
  "groupPolicy",
  "groupAllowFrom",
  "groupAllowFromRejectMessage",
  "rejectUnauthorizedMessage",
  "adminUsers",
  "commandAllowlist",
  "commandBlockMessage",
  "commands",
  "workspaceTemplate",
  "groupChat",
  "groups",
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

function parseArgs(argv) {
  const out = {
    account: "default",
    allAccounts: false,
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    skipNetwork: false,
    skipLocalWebhook: false,
    timeoutMs: 8000,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--account" && next) {
      out.account = next;
      i += 1;
    } else if (arg === "--all-accounts") {
      out.allAccounts = true;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
      i += 1;
    } else if (arg === "--skip-network") {
      out.skipNetwork = true;
    } else if (arg === "--skip-local-webhook") {
      out.skipLocalWebhook = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat selfcheck

Usage:
  npm run wecom:selfcheck -- [options]

Options:
  --account <id>          Account id to validate (default: default)
  --all-accounts          Validate all discovered accounts
  --config <path>         OpenClaw config path (default: ~/.openclaw/openclaw.json)
  --timeout-ms <ms>       Network timeout for each check (default: 8000)
  --skip-network          Skip WeCom API checks
  --skip-local-webhook    Skip local webhook health probe
  --json                  Print machine-readable JSON report
  -h, --help              Show this help
`);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function buildDefaultBotWebhookPath(accountId) {
  const normalized = normalizeAccountId(accountId);
  return normalized === "default" ? "/wecom/bot/callback" : `/wecom/${normalized}/bot/callback`;
}

function asNumber(v, fallback = null) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function parseSemverLike(version) {
  const normalized = String(version ?? "").trim();
  if (!normalized) return null;
  const matched = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!matched) return null;
  return matched.slice(1).map((value) => Number.parseInt(value, 10));
}

function compareSemverLike(left, right) {
  const a = parseSemverLike(left);
  const b = parseSemverLike(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] === b[index]) continue;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function decodeAesKey(aesKey) {
  if (!aesKey) return null;
  const base64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  return Buffer.from(base64, "base64");
}

function isFalseLike(v) {
  return ["0", "false", "off", "no"].includes(String(v ?? "").trim().toLowerCase());
}

function makeCheck(name, ok, detail, data = null) {
  return { name, ok: Boolean(ok), detail: String(detail ?? ""), data };
}

function summarize(checks) {
  const failCount = checks.filter((c) => !c.ok).length;
  return {
    ok: failCount === 0,
    total: checks.length,
    failed: failCount,
    passed: checks.length - failCount,
  };
}

function summarizeAccounts(accountReports) {
  const checks = accountReports.flatMap((r) => r.checks);
  const accountFailures = accountReports.filter((r) => !r.summary.ok).length;
  return {
    ...summarize(checks),
    accountsTotal: accountReports.length,
    accountsFailed: accountFailures,
    accountsPassed: accountReports.length - accountFailures,
  };
}

function formatGroupSourceLabel(source = "") {
  const normalized = String(source ?? "").trim();
  if (!normalized) return "none";
  if (normalized === "default") return "default";
  if (normalized === "inferred") return "inferred";
  if (normalized.startsWith("env.")) return "env";
  if (normalized.startsWith("account.group")) return "account-group";
  if (normalized.startsWith("account.groupChat")) return "account-group-default";
  if (normalized.startsWith("account.root")) return "account-root";
  if (normalized.startsWith("channel.group")) return "channel-group";
  if (normalized.startsWith("channel.groupChat")) return "channel-group-default";
  if (normalized.startsWith("channel.root")) return "channel-root";
  return normalized;
}

function buildGroupPolicyOverview({ config = {}, accountConfig = {}, accountId = "default" } = {}) {
  const groupPolicy = resolveWecomGroupChatConfig({
    channelConfig: config?.channels?.wecom ?? {},
    accountConfig,
    envVars: config?.env?.vars ?? {},
    processEnv: process.env,
    accountId,
  });
  const allowFrom = Array.isArray(groupPolicy?.allowFrom) ? groupPolicy.allowFrom : [];
  const allowSummary =
    groupPolicy?.policyMode === "allowlist"
      ? String(allowFrom.length)
      : allowFrom.length > 0 && !allowFrom.includes("*")
        ? `${allowFrom.length}(inactive)`
        : "open";
  return {
    mode: String(groupPolicy?.policyMode ?? "open"),
    trigger: String(groupPolicy?.triggerMode ?? "direct"),
    allowSummary,
    groups: Number(groupPolicy?.configuredGroupCount || 0),
    source: formatGroupSourceLabel(groupPolicy?.policySource),
  };
}

function buildAccountOverview({ config, resolved } = {}) {
  const bindingsCount = Array.isArray(config?.bindings) ? config.bindings.length : 0;
  const dynamicAgentEnabled =
    config?.channels?.wecom?.dynamicAgent?.enabled === true || config?.channels?.wecom?.dynamicAgents?.enabled === true;
  const deliveryConfig = config?.channels?.wecom?.delivery ?? {};
  const pendingReplyConfig = deliveryConfig?.pendingReply ?? {};
  const reasoningConfig = deliveryConfig?.reasoning ?? {};
  const pendingReplyEnabled = pendingReplyConfig?.enabled !== false;
  const pendingReplyPersist = pendingReplyEnabled && pendingReplyConfig?.persist !== false;
  const pendingReplyStoreFile = pickFirstNonEmptyString(pendingReplyConfig?.storeFile) || null;
  const quotaTrackingEnabled = deliveryConfig?.quotaTracking?.enabled !== false;
  const reasoningMode = (() => {
    const explicit = pickFirstNonEmptyString(reasoningConfig?.mode).toLowerCase();
    if (explicit === "append" || explicit === "hidden" || explicit === "separate") return explicit;
    if (reasoningConfig?.includeInFinalAnswer === true) return "append";
    if (reasoningConfig?.sendThinkingMessage === false) return "hidden";
    return "separate";
  })();
  const agentCanReceive = Boolean(resolved?.callbackToken && resolved?.callbackAesKey && resolved?.webhookPath);
  const agentCanReply = Boolean(resolved?.corpId && resolved?.corpSecret && resolved?.agentId);
  const botLongConnectionEnabled =
    resolved?.enabled !== false &&
    Boolean(pickFirstNonEmptyString(resolved?.bot?.longConnection?.botId, resolved?.bot?.longConnection?.botid)) &&
    Boolean(pickFirstNonEmptyString(resolved?.bot?.longConnection?.secret));
  const botWebhookEnabled =
    resolved?.enabled !== false &&
    Boolean(pickFirstNonEmptyString(resolved?.bot?.token)) &&
    Boolean(pickFirstNonEmptyString(resolved?.bot?.encodingAesKey));
  const canReceive = agentCanReceive || botLongConnectionEnabled || botWebhookEnabled;
  const canReply = agentCanReply || botLongConnectionEnabled || botWebhookEnabled;
  const docEnabled = resolved?.tools?.doc !== false;
  const groupPolicy = buildGroupPolicyOverview({
    config,
    accountConfig: resolved,
    accountId: resolved?.accountId || "default",
  });
  return {
    canReceive,
    canReply,
    canSend: canReply,
    docEnabled,
    bindingsCount,
    dynamicAgentEnabled,
    pendingReplyEnabled,
    pendingReplyPersist,
    pendingReplyStoreFile,
    quotaTrackingEnabled,
    reasoningMode,
    reasoningTitle: pickFirstNonEmptyString(reasoningConfig?.title, "思考过程"),
    reasoningMaxChars: Math.max(64, asNumber(reasoningConfig?.maxChars, 1200) || 1200),
    groupPolicy,
    botLongConnectionEnabled,
    botWebhookEnabled,
  };
}

function normalizeWebhookPath(raw, fallback = "/wecom/callback") {
  const input = String(raw ?? "").trim();
  if (!input) return fallback;
  return input.startsWith("/") ? input : `/${input}`;
}

function normalizeWebhookAlias(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

function normalizeWebhookTargetMap(...values) {
  const out = {};
  const assign = (rawAlias, rawTarget) => {
    const alias = normalizeWebhookAlias(rawAlias);
    const target = String(rawTarget ?? "").trim();
    if (!alias || !target) return;
    out[alias] = target;
  };

  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) continue;
      if (text.startsWith("{") && text.endsWith("}")) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [rawAlias, rawTarget] of Object.entries(parsed)) {
              assign(rawAlias, rawTarget);
            }
            continue;
          }
        } catch {
          // fall through to name=value parser
        }
      }
      for (const token of text.split(/[,\n;]/)) {
        const pair = String(token ?? "").trim();
        if (!pair) continue;
        const eqIndex = pair.indexOf("=");
        if (eqIndex <= 0 || eqIndex >= pair.length - 1) continue;
        assign(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
      }
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [rawAlias, rawTarget] of Object.entries(value)) {
        assign(rawAlias, rawTarget);
      }
    }
  }
  return out;
}

function validateWebhookTargetMap(targetMap = {}) {
  const invalid = [];
  for (const [alias, target] of Object.entries(targetMap)) {
    const value = String(target ?? "").trim();
    if (!value) {
      invalid.push({ alias, reason: "empty-target" });
      continue;
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (!parsed.hostname) invalid.push({ alias, reason: "invalid-url-host" });
      } catch {
        invalid.push({ alias, reason: "invalid-url-format" });
      }
      continue;
    }
    if (/^key:\s*$/i.test(value)) {
      invalid.push({ alias, reason: "empty-key" });
      continue;
    }
  }
  return invalid;
}

function isLikelyHttpProxyUrl(proxyUrl) {
  return /^https?:\/\/\S+$/i.test(String(proxyUrl ?? "").trim());
}

function sanitizeProxyForLog(proxyUrl) {
  const raw = String(proxyUrl ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function readAccountProxyEnv(envVars, accountId) {
  const normalizedId = normalizeAccountId(accountId);
  const scopedKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_PROXY`;
  const scopedEgressKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EGRESS_PROXY_URL`;
  return String(
    (scopedEgressKey ? envVars?.[scopedEgressKey] ?? process.env[scopedEgressKey] : undefined) ??
      (scopedKey ? envVars?.[scopedKey] ?? process.env[scopedKey] : undefined) ??
      envVars?.WECOM_EGRESS_PROXY_URL ??
      process.env.WECOM_EGRESS_PROXY_URL ??
      envVars?.WECOM_PROXY ??
      process.env.WECOM_PROXY ??
      process.env.HTTPS_PROXY ??
      process.env.HTTP_PROXY ??
      "",
  ).trim();
}

function resolveAccountProxy(config, resolved) {
  const channelConfig = config?.channels?.wecom ?? {};
  const envVars = config?.env?.vars ?? {};
  const fromAccount = String(resolved?.outboundProxy ?? "").trim();
  if (fromAccount) return fromAccount;
  const fromChannel = String(channelConfig?.outboundProxy ?? "").trim();
  if (fromChannel) return fromChannel;
  const fromEnv = readAccountProxyEnv(envVars, resolved?.accountId ?? "default");
  return fromEnv || "";
}

function resolveAccountApiBaseUrl(config, resolved) {
  const channelConfig = config?.channels?.wecom ?? {};
  const envVars = config?.env?.vars ?? {};
  return resolveWecomApiBaseUrl({
    channelConfig,
    accountConfig: resolved ?? {},
    envVars,
    processEnv: process.env,
    accountId: resolved?.accountId ?? "default",
  });
}

function attachProxyDispatcher(url, fetchOptions = {}, proxyUrl, apiBaseUrl = "") {
  if (!proxyUrl || !isWecomApiUrl(url, { apiBaseUrl }) || fetchOptions.dispatcher) return fetchOptions;
  const printableProxy = sanitizeProxyForLog(proxyUrl);
  if (!isLikelyHttpProxyUrl(proxyUrl)) {
    if (!INVALID_PROXY_CACHE.has(proxyUrl)) {
      INVALID_PROXY_CACHE.add(proxyUrl);
      console.warn(`WARN config.outboundProxy invalid: ${printableProxy}`);
    }
    return fetchOptions;
  }
  if (!PROXY_DISPATCHER_CACHE.has(proxyUrl)) {
    PROXY_DISPATCHER_CACHE.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return {
    ...fetchOptions,
    dispatcher: PROXY_DISPATCHER_CACHE.get(proxyUrl),
  };
}

function collectOtherChannelWebhookPaths(config) {
  const rows = [];
  const channels = config?.channels;
  if (!channels || typeof channels !== "object") return rows;

  for (const [channelId, channelConfig] of Object.entries(channels)) {
    if (channelId === "wecom") continue;
    if (!channelConfig || typeof channelConfig !== "object") continue;
    if (channelConfig.enabled === false) continue;

    const topLevelPath = channelConfig.webhookPath;
    if (typeof topLevelPath === "string" && topLevelPath.trim()) {
      rows.push({
        channelId,
        accountId: "default",
        webhookPath: normalizeWebhookPath(topLevelPath),
      });
    }

    const accounts = channelConfig.accounts;
    if (!accounts || typeof accounts !== "object") continue;
    for (const [accountId, accountCfg] of Object.entries(accounts)) {
      if (!accountCfg || typeof accountCfg !== "object") continue;
      if (accountCfg.enabled === false) continue;
      const accountWebhookPath = accountCfg.webhookPath;
      if (typeof accountWebhookPath !== "string" || !accountWebhookPath.trim()) continue;
      rows.push({
        channelId,
        accountId,
        webhookPath: normalizeWebhookPath(accountWebhookPath),
      });
    }
  }
  return rows;
}

function buildPluginChecks(config) {
  const checks = [];
  const plugins = config?.plugins ?? {};
  const entry = plugins?.entries?.["openclaw-wechat"];
  const allow = Array.isArray(plugins?.allow) ? plugins.allow.map((v) => String(v)) : null;
  const allowConfigured = Array.isArray(allow);
  const allowIncludesPlugin = allowConfigured && allow.includes("openclaw-wechat");
  const installMeta = plugins?.installs?.["openclaw-wechat"] ?? {};
  const installedVersion = pickFirstNonEmptyString(installMeta?.resolvedVersion, installMeta?.version);
  const versionCompare = installedVersion ? compareSemverLike(installedVersion, PLUGIN_VERSION) : null;

  checks.push(
    makeCheck(
      "plugins.enabled",
      plugins.enabled !== false,
      plugins.enabled === false ? "plugins.enabled=false" : "plugins enabled",
    ),
  );
  checks.push(
    makeCheck(
      "plugins.entry.openclaw-wechat",
      entry?.enabled !== false,
      entry?.enabled === false ? "plugins.entries.openclaw-wechat.enabled=false" : "entry enabled or inherited",
    ),
  );
  checks.push(
    makeCheck(
      "plugins.allow",
      allowIncludesPlugin,
      allowConfigured
        ? `allow includes openclaw-wechat=${allowIncludesPlugin}`
        : "plugins.allow missing (should be explicit allowlist)",
      allowConfigured ? { allow } : null,
    ),
  );
  checks.push(
    makeCheck(
      "plugins.install.openclaw-wechat.version",
      !installedVersion || versionCompare == null || versionCompare >= 0,
      installedVersion
        ? `installed=${installedVersion} expected>=${PLUGIN_VERSION}`
        : "no install metadata (source-path load or legacy install)",
      installedVersion ? { installedVersion, expectedVersion: PLUGIN_VERSION } : null,
    ),
  );

  return checks;
}

function listLegacyInlineAccountIds(channelConfig) {
  if (!channelConfig || typeof channelConfig !== "object") return [];
  const ids = [];
  for (const [rawKey, value] of Object.entries(channelConfig)) {
    const normalizedKey = normalizeAccountId(rawKey);
    if (!normalizedKey || LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(normalizedKey)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    ids.push(normalizedKey);
  }
  return Array.from(new Set(ids));
}

function readAccountConfigFromEnv(envVars, accountId) {
  const normalized = readSharedAccountConfigFromEnv({
    envVars,
    accountId,
    requireEnv: createSharedRequireEnv(process.env),
    normalizeWecomWebhookTargetMap: normalizeWebhookTargetMap,
  });
  if (!normalized) return null;
  return {
    ...normalized,
    source: "env",
  };
}

function normalizeResolvedAccount(raw, accountId, source) {
  const normalized = normalizeSharedAccountConfig({
    raw,
    accountId,
    normalizeWecomWebhookTargetMap: normalizeWebhookTargetMap,
  });
  if (!normalized) return null;
  return {
    ...normalized,
    source,
  };
}

function hasBotCompatConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const bot = raw?.bot && typeof raw.bot === "object" && !Array.isArray(raw.bot) ? raw.bot : {};
  const longConnection =
    bot?.longConnection && typeof bot.longConnection === "object" && !Array.isArray(bot.longConnection)
      ? bot.longConnection
      : {};
  return Boolean(
    pickFirstNonEmptyString(
      raw?.botId,
      raw?.botid,
      raw?.secret,
      raw?.token,
      raw?.encodingAesKey,
      bot?.token,
      bot?.callbackToken,
      bot?.encodingAesKey,
      bot?.callbackAesKey,
      longConnection?.botId,
      longConnection?.botid,
      longConnection?.secret,
    ),
  );
}

function normalizeResolvedBotAccount({ config, accountId, source, fallbackFor = null } = {}) {
  const bot = resolveWecomBotModeConfig({
    channelConfig: config?.channels?.wecom ?? {},
    envVars: config?.env?.vars ?? {},
    processEnv: process.env,
    accountId,
  });
  const longConnection = bot?.longConnection && typeof bot.longConnection === "object" ? bot.longConnection : {};
  const longConnectionEnabled =
    bot?.enabled !== false &&
    (longConnection?.enabled === true ||
      (Boolean(pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid)) &&
        Boolean(pickFirstNonEmptyString(longConnection?.secret))));
  const webhookEnabled =
    bot?.enabled !== false &&
    Boolean(pickFirstNonEmptyString(bot?.token, bot?.callbackToken)) &&
    Boolean(pickFirstNonEmptyString(bot?.encodingAesKey, bot?.callbackAesKey));
  if (!longConnectionEnabled && !webhookEnabled) return null;
  return {
    accountId: normalizeAccountId(accountId),
    source,
    enabled: bot?.enabled !== false,
    webhookPath: pickFirstNonEmptyString(bot?.webhookPath, buildDefaultBotWebhookPath(accountId)),
    botOnly: true,
    fallbackFor,
    bot: {
      webhookEnabled,
      longConnection: {
        enabled: longConnectionEnabled,
        botId: pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid) || undefined,
        secret: pickFirstNonEmptyString(longConnection?.secret) || undefined,
      },
      token: pickFirstNonEmptyString(bot?.token, bot?.callbackToken) || undefined,
      encodingAesKey: pickFirstNonEmptyString(bot?.encodingAesKey, bot?.callbackAesKey) || undefined,
      webhookPath: pickFirstNonEmptyString(bot?.webhookPath, buildDefaultBotWebhookPath(accountId)),
    },
  };
}

function resolveBotAccountFromConfig(config, accountId, options = {}) {
  const allowFallback = options.allowFallback !== false;
  const normalizedId = normalizeAccountId(accountId);
  const channelConfig = config?.channels?.wecom;

  if (channelConfig && normalizedId === "default" && hasBotCompatConfig(channelConfig)) {
    const byTop = normalizeResolvedBotAccount({
      config,
      accountId: "default",
      source: "channels.wecom",
    });
    if (byTop) return byTop;
  }

  const byAccountsRaw = channelConfig?.accounts?.[normalizedId];
  if (hasBotCompatConfig(byAccountsRaw)) {
    const byAccounts = normalizeResolvedBotAccount({
      config,
      accountId: normalizedId,
      source: `channels.wecom.accounts.${normalizedId}`,
    });
    if (byAccounts) return byAccounts;
  }

  const byLegacyInlineRaw =
    normalizedId !== "default" && !LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(normalizedId) ? channelConfig?.[normalizedId] : null;
  if (hasBotCompatConfig(byLegacyInlineRaw)) {
    const byLegacyInline = normalizeResolvedBotAccount({
      config,
      accountId: normalizedId,
      source: `channels.wecom.${normalizedId}`,
    });
    if (byLegacyInline) return byLegacyInline;
  }

  const byEnv = normalizeResolvedBotAccount({
    config,
    accountId: normalizedId,
    source: "env",
  });
  if (byEnv) return byEnv;

  if (allowFallback && normalizedId !== "default") {
    const fallbackCandidates = [
      { raw: channelConfig, source: "channels.wecom" },
      { raw: channelConfig?.accounts?.default, source: "channels.wecom.accounts.default" },
      { raw: null, source: "env" },
    ];
    for (const candidate of fallbackCandidates) {
      if (candidate.raw != null && !hasBotCompatConfig(candidate.raw)) continue;
      const fallbackDefault = normalizeResolvedBotAccount({
        config,
        accountId: "default",
        source: candidate.source,
        fallbackFor: normalizedId,
      });
      if (fallbackDefault) return fallbackDefault;
    }
  }

  return null;
}

function resolveAccountFromConfig(config, accountId, options = {}) {
  const allowFallback = options.allowFallback !== false;
  const normalizedId = normalizeAccountId(accountId);
  const channelConfig = config?.channels?.wecom;
  const envVars = config?.env?.vars ?? {};
  const globalWebhookTargets = normalizeWebhookTargetMap(
    channelConfig?.webhooks,
    envVars?.WECOM_WEBHOOK_TARGETS,
    process.env.WECOM_WEBHOOK_TARGETS,
  );
  const attachWebhookTargets = (resolved) => {
    if (!resolved) return null;
    const mergedWebhookTargets = {
      ...globalWebhookTargets,
      ...normalizeWebhookTargetMap(resolved.webhooks),
    };
    return {
      ...resolved,
      webhooks: Object.keys(mergedWebhookTargets).length > 0 ? mergedWebhookTargets : undefined,
    };
  };

  if (channelConfig && normalizedId === "default") {
    const byTop = normalizeResolvedAccount(channelConfig, "default", "channels.wecom");
    if (byTop) return attachWebhookTargets(byTop);
  }

  const byAccounts = normalizeResolvedAccount(
    channelConfig?.accounts?.[normalizedId],
    normalizedId,
    `channels.wecom.accounts.${normalizedId}`,
  );
  if (byAccounts) return attachWebhookTargets(byAccounts);

  const byLegacyInline =
    normalizedId !== "default" && !LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(normalizedId)
      ? normalizeResolvedAccount(channelConfig?.[normalizedId], normalizedId, `channels.wecom.${normalizedId}`)
      : null;
  if (byLegacyInline) return attachWebhookTargets(byLegacyInline);

  const byEnv = readAccountConfigFromEnv(envVars, normalizedId);
  if (byEnv) return attachWebhookTargets(byEnv);

  const byBot = resolveBotAccountFromConfig(config, normalizedId, { allowFallback });
  if (byBot) return attachWebhookTargets(byBot);

  if (allowFallback && normalizedId !== "default") {
    const fallbackDefault =
      normalizeResolvedAccount(channelConfig, "default", "channels.wecom") ||
      normalizeResolvedAccount(channelConfig?.accounts?.default, "default", "channels.wecom.accounts.default") ||
      readAccountConfigFromEnv(envVars, "default");
    if (fallbackDefault) {
      return {
        ...attachWebhookTargets(fallbackDefault),
        accountId: "default",
        fallbackFor: normalizedId,
      };
    }
  }

  return null;
}

function discoverAccountIds(config) {
  const ids = new Set();
  const channelConfig = config?.channels?.wecom;
  const envVars = config?.env?.vars ?? {};

  if (normalizeResolvedAccount(channelConfig, "default", "channels.wecom")) ids.add("default");

  const accountEntries = channelConfig?.accounts;
  if (accountEntries && typeof accountEntries === "object") {
    for (const key of Object.keys(accountEntries)) {
      ids.add(normalizeAccountId(key));
    }
  }
  for (const key of listLegacyInlineAccountIds(channelConfig)) {
    ids.add(key);
  }
  for (const key of collectSharedWecomEnvAccountIds({ envVars, processEnv: process.env })) {
    ids.add(normalizeAccountId(key));
  }

  if (ids.size === 0) ids.add("default");

  const ordered = Array.from(ids);
  ordered.sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (a !== "default" && b === "default") return 1;
    return a.localeCompare(b);
  });
  return ordered;
}

async function fetchJsonWithTimeout(url, timeoutMs, proxyUrl = "", apiBaseUrl = "", fetchOptions = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      url,
      attachProxyDispatcher(
        url,
        {
          ...fetchOptions,
          apiBaseUrl,
          signal: controller.signal,
        },
        proxyUrl,
        apiBaseUrl,
      ),
    );
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (json && typeof json === "object" && !Array.isArray(json)) {
      json.headers = {
        location: res.headers.get("location") || "",
      };
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function diagnoseLocalWebhookHealth({ status, raw, webhookPath, gatewayPort, location = "" }) {
  const body = String(raw ?? "");
  const preview = body.slice(0, 120);
  const normalizedBody = body.trim().toLowerCase();
  const healthy = status === 200 && normalizedBody.includes("wecom webhook");
  if (healthy) {
    return {
      ok: true,
      detail: `status=${status} body=${preview}`,
      data: null,
    };
  }

  let reason = "unexpected-response";
  const hints = [];
  if (status === 404) {
    reason = "route-not-found";
    hints.push(`路径 ${webhookPath} 未命中插件路由`);
  } else if (status === 401 || status === 403) {
    reason = "gateway-auth";
    hints.push("回调路径被 Gateway Auth / Zero Trust / 反向代理鉴权拦截");
    hints.push("企业微信回调与健康探测必须直达 webhook 路径，不能要求 Authorization、Cookie 或交互登录");
    hints.push("为 /wecom/*（以及 legacy /webhooks/app*）单独放行，或使用独立回调域名/端口");
  } else if ([301, 302, 303, 307, 308].includes(status)) {
    reason = "redirect-auth";
    hints.push("回调路径发生了重定向，通常被登录页、SSO 或前端路由接管");
    if (location) hints.push(`重定向目标：${location}`);
    hints.push("请让 /wecom/*（以及 legacy /webhooks/app*）直接反代到 OpenClaw 网关，不要跳转到登录页或前端应用");
  } else if (status === 502 || status === 503 || status === 504) {
    reason = "gateway-unreachable";
    hints.push(`网关 ${gatewayPort} 端口不可达或反向代理后端异常`);
  } else if (status === 200 && /<!doctype html|<html/i.test(body)) {
    reason = "html-fallback";
    hints.push("返回了 WebUI HTML，通常表示 webhook 路由未注册或 webhookPath 配置不一致");
    hints.push(`请确认 channels.wecom.webhookPath=${webhookPath} 与企业微信后台回调地址完全一致`);
    hints.push("确认插件已加载：plugins.entries.openclaw-wechat.enabled=true 且 plugins.allow 包含 openclaw-wechat");
  }

  return {
    ok: false,
    detail: `status=${status} body=${preview}${hints.length > 0 ? ` hint=${hints.join("；")}` : ""}`,
    data: {
      status,
      reason,
      webhookPath,
      gatewayPort,
      location: location || null,
      hints,
    },
  };
}

async function runAccountChecks({ config, accountId, args }) {
  const checks = [];
  checks.push(...buildPluginChecks(config));
  const resolved = resolveAccountFromConfig(config, accountId, {
    allowFallback: !args.allAccounts,
  });

  if (!resolved) {
    checks.push(makeCheck("config.account", false, `account '${accountId}' not found or incomplete`));
    return { accountId, resolved: null, checks, summary: summarize(checks) };
  }

  checks.push(
    makeCheck(
      "config.account",
      true,
      `resolved account=${resolved.accountId} source=${resolved.source}${resolved.fallbackFor ? ` fallback-for=${resolved.fallbackFor}` : ""}`,
      {
        accountId: resolved.accountId,
        source: resolved.source,
        enabled: resolved.enabled,
        webhookPath: resolved.webhookPath,
      },
    ),
  );

  checks.push(
    makeCheck(
      "config.enabled",
      resolved.enabled !== false,
      resolved.enabled === false ? "account is disabled" : "account enabled",
    ),
  );

  const botOnlyAccount = resolved?.botOnly === true && !(resolved?.corpId && resolved?.corpSecret && resolved?.agentId);

  const required = [
    ["corpId", resolved.corpId],
    ["corpSecret", resolved.corpSecret],
    ["agentId", resolved.agentId],
    ["callbackToken", resolved.callbackToken],
    ["callbackAesKey", resolved.callbackAesKey],
  ];
  for (const [k, v] of required) {
    checks.push(
      makeCheck(
        `config.${k}`,
        botOnlyAccount ? true : Boolean(v),
        botOnlyAccount ? "not required for bot-only account" : v ? "ok" : "missing",
      ),
    );
  }

  const aes = botOnlyAccount ? null : decodeAesKey(resolved.callbackAesKey || "");
  checks.push(
    makeCheck(
      "config.callbackAesKey.length",
      botOnlyAccount ? true : aes?.length === 32,
      botOnlyAccount ? "not required for bot-only account" : `decoded-bytes=${aes?.length ?? 0} (expected 32)`,
    ),
  );

  const webhookPath = String(resolved.webhookPath || "/wecom/callback");
  checks.push(
    makeCheck(
      "config.webhookPath",
      webhookPath.startsWith("/"),
      `path=${webhookPath}`,
    ),
  );

  const normalizedWebhookPath = normalizeWebhookPath(webhookPath);
  const conflicts = collectOtherChannelWebhookPaths(config).filter(
    (row) => row.webhookPath === normalizedWebhookPath,
  );
  checks.push(
    makeCheck(
      "config.webhookPath.conflict",
      conflicts.length === 0,
      conflicts.length === 0
        ? `no cross-channel conflict on ${normalizedWebhookPath}`
        : `conflicts with ${conflicts.map((row) => `${row.channelId}:${row.accountId}`).join(", ")}`,
    ),
  );

  const webhookTargets = normalizeWebhookTargetMap(resolved.webhooks);
  const webhookAliases = Object.keys(webhookTargets).sort();
  const invalidWebhookTargets = validateWebhookTargetMap(webhookTargets);
  checks.push(
    makeCheck(
      "config.webhooks.targets",
      invalidWebhookTargets.length === 0,
      webhookAliases.length === 0
        ? "no named webhook targets configured"
        : `configured=${webhookAliases.length} invalid=${invalidWebhookTargets.length}`,
      webhookAliases.length > 0
        ? {
            aliases: webhookAliases,
            invalid: invalidWebhookTargets,
          }
        : null,
    ),
  );

  const outboundProxy = resolveAccountProxy(config, resolved);
  const apiBaseUrl = resolveAccountApiBaseUrl(config, resolved);
  const proxyValid = !outboundProxy || isLikelyHttpProxyUrl(outboundProxy);
  checks.push(
    makeCheck(
      "config.outboundProxy",
      proxyValid,
      outboundProxy
        ? `configured (${sanitizeProxyForLog(outboundProxy)})`
        : "not configured (direct access to qyapi.weixin.qq.com required)",
    ),
  );
  checks.push(
    makeCheck(
      "config.apiBaseUrl",
      Boolean(apiBaseUrl),
      `configured (${apiBaseUrl})`,
      { apiBaseUrl },
    ),
  );

  if (!args.skipNetwork && resolved.enabled !== false && resolved.corpId && resolved.corpSecret) {
    const tokenUrl = buildWecomApiUrl(
      `/cgi-bin/gettoken?corpid=${encodeURIComponent(resolved.corpId)}` +
        `&corpsecret=${encodeURIComponent(resolved.corpSecret)}`,
      { apiBaseUrl },
    );
    try {
      const tokenResp = await fetchJsonWithTimeout(tokenUrl, args.timeoutMs, outboundProxy, apiBaseUrl);
      const token = tokenResp.json?.access_token;
      const errcode = Number(tokenResp.json?.errcode ?? -1);
      checks.push(
        makeCheck(
          "network.gettoken",
          tokenResp.ok && errcode === 0 && Boolean(token),
          `status=${tokenResp.status} errcode=${errcode} errmsg=${tokenResp.json?.errmsg ?? "n/a"}`,
          {
            errcode,
            errmsg: tokenResp.json?.errmsg ?? "n/a",
            expires_in: tokenResp.json?.expires_in ?? null,
            access_token_present: Boolean(token),
          },
        ),
      );

      if (token) {
        const cbIpUrl = buildWecomApiUrl(
          `/cgi-bin/getcallbackip?access_token=${encodeURIComponent(token)}`,
          { apiBaseUrl },
        );
        const cbIpResp = await fetchJsonWithTimeout(cbIpUrl, args.timeoutMs, outboundProxy, apiBaseUrl);
        const cbErr = Number(cbIpResp.json?.errcode ?? -1);
        checks.push(
          makeCheck(
            "network.getcallbackip",
            cbIpResp.ok && cbErr === 0,
            `status=${cbIpResp.status} errcode=${cbErr} ip_count=${Array.isArray(cbIpResp.json?.ip_list) ? cbIpResp.json.ip_list.length : 0}`,
          ),
        );
      }
    } catch (err) {
      checks.push(makeCheck("network.gettoken", false, `request failed: ${String(err?.message || err)}`));
    }
  }

  if (!args.skipLocalWebhook) {
    const gatewayPort = asNumber(config?.gateway?.port, 8885);
    const localWebhookUrl = `http://127.0.0.1:${gatewayPort}${webhookPath}`;
    try {
      const resp = await fetchJsonWithTimeout(localWebhookUrl, Math.min(args.timeoutMs, 4000), "", {
        redirect: "manual",
      });
      const raw = resp.json?.raw ?? "";
      const diagnosed = diagnoseLocalWebhookHealth({
        status: resp.status,
        raw,
        webhookPath,
        gatewayPort,
        location: typeof resp.json?.headers?.location === "string" ? resp.json.headers.location : "",
      });
      checks.push(
        makeCheck(
          "local.webhook.health",
          diagnosed.ok,
          diagnosed.detail,
          diagnosed.data,
        ),
      );
    } catch (err) {
      checks.push(makeCheck("local.webhook.health", false, `probe failed: ${String(err?.message || err)}`));
    }
  }

  return {
    accountId,
    resolved: {
      accountId: resolved.accountId,
      source: resolved.source,
      enabled: resolved.enabled,
      webhookPath: resolved.webhookPath,
      botOnly: resolved.botOnly === true,
      webhookTargetCount: webhookAliases.length,
      outboundProxy: outboundProxy ? sanitizeProxyForLog(outboundProxy) : null,
      fallbackFor: resolved.fallbackFor || null,
    },
    overview: buildAccountOverview({ config, resolved }),
    checks,
    summary: summarize(checks),
  };
}

function reportAndExit(report, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.ok ? 0 : 1);
    return;
  }

  console.log(`WeCom selfcheck`);
  console.log(`- config: ${report.configPath}`);
  console.log(
    `- mode: ${report.args.allAccounts ? "all-accounts" : `single-account (${report.args.account})`}`,
  );
  if (report.installState) {
    console.log(`- installState: ${report.installState}`);
  }
  if (report.installStateSummary) {
    console.log(`- installSummary: ${report.installStateSummary}`);
  }
  if (report.migrationState) {
    console.log(`- migrationState: ${report.migrationState}`);
  }
  if (report.migrationStateSummary) {
    console.log(`- migrationSummary: ${report.migrationStateSummary}`);
  }
  if (Array.isArray(report.detectedLegacyFields) && report.detectedLegacyFields.length > 0) {
    console.log(`- migrationCommand: ${report.migrationCommand || WECOM_MIGRATION_COMMAND}`);
  }

  for (const accountReport of report.accounts) {
    console.log(`\nAccount: ${accountReport.accountId}`);
    if (accountReport.resolved) {
      const meta = accountReport.resolved;
      const overview = accountReport.overview ?? buildAccountOverview({ config: report.config, resolved: meta });
      console.log(
        `- resolved: ${meta.accountId} source=${meta.source}${meta.fallbackFor ? ` fallback-for=${meta.fallbackFor}` : ""}`,
      );
      console.log(`- webhookPath: ${meta.webhookPath}`);
      console.log(`- namedWebhookTargets: ${meta.webhookTargetCount ?? 0}`);
      console.log(`- outboundProxy: ${meta.outboundProxy || "(none)"}`);
      console.log(
        `- readiness: receive=${overview.canReceive ? "yes" : "no"} reply=${overview.canReply ? "yes" : "no"} send=${overview.canSend ? "yes" : "no"} doc=${overview.docEnabled ? "on" : "off"}`,
      );
      console.log(
        `- routing: bindings=${overview.bindingsCount} dynamicAgent=${overview.dynamicAgentEnabled ? "on" : "off"}`,
      );
      console.log(
        `- reliable-delivery: pendingReply=${overview.pendingReplyEnabled ? "on" : "off"} persist=${overview.pendingReplyPersist ? "on" : "off"} quotaTracking=${overview.quotaTrackingEnabled ? "on" : "off"} store=${overview.pendingReplyPersist ? overview.pendingReplyStoreFile || "(auto)" : "(disabled)"}`,
      );
      console.log(
        `- group-policy: mode=${overview.groupPolicy.mode} trigger=${overview.groupPolicy.trigger} allowFrom=${overview.groupPolicy.allowSummary} groups=${overview.groupPolicy.groups} source=${overview.groupPolicy.source}`,
      );
      console.log(
        `- reasoning: mode=${overview.reasoningMode} title=${overview.reasoningTitle} maxChars=${overview.reasoningMaxChars}`,
      );
    }
    for (const check of accountReport.checks) {
      console.log(`${check.ok ? "OK " : "FAIL"} ${check.name} :: ${check.detail}`);
    }
    console.log(
      `Account summary: ${accountReport.summary.passed}/${accountReport.summary.total} passed`,
    );
  }

  console.log(
    `\nSummary: accounts ${report.summary.accountsPassed}/${report.summary.accountsTotal} passed, checks ${report.summary.passed}/${report.summary.total} passed`,
  );
  process.exit(report.summary.ok ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(expandHome(args.configPath));

  let config = null;
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    const failReport = {
      args,
      configPath,
      accounts: [
        {
          accountId: normalizeAccountId(args.account),
          resolved: null,
          checks: [
            makeCheck(
              "config.load",
              false,
              `failed to load ${configPath}: ${String(err?.message || err)}`,
            ),
          ],
          summary: summarize([
            makeCheck(
              "config.load",
              false,
              `failed to load ${configPath}: ${String(err?.message || err)}`,
            ),
          ]),
        },
      ],
    };
    failReport.summary = summarizeAccounts(failReport.accounts);
    reportAndExit(failReport, args.json);
    return;
  }

  const targetAccounts = args.allAccounts
    ? discoverAccountIds(config)
    : [normalizeAccountId(args.account)];
  const accountReports = [];

  for (const accountId of targetAccounts) {
    // Keep checks deterministic and easier to read.
    // eslint-disable-next-line no-await-in-loop
    const report = await runAccountChecks({ config, accountId, args });
    report.checks.unshift(makeCheck("config.load", true, `loaded ${configPath}`));
    report.summary = summarize(report.checks);
    accountReports.push(report);
  }

  const finalReport = {
    args,
    configPath,
    config,
    ...collectWecomMigrationDiagnostics({
      config,
      accountId: args.account,
    }),
    accounts: accountReports,
    summary: summarizeAccounts(accountReports),
  };
  reportAndExit(finalReport, args.json);
}

main().catch((err) => {
  console.error(`Selfcheck failed: ${String(err?.message || err)}`);
  process.exit(1);
});
