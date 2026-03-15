#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWecomGroupChatConfig } from "../src/core.js";
import { normalizeWecomBotGroupChatPolicy } from "../src/wecom/bot-inbound-executor-helpers.js";
import { PLUGIN_VERSION } from "../src/wecom/plugin-constants.js";
import { diagnoseWecomCallbackHealth } from "../src/wecom/callback-health-diagnostics.js";

function parseArgs(argv) {
  const out = {
    account: "default",
    allAccounts: false,
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    url: "",
    fromUser: "",
    content: "/status",
    timeoutMs: 8000,
    pollCount: 12,
    pollIntervalMs: 700,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--account" && next) {
      out.account = normalizeAccountId(next);
      i += 1;
    } else if (arg === "--all-accounts") {
      out.allAccounts = true;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--url" && next) {
      out.url = next;
      i += 1;
    } else if (arg === "--from-user" && next) {
      out.fromUser = next;
      i += 1;
    } else if (arg === "--content" && next) {
      out.content = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
      i += 1;
    } else if (arg === "--poll-count" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollCount = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollIntervalMs = Math.floor(n);
      i += 1;
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
  console.log(`OpenClaw-Wechat Bot selfcheck (E2E)

Usage:
  npm run wecom:bot:selfcheck -- [options]

Options:
  --account <id>            Bot account id (default: default)
  --all-accounts            Run checks for all discovered Bot accounts
  --config <path>            OpenClaw config path (default: ~/.openclaw/openclaw.json)
  --url <http-url>           Override Bot callback URL
  --from-user <userid>       Simulated sender (default: auto-generated)
  --content <text>           Message text to send (default: /status)
  --timeout-ms <ms>          HTTP timeout (default: 8000)
  --poll-count <n>           stream-refresh poll attempts (default: 12)
  --poll-interval-ms <ms>    stream-refresh interval (default: 700)
  --json                     Print JSON report
  -h, --help                 Show this help
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
  if (normalized === "default") return "/wecom/bot/callback";
  return `/wecom/${normalized}/bot/callback`;
}

function normalizeWebhookPath(raw, fallback = "/wecom/bot/callback") {
  const input = String(raw ?? "").trim();
  if (!input) return fallback;
  return input.startsWith("/") ? input : `/${input}`;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
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

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decodeAesKey(aesKey) {
  const keyBase64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid encodingAesKey length: decoded ${key.length} bytes, expected 32`);
  }
  return key;
}

