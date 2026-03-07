#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectWecomEnvAccountIds as collectSharedWecomEnvAccountIds,
  createRequireEnv as createSharedRequireEnv,
  normalizeAccountConfig as normalizeSharedAccountConfig,
  readAccountConfigFromEnv as readSharedAccountConfigFromEnv,
} from "../src/wecom/account-config-core.js";
import { buildDefaultAgentWebhookPath, buildLegacyAgentWebhookPath } from "../src/wecom/account-paths.js";
import { diagnoseWecomCallbackHealth } from "../src/wecom/callback-health-diagnostics.js";

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

function parseArgs(argv) {
  const out = {
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    account: "default",
    allAccounts: false,
    url: "",
    fromUser: "",
    content: "/status",
    timeoutMs: 8000,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--account" && next) {
      out.account = next;
      i += 1;
    } else if (arg === "--all-accounts") {
      out.allAccounts = true;
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
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n);
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
  console.log(`OpenClaw-Wechat Agent selfcheck (URL verify + encrypted POST)

Usage:
  npm run wecom:agent:selfcheck -- [options]

Options:
  --config <path>          OpenClaw config path (default: ~/.openclaw/openclaw.json)
  --account <id>           account id (default: default)
  --all-accounts           run checks for all discovered Agent accounts
  --url <http-url>         override callback URL
  --from-user <userid>     simulated sender
  --content <text>         inbound text content (default: /status)
  --timeout-ms <ms>        HTTP timeout (default: 8000)
  --json                   print JSON report
  -h, --help               show this help
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

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function isFalseLike(value) {
  return ["0", "false", "off", "no"].includes(String(value ?? "").trim().toLowerCase());
}

function decodeAesKey(aesKey) {
  const keyBase64 = String(aesKey ?? "").endsWith("=") ? aesKey : `${aesKey}=`;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid callbackAesKey length: decoded ${key.length} bytes, expected 32`);
  }
  return key;
}

function pkcs7Pad(buf, blockSize = 32) {
  const amountToPad = blockSize - (buf.length % blockSize || blockSize);
  const pad = Buffer.alloc(amountToPad === 0 ? blockSize : amountToPad, amountToPad === 0 ? blockSize : amountToPad);
  return Buffer.concat([buf, pad]);
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

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return crypto.createHash("sha1").update(arr.join("")).digest("hex");
}

function buildTextInboundXml({ fromUser, content, msgId }) {
  const safeFromUser = String(fromUser ?? "").trim();
  const safeContent = String(content ?? "").trim();
  const safeMsgId = String(msgId ?? "").trim();
  const nowTs = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[openclaw-selfcheck]]></ToUserName>
<FromUserName><![CDATA[${safeFromUser}]]></FromUserName>
<CreateTime>${nowTs}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${safeContent}]]></Content>
<MsgId>${safeMsgId}</MsgId>
</xml>`;
}

function buildEncryptedPostBody(encrypt) {
  return `<xml>