function pkcs7Pad(buf, blockSize = 32) {
  const amountToPad = blockSize - (buf.length % blockSize || blockSize);
  const pad = Buffer.alloc(amountToPad === 0 ? blockSize : amountToPad, amountToPad === 0 ? blockSize : amountToPad);
  return Buffer.concat([buf, pad]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function encryptWecom({ aesKey, plainText, corpId = "" }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msgBuffer = Buffer.from(String(plainText ?? ""), "utf8");
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32BE(msgBuffer.length, 0);
  const corpBuffer = Buffer.from(String(corpId ?? ""), "utf8");
  const raw = Buffer.concat([random16, lenBuffer, msgBuffer, corpBuffer]);
  const padded = pkcs7Pad(raw, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

function decryptWecom({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherTextBase64, "base64")), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);
  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const msg = unpadded.subarray(msgStart, msgEnd).toString("utf8");
  return msg;
}

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return crypto.createHash("sha1").update(arr.join("")).digest("hex");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const timeout = Math.max(1000, Number(timeoutMs) || 8000);
  const requestOptions = {
    ...options,
    signal: AbortSignal.timeout(timeout),
  };
  return fetch(url, requestOptions);
}

function makeCheck(name, ok, detail, data = null) {
  return { name, ok: Boolean(ok), detail: String(detail ?? ""), data };
}

function summarize(checks) {
  const failed = checks.filter((c) => !c.ok).length;
  return {
    ok: failed === 0,
    total: checks.length,
    passed: checks.length - failed,
    failed,
  };
}

function summarizeAccountReports(accountReports = []) {
  const checks = accountReports.flatMap((report) => (Array.isArray(report?.checks) ? report.checks : []));
  const accountsFailed = accountReports.filter((report) => report?.summary?.ok !== true).length;
  return {
    ...summarize(checks),
    accountsTotal: accountReports.length,
    accountsPassed: accountReports.length - accountsFailed,
    accountsFailed,
  };
}

function buildBotOverview({ config = {}, botConfig = {} } = {}) {
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
  const longConnectionEnabled =
    botConfig?.enabled === true &&
    botConfig?.longConnection?.enabled === true &&
    Boolean(String(botConfig?.longConnection?.botId ?? botConfig?.longConnection?.botid ?? "").trim()) &&
    Boolean(String(botConfig?.longConnection?.secret ?? "").trim());
  const webhookEnabled =
    botConfig?.enabled === true &&
    Boolean(String(botConfig?.token ?? "").trim()) &&
    Boolean(String(botConfig?.encodingAesKey ?? "").trim()) &&
    Boolean(String(botConfig?.webhookPath ?? "").trim());
  const canReceive = longConnectionEnabled || webhookEnabled;
  const channel = config?.channels?.wecom ?? {};
  const accountBlock =
    botConfig?.accountId === "default"
      ? channel
      : channel?.accounts && typeof channel.accounts === "object"
        ? channel.accounts[botConfig.accountId] ?? {}
        : {};
  const normalizedGroupPolicy = normalizeWecomBotGroupChatPolicy(
    resolveWecomGroupChatConfig({
      channelConfig: channel,
      accountConfig: accountBlock,
      envVars: config?.env?.vars ?? {},
      processEnv: process.env,
      accountId: botConfig?.accountId || "default",
    }),
  );
  const allowFrom = Array.isArray(normalizedGroupPolicy?.allowFrom) ? normalizedGroupPolicy.allowFrom : [];
  return {
    canReceive,
    canReply: canReceive,
    canSend: canReceive,
    longConnectionEnabled,
    webhookEnabled,
    bindingsCount,
    dynamicAgentEnabled,
    pendingReplyEnabled,
    pendingReplyPersist,
    pendingReplyStoreFile,
    quotaTrackingEnabled,
    reasoningMode,
    reasoningTitle: pickFirstNonEmptyString(reasoningConfig?.title, "思考过程"),
    reasoningMaxChars: Math.max(64, asNumber(reasoningConfig?.maxChars, 1200) || 1200),
    groupPolicy: {
      mode: String(normalizedGroupPolicy?.policyMode ?? "open"),
      trigger: String(normalizedGroupPolicy?.triggerMode ?? "mention"),
      allowSummary:
        normalizedGroupPolicy?.policyMode === "allowlist"
          ? String(allowFrom.length)
          : allowFrom.length > 0 && !allowFrom.includes("*")
            ? `${allowFrom.length}(inactive)`
            : "open",
      groups: Number(normalizedGroupPolicy?.configuredGroupCount || 0),
      source: formatGroupSourceLabel(normalizedGroupPolicy?.policySource),
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverBotAccountIds(config) {
  const accountIds = new Set(["default"]);
  const channelConfig = config?.channels?.wecom;
  const accountEntries = channelConfig?.accounts;
  if (accountEntries && typeof accountEntries === "object") {
    for (const accountId of Object.keys(accountEntries)) {
      accountIds.add(normalizeAccountId(accountId));
    }
  }

  const scopedBotRegex =
    /^WECOM_([A-Z0-9]+)_BOT_(ENABLED|TOKEN|ENCODING_AES_KEY|WEBHOOK_PATH|PLACEHOLDER_TEXT|STREAM_EXPIRE_MS|REPLY_TIMEOUT_MS|LATE_REPLY_WATCH_MS|LATE_REPLY_POLL_MS)$/;
  const collectFromEnv = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      const match = String(key ?? "").match(scopedBotRegex);
      if (!match) continue;
      const accountId = normalizeAccountId(match[1]);
      if (accountId) accountIds.add(accountId);
    }
  };
  collectFromEnv(config?.env?.vars);
  collectFromEnv(process.env);

  return Array.from(accountIds).sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (a !== "default" && b === "default") return 1;
    return a.localeCompare(b);
  });
}

function buildPluginChecks(config) {
  const checks = [];
  const plugins = config?.plugins ?? {};
  const entry = plugins?.entries?.["openclaw-wechat"];
  const allow = Array.isArray(plugins?.allow) ? plugins.allow.map((value) => String(value)) : null;
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

function resolveBotConfig(config) {
  const accountId = normalizeAccountId(config?.accountId ?? "default");
  const channel = config?.channels?.wecom ?? {};
  const accountBlock =
    accountId === "default"
      ? channel
      : channel?.accounts && typeof channel.accounts === "object"
        ? channel.accounts[accountId] ?? {}
        : {};
  const bot =
    accountId === "default"
      ? channel?.bot ?? {}
      : accountBlock?.bot && typeof accountBlock.bot === "object"
        ? accountBlock.bot
        : {};
  const envVars = config?.env?.vars ?? {};
  const accountEnvPrefix = accountId === "default" ? null : `WECOM_${accountId.toUpperCase()}_BOT_`;
  const readBotEnv = (suffix) => {
    const scopedKey = accountEnvPrefix ? `${accountEnvPrefix}${suffix}` : "";
    return pickFirstNonEmptyString(
      scopedKey ? envVars?.[scopedKey] : "",
      scopedKey ? process.env[scopedKey] : "",
      envVars?.[`WECOM_BOT_${suffix}`],
      process.env[`WECOM_BOT_${suffix}`],
    );
  };
  const token = pickFirstNonEmptyString(bot.token, bot.callbackToken, readBotEnv("TOKEN"));
  const encodingAesKey = pickFirstNonEmptyString(bot.encodingAesKey, bot.callbackAesKey, readBotEnv("ENCODING_AES_KEY"));
  const webhookPath = normalizeWebhookPath(
    pickFirstNonEmptyString(bot.webhookPath, readBotEnv("WEBHOOK_PATH")),
    buildDefaultBotWebhookPath(accountId),
  );
  const gatewayPort = asNumber(config?.gateway?.port, 8885);
  const longConnection =
    bot?.longConnection && typeof bot.longConnection === "object"
      ? bot.longConnection
      : {};
  const compatBotId = pickFirstNonEmptyString(accountBlock?.botId, accountBlock?.botid, channel?.botId, channel?.botid);
  const compatSecret = pickFirstNonEmptyString(accountBlock?.secret, channel?.secret);
  const compatLongConnectionEnabled =
    Boolean(pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid, compatBotId)) &&
    Boolean(pickFirstNonEmptyString(longConnection?.secret, compatSecret));
  const enabled = parseBooleanLike(
    bot.enabled,
    parseBooleanLike(readBotEnv("ENABLED"), compatLongConnectionEnabled),
  );
  return {
    accountId,
    enabled,
    token,
    encodingAesKey,
    webhookPath,
    gatewayPort: Math.max(1, gatewayPort || 8885),
    longConnection: {
      ...longConnection,
      enabled:
        longConnection?.enabled === true ||
        (Boolean(pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid, compatBotId)) &&
          Boolean(pickFirstNonEmptyString(longConnection?.secret, compatSecret))),
      botId: pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid, compatBotId),
      secret: pickFirstNonEmptyString(longConnection?.secret, compatSecret),
    },
  };
}

function buildCallbackUrl({ args, botConfig }) {
  if (String(args.url ?? "").trim()) return String(args.url).trim();
  return `http://127.0.0.1:${botConfig.gatewayPort}${botConfig.webhookPath}`;
}