<ToUserName><![CDATA[openclaw-selfcheck]]></ToUserName>
<Encrypt><![CDATA[${encrypt}]]></Encrypt>
</xml>`;
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

function resolveAccountFromConfig(config, accountId) {
  const normalizedId = normalizeAccountId(accountId);
  const channelConfig = config?.channels?.wecom ?? {};
  const envVars = config?.env?.vars ?? {};
  const requireEnv = createSharedRequireEnv(process.env);

  const pickFromRaw = (raw, resolvedId, source) => {
    const normalized = normalizeSharedAccountConfig({
      raw,
      accountId: resolvedId,
      normalizeWecomWebhookTargetMap: () => ({}),
    });
    if (!normalized) return null;
    return {
      ...normalized,
      source,
    };
  };

  const readEnv = (targetAccountId) => {
    const normalized = readSharedAccountConfigFromEnv({
      envVars,
      accountId: targetAccountId,
      requireEnv,
      normalizeWecomWebhookTargetMap: () => ({}),
    });
    if (!normalized) return null;
    return {
      ...normalized,
      source: "env",
    };
  };

  if (normalizedId === "default") {
    return (
      pickFromRaw(channelConfig, "default", "channels.wecom") ||
      pickFromRaw(channelConfig?.accounts?.default, "default", "channels.wecom.accounts.default") ||
      readEnv("default")
    );
  }

  return (
    pickFromRaw(channelConfig?.accounts?.[normalizedId], normalizedId, `channels.wecom.accounts.${normalizedId}`) ||
    pickFromRaw(channelConfig?.[normalizedId], normalizedId, `channels.wecom.${normalizedId}`) ||
    readEnv(normalizedId) ||
    pickFromRaw(channelConfig, "default", "channels.wecom") ||
    pickFromRaw(channelConfig?.accounts?.default, "default", "channels.wecom.accounts.default") ||
    readEnv("default")
  );
}

function discoverAgentAccountIds(config) {
  const ids = new Set();
  const channelConfig = config?.channels?.wecom;
  const envVars = config?.env?.vars ?? {};

  if (resolveAccountFromConfig(config, "default")) ids.add("default");

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

function buildCallbackUrl({ args, account, config }) {
  if (String(args.url ?? "").trim()) return String(args.url).trim();
  const gatewayPort = asNumber(config?.gateway?.port, 8885);
  const webhookPath = String(account?.webhookPath ?? "/wecom/callback").trim() || "/wecom/callback";
  const normalizedPath = webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`;
  return `http://127.0.0.1:${gatewayPort}${normalizedPath}`;
}

function normalizeHttpPath(pathname) {
  const text = String(pathname ?? "").trim();
  if (!text) return "/";
  const prefixed = text.startsWith("/") ? text : `/${text}`;
  if (prefixed.length > 1 && prefixed.endsWith("/")) return prefixed.slice(0, -1);
  return prefixed;
}

function buildLegacyAliasUrl(endpoint, accountId) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "";
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const currentPath = normalizeHttpPath(parsed.pathname);
  const defaultPath = normalizeHttpPath(buildDefaultAgentWebhookPath(normalizedAccountId));
  if (currentPath !== defaultPath) return "";
  const legacyPath = normalizeHttpPath(buildLegacyAgentWebhookPath(normalizedAccountId));
  if (!legacyPath || legacyPath === currentPath) return "";
  parsed.pathname = legacyPath;
  parsed.search = "";
  return parsed.toString();
}

function buildSignedUrl(endpoint, token, encrypt) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString("hex");
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
  return url;
}