function buildSignedEncryptedRequest({ endpoint, token, aesKey, payload }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString("hex");
  const encrypt = encryptWecom({
    aesKey,
    plainText: JSON.stringify(payload ?? {}),
    corpId: "",
  });
  const msgSignature = computeMsgSignature({
    token,
    timestamp,
    nonce,
    encrypt,
  });
  const url = new URL(endpoint);
  url.searchParams.set("msg_signature", msgSignature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  return {
    requestUrl: url.toString(),
    body: JSON.stringify({ encrypt }),
  };
}

function buildSignedVerifyRequest({ endpoint, token, aesKey, plainEchostr }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString("hex");
  const encryptedEchostr = encryptWecom({
    aesKey,
    plainText: String(plainEchostr ?? ""),
    corpId: "",
  });
  const msgSignature = computeMsgSignature({
    token,
    timestamp,
    nonce,
    encrypt: encryptedEchostr,
  });
  const url = new URL(endpoint);
  url.searchParams.set("msg_signature", msgSignature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("echostr", encryptedEchostr);
  return {
    requestUrl: url.toString(),
    encryptedEchostr,
  };
}

function parseEncryptedCallbackResponse(rawBody) {
  const body = JSON.parse(rawBody);
  const encrypt = String(body?.encrypt ?? "").trim();
  const msgsignature = String(body?.msgsignature ?? body?.msg_signature ?? "").trim();
  const timestamp = String(body?.timestamp ?? "").trim();
  const nonce = String(body?.nonce ?? "").trim();
  if (!encrypt || !msgsignature || !timestamp || !nonce) {
    throw new Error("missing response encrypt/msgsignature/timestamp/nonce");
  }
  return { encrypt, msgsignature, timestamp, nonce };
}

function verifyEncryptedCallbackResponse({ token, aesKey, rawBody }) {
  const parsed = parseEncryptedCallbackResponse(rawBody);
  const expected = computeMsgSignature({
    token,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
    encrypt: parsed.encrypt,
  });
  if (expected !== parsed.msgsignature) {
    throw new Error("response signature mismatch");
  }
  const decryptedText = decryptWecom({
    aesKey,
    cipherTextBase64: parsed.encrypt,
  });
  const payload = JSON.parse(decryptedText);
  return { payload, meta: parsed };
}

async function postEncryptedPayload({ endpoint, token, aesKey, payload, timeoutMs }) {
  const signed = buildSignedEncryptedRequest({
    endpoint,
    token,
    aesKey,
    payload,
  });
  const response = await fetchWithTimeout(
    signed.requestUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: signed.body,
    },
    timeoutMs,
  );
  const rawBody = await response.text();
  return { response, rawBody };
}

function reportAndExit(report, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.ok ? 0 : 1);
    return;
  }

  const accountReports =
    Array.isArray(report?.accounts) && report.accounts.length > 0 ? report.accounts : [report];

  console.log("WeCom Bot E2E selfcheck");
  console.log(`- config: ${report.configPath}`);
  console.log(`- mode: ${report.args?.allAccounts ? "all-accounts" : `single-account (${report.args?.account || "default"})`}`);
  for (const accountReport of accountReports) {
    const overview = buildBotOverview({ config: report.config, botConfig: accountReport.config });
    console.log(`\nAccount: ${accountReport.account}`);
    console.log(`- endpoint: ${accountReport.endpoint}`);
    console.log(`- fromUser: ${accountReport.fromUser}`);
    console.log(`- content: ${accountReport.content}`);
    console.log(
      `- readiness: receive=${overview.canReceive ? "yes" : "no"} reply=${overview.canReply ? "yes" : "no"} send=${overview.canSend ? "yes" : "no"} longConnection=${overview.longConnectionEnabled ? "on" : "off"} webhook=${overview.webhookEnabled ? "on" : "off"}`,
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
    console.log(`- reasoning: mode=${overview.reasoningMode} title=${overview.reasoningTitle} maxChars=${overview.reasoningMaxChars}`);
    for (const check of accountReport.checks) {
      console.log(`${check.ok ? "OK " : "FAIL"} ${check.name} :: ${check.detail}`);
    }
    console.log(`Account summary: ${accountReport.summary.passed}/${accountReport.summary.total} passed`);
  }
  if (report.summary?.accountsTotal != null) {
    console.log(
      `\nSummary: accounts ${report.summary.accountsPassed}/${report.summary.accountsTotal} passed, checks ${report.summary.passed}/${report.summary.total} passed`,
    );
  } else {
    console.log(`\nSummary: ${report.summary.passed}/${report.summary.total} passed`);
  }
  process.exit(report.summary.ok ? 0 : 1);
}

async function runBotE2E({ config, args, configPath, accountId }) {
  const checks = [];
  checks.push(...buildPluginChecks(config));
  const botConfig = resolveBotConfig({
    ...config,
    accountId,
  });
  const endpoint = buildCallbackUrl({ args, botConfig });
  const fromUser =
    String(args.fromUser ?? "").trim() ||
    `DxBotSelfCheck${botConfig.accountId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}${Date.now().toString(36).slice(-6)}`;
  const content = String(args.content ?? "").trim() || "/status";

  checks.push(
    makeCheck(
      "config.account",
      true,
      `account=${botConfig.accountId}`,
    ),
  );
  checks.push(makeCheck("config.bot.enabled", botConfig.enabled, botConfig.enabled ? "enabled" : "disabled"));
  checks.push(makeCheck("config.bot.token", Boolean(botConfig.token), botConfig.token ? "present" : "missing"));
  checks.push(
    makeCheck(
      "config.bot.encodingAesKey",
      Boolean(botConfig.encodingAesKey),
      botConfig.encodingAesKey ? "present" : "missing",
    ),
  );
  checks.push(makeCheck("config.bot.webhookPath", Boolean(botConfig.webhookPath), `path=${botConfig.webhookPath}`));
  checks.push(
    makeCheck(
      "bot.entry.visibility",
      true,
      "Bot 模式在“微信插件入口”通常不会显示为联系人；建议通过机器人会话入口或群聊触发。",
    ),
  );

  let aesKeyValid = false;
  if (botConfig.encodingAesKey) {
    try {
      decodeAesKey(botConfig.encodingAesKey);
      aesKeyValid = true;
      checks.push(makeCheck("config.bot.encodingAesKey.length", true, "decoded-bytes=32"));
    } catch (err) {
      checks.push(
        makeCheck("config.bot.encodingAesKey.length", false, String(err?.message || err)),
      );
    }
  } else {
    checks.push(makeCheck("config.bot.encodingAesKey.length", false, "missing"));
  }

  if (!botConfig.enabled || !botConfig.token || !botConfig.encodingAesKey || !aesKeyValid) {
    const report = {
      configPath,
      account: botConfig.accountId,
      endpoint,
      fromUser,
      content,
      config: botConfig,
      checks,
      summary: summarize(checks),
    };
    return report;
  }

  try {
    const healthResponse = await fetchWithTimeout(
      endpoint,
      { method: "GET", redirect: "manual" },
      Math.min(args.timeoutMs, 4000),
    );
    const healthBody = await healthResponse.text();
    const diagnosed = diagnoseWecomCallbackHealth({
      status: healthResponse.status,
      body: healthBody,
      mode: "bot",
      endpoint,
      webhookPath: botConfig.webhookPath,
      gatewayPort: botConfig.gatewayPort,
      location: healthResponse.headers.get("location") || "",
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

  try {
    const verifyPlain = `bot_selfcheck_verify_${Date.now().toString(36)}`;
    const signedVerify = buildSignedVerifyRequest({
      endpoint,
      token: botConfig.token,
      aesKey: botConfig.encodingAesKey,
      plainEchostr: verifyPlain,
    });
    const verifyResp = await fetchWithTimeout(
      signedVerify.requestUrl,
      { method: "GET" },
      Math.min(args.timeoutMs, 4000),
    );
    const verifyBody = await verifyResp.text();
    const verifyOk = verifyResp.status === 200 && verifyBody === verifyPlain;
    checks.push(
      makeCheck(
        "e2e.url.verify",
        verifyOk,
        verifyOk
          ? "callback verify succeeded"
          : `status=${verifyResp.status} body=${String(verifyBody ?? "").slice(0, 120)}`,
      ),
    );
  } catch (err) {
    checks.push(makeCheck("e2e.url.verify", false, `request failed: ${String(err?.message || err)}`));
  }

  const messagePayload = {
    msgid: `selfcheck_msg_${Date.now()}`,
    msgtype: "text",
    from: {
      userid: fromUser,
    },
    chattype: "single",
    text: {
      content,
    },
  };

  let streamId = "";
  try {
    const first = await postEncryptedPayload({
      endpoint,
      token: botConfig.token,
      aesKey: botConfig.encodingAesKey,
      payload: messagePayload,
      timeoutMs: args.timeoutMs,
    });
    checks.push(makeCheck("e2e.message.post", first.response.status === 200, `status=${first.response.status}`));
    if (first.response.status === 200) {
      const verified = verifyEncryptedCallbackResponse({
        token: botConfig.token,
        aesKey: botConfig.encodingAesKey,
        rawBody: first.rawBody,
      });
      const stream = verified.payload?.stream ?? {};
      streamId = String(stream.id ?? "").trim();
      const isStream = String(verified.payload?.msgtype ?? "").trim() === "stream";
      checks.push(
        makeCheck(
          "e2e.message.response.stream",
          isStream && Boolean(streamId),
          `msgtype=${verified.payload?.msgtype ?? "n/a"} streamId=${streamId || "missing"} finish=${String(stream.finish ?? "n/a")}`,
        ),
      );
    } else {
      checks.push(makeCheck("e2e.message.response.stream", false, `unexpected status=${first.response.status}`));
    }
  } catch (err) {
    checks.push(makeCheck("e2e.message.post", false, `request failed: ${String(err?.message || err)}`));
    checks.push(makeCheck("e2e.message.response.stream", false, "request failed"));
  }

  let finalPayload = null;
  if (streamId) {
    for (let i = 0; i < args.pollCount; i += 1) {
      await sleep(args.pollIntervalMs);
      try {
        const refreshPayload = {
          msgid: `selfcheck_refresh_${Date.now()}_${i}`,
          msgtype: "stream",
          stream: {
            id: streamId,
          },
        };
        const refreshResp = await postEncryptedPayload({
          endpoint,
          token: botConfig.token,
          aesKey: botConfig.encodingAesKey,
          payload: refreshPayload,
          timeoutMs: args.timeoutMs,
        });
        if (refreshResp.response.status !== 200) continue;
        const verified = verifyEncryptedCallbackResponse({
          token: botConfig.token,
          aesKey: botConfig.encodingAesKey,
          rawBody: refreshResp.rawBody,
        });
        const stream = verified.payload?.stream ?? {};
        if (String(stream.id ?? "").trim() !== streamId) continue;
        if (stream.finish === true) {
          finalPayload = verified.payload;
          break;
        }
      } catch {
        // Keep polling until budget is exhausted.
      }
    }
  }

  if (!streamId) {
    checks.push(makeCheck("e2e.stream.refresh", false, "streamId missing"));
  } else if (!finalPayload) {
    checks.push(
      makeCheck(
        "e2e.stream.refresh",
        false,
        `did not observe finish=true within ${args.pollCount} polls`,
      ),
    );
  } else {
    const contentText = String(finalPayload?.stream?.content ?? "");
    const expectedSessionLower = `会话ID：wecom-bot:${fromUser.toLowerCase()}`;
    const expectedSessionRaw = `会话ID：wecom-bot:${fromUser}`;
    const sessionMatched = contentText.includes(expectedSessionLower) || contentText.includes(expectedSessionRaw);
    checks.push(
      makeCheck(
        "e2e.stream.refresh",
        true,
        `finish=true contentBytes=${Buffer.byteLength(contentText, "utf8")}`,
      ),
    );
    checks.push(
      makeCheck(
        "e2e.stream.content",
        sessionMatched,
        sessionMatched
          ? `contains expected session marker (${expectedSessionRaw} / ${expectedSessionLower})`
          : `missing expected session marker (${expectedSessionRaw} / ${expectedSessionLower})`,
      ),
    );
  }

  return {
    configPath,
    account: botConfig.accountId,
    endpoint,
    fromUser,
    content,
    config: botConfig,
    overview: buildBotOverview({ config, botConfig }),
    checks,
    summary: summarize(checks),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(expandHome(args.configPath));
  if (args.allAccounts && String(args.url ?? "").trim()) {
    throw new Error("--url cannot be used with --all-accounts (each account has its own webhookPath)");
  }
  let config;
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    const accountReport = {
      configPath,
      account: normalizeAccountId(args.account),
      endpoint: "",
      fromUser: args.fromUser || "",
      content: args.content || "",
      config: null,
      checks: [
        makeCheck("config.load", false, `failed to load ${configPath}: ${String(err?.message || err)}`),
      ],
    };
    accountReport.summary = summarize(accountReport.checks);
    const report = {
      args,
      configPath,
      accounts: [accountReport],
      summary: summarizeAccountReports([accountReport]),
    };
    reportAndExit(report, args.json);
    return;
  }

  const targetAccounts = args.allAccounts ? discoverBotAccountIds(config) : [normalizeAccountId(args.account)];
  const accountReports = [];
  for (const accountId of targetAccounts) {
    // Keep checks deterministic and easier to read.
    // eslint-disable-next-line no-await-in-loop
    const report = await runBotE2E({ config, args, configPath, accountId });
    report.checks.unshift(makeCheck("config.load", true, `loaded ${configPath}`));
    report.summary = summarize(report.checks);
    accountReports.push(report);
  }

  const report = {
    args,
    configPath,
    config,
    accounts: accountReports,
    summary: summarizeAccountReports(accountReports),
  };
  reportAndExit(report, args.json);
}

main().catch((err) => {
  console.error(`Bot selfcheck failed: ${String(err?.message || err)}`);
  process.exit(1);
});