function reportAndExit(report, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.ok ? 0 : 1);
    return;
  }
  const accountReports =
    Array.isArray(report?.accounts) && report.accounts.length > 0 ? report.accounts : [report];
  console.log("WeCom Agent selfcheck");
  console.log(`- config: ${report.configPath}`);
  console.log(`- mode: ${report.args?.allAccounts ? "all-accounts" : `single-account (${report.args?.account || "default"})`}`);
  for (const accountReport of accountReports) {
    console.log(`\nAccount: ${accountReport.accountId}`);
    console.log(`- endpoint: ${accountReport.endpoint}`);
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

async function runAgentE2E({ config, args, configPath, accountId }) {
  const checks = [];
  const account = resolveAccountFromConfig(config, accountId);
  const endpoint = buildCallbackUrl({ args, account, config });
  const legacyAliasEndpoint = buildLegacyAliasUrl(endpoint, account?.accountId ?? accountId);
  const generatedSuffix = `${normalizeAccountId(accountId).replace(/[^a-z0-9]/gi, "").slice(0, 8)}${Date.now().toString(36).slice(-6)}`;
  const fromUser = String(args.fromUser ?? "").trim() || `DxAgentSelfCheck${generatedSuffix}`;
  const content = String(args.content ?? "").trim() || "/status";
  const msgId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  checks.push(makeCheck("config.account", Boolean(account), account ? `source=${account.source}` : "missing"));
  if (!account) {
    return {
      configPath,
      endpoint,
      accountId: normalizeAccountId(accountId),
      checks,
      summary: summarize(checks),
    };
  }

  checks.push(makeCheck("config.enabled", account.enabled !== false, account.enabled === false ? "disabled" : "enabled"));
  checks.push(makeCheck("config.callbackToken", Boolean(account.callbackToken), account.callbackToken ? "present" : "missing"));
  checks.push(
    makeCheck("config.callbackAesKey", Boolean(account.callbackAesKey), account.callbackAesKey ? "present" : "missing"),
  );
  checks.push(makeCheck("config.webhookPath", Boolean(account.webhookPath), `path=${account.webhookPath || ""}`));

  let aesValid = false;
  if (account.callbackAesKey) {
    try {
      decodeAesKey(account.callbackAesKey);
      aesValid = true;
      checks.push(makeCheck("config.callbackAesKey.length", true, "decoded-bytes=32"));
    } catch (err) {
      checks.push(makeCheck("config.callbackAesKey.length", false, String(err?.message || err)));
    }
  } else {
    checks.push(makeCheck("config.callbackAesKey.length", false, "missing"));
  }

  if (account.enabled === false || !account.callbackToken || !account.callbackAesKey || !aesValid) {
    return {
      configPath,
      endpoint,
      accountId: account.accountId,
      checks,
      summary: summarize(checks),
    };
  }

  try {
    const healthResponse = await fetchWithTimeout(
      endpoint,
      { method: "GET", redirect: "manual" },
      Math.min(args.timeoutMs, 4000),
    );
    const healthBody = await healthResponse.text();
    const diagnosis = diagnoseWecomCallbackHealth({
      status: healthResponse.status,
      body: healthBody,
      mode: "agent",
      endpoint,
      webhookPath: new URL(endpoint).pathname,
      location: healthResponse.headers.get("location") || "",
    });
    checks.push(
      makeCheck(
        "e2e.health.get",
        diagnosis.ok,
        diagnosis.detail,
        diagnosis.data,
      ),
    );
  } catch (err) {
    checks.push(makeCheck("e2e.health.get", false, `request failed: ${String(err?.message || err)}`));
  }

  if (legacyAliasEndpoint) {
    try {
      const healthResponse = await fetchWithTimeout(
        legacyAliasEndpoint,
        { method: "GET", redirect: "manual" },
        Math.min(args.timeoutMs, 4000),
      );
      const healthBody = await healthResponse.text();
      const diagnosis = diagnoseWecomCallbackHealth({
        status: healthResponse.status,
        body: healthBody,
        mode: "agent",
        endpoint: legacyAliasEndpoint,
        webhookPath: new URL(legacyAliasEndpoint).pathname,
        location: healthResponse.headers.get("location") || "",
      });
      checks.push(
        makeCheck(
          "e2e.health.get.legacyAlias",
          diagnosis.ok,
          diagnosis.detail,
          diagnosis.data,
        ),
      );
    } catch (err) {
      checks.push(makeCheck("e2e.health.get.legacyAlias", false, `request failed: ${String(err?.message || err)}`));
    }
  }

  try {
    const plainEchostr = `agent-echostr-${Date.now().toString(36)}`;
    const encryptedEchostr = encryptWecom({
      aesKey: account.callbackAesKey,
      plainText: plainEchostr,
      corpId: account.corpId,
    });
    const verifyUrl = buildSignedUrl(endpoint, account.callbackToken, encryptedEchostr);
    verifyUrl.searchParams.set("echostr", encryptedEchostr);
    const verifyResponse = await fetchWithTimeout(verifyUrl.toString(), { method: "GET" }, args.timeoutMs);
    const verifyBody = await verifyResponse.text();
    const matched = verifyResponse.status === 200 && verifyBody === plainEchostr;
    checks.push(
      makeCheck(
        "e2e.url.verify",
        matched,
        `status=${verifyResponse.status} bodyMatched=${matched}`,
      ),
    );
  } catch (err) {
    checks.push(makeCheck("e2e.url.verify", false, `request failed: ${String(err?.message || err)}`));
  }

  if (legacyAliasEndpoint) {
    try {
      const plainEchostr = `agent-legacy-echostr-${Date.now().toString(36)}`;
      const encryptedEchostr = encryptWecom({
        aesKey: account.callbackAesKey,
        plainText: plainEchostr,
        corpId: account.corpId,
      });
      const verifyUrl = buildSignedUrl(legacyAliasEndpoint, account.callbackToken, encryptedEchostr);
      verifyUrl.searchParams.set("echostr", encryptedEchostr);
      const verifyResponse = await fetchWithTimeout(verifyUrl.toString(), { method: "GET" }, args.timeoutMs);
      const verifyBody = await verifyResponse.text();
      const matched = verifyResponse.status === 200 && verifyBody === plainEchostr;
      checks.push(
        makeCheck(
          "e2e.url.verify.legacyAlias",
          matched,
          `status=${verifyResponse.status} bodyMatched=${matched}`,
        ),
      );
    } catch (err) {
      checks.push(makeCheck("e2e.url.verify.legacyAlias", false, `request failed: ${String(err?.message || err)}`));
    }
  }

  try {
    const plaintextXml = buildTextInboundXml({
      fromUser,
      content,
      msgId,
    });
    const encryptedXml = encryptWecom({
      aesKey: account.callbackAesKey,
      plainText: plaintextXml,
      corpId: account.corpId,
    });
    const postUrl = buildSignedUrl(endpoint, account.callbackToken, encryptedXml).toString();
    const postBody = buildEncryptedPostBody(encryptedXml);
    const postResponse = await fetchWithTimeout(
      postUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
        },
        body: postBody,
      },
      args.timeoutMs,
    );
    const postText = await postResponse.text();
    const accepted = postResponse.status === 200 && String(postText ?? "").trim().toLowerCase() === "success";
    checks.push(
      makeCheck(
        "e2e.message.post",
        accepted,
        `status=${postResponse.status} body=${String(postText ?? "").slice(0, 120)}`,
      ),
    );
  } catch (err) {
    checks.push(makeCheck("e2e.message.post", false, `request failed: ${String(err?.message || err)}`));
  }

  return {
    configPath,
    endpoint,
    accountId: account.accountId,
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
    const report = {
      args,
      configPath,
      accounts: [
        {
          configPath,
          endpoint: "",
          accountId: normalizeAccountId(args.account),
          checks: [
            makeCheck("config.load", false, `failed to load ${configPath}: ${String(err?.message || err)}`),
          ],
        },
      ],
    };
    report.accounts[0].summary = summarize(report.accounts[0].checks);
    report.summary = summarizeAccountReports(report.accounts);
    reportAndExit(report, args.json);
    return;
  }

  const targetAccounts = args.allAccounts ? discoverAgentAccountIds(config) : [normalizeAccountId(args.account)];
  const accountReports = [];
  for (const accountId of targetAccounts) {
    // Keep output deterministic and easier to scan.
    // eslint-disable-next-line no-await-in-loop
    const report = await runAgentE2E({ config, args, configPath, accountId });
    report.checks.unshift(makeCheck("config.load", true, `loaded ${configPath}`));
    report.summary = summarize(report.checks);
    accountReports.push(report);
  }

  const report = {
    args,
    configPath,
    accounts: accountReports,
    summary: summarizeAccountReports(accountReports),
  };
  reportAndExit(report, args.json);
}

main().catch((err) => {
  console.error(`Agent selfcheck failed: ${String(err?.message || err)}`);
  process.exit(1);
});
