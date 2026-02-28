#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

function asNumber(v, fallback = null) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function normalizeWebhookPath(raw, fallback = "/wecom/callback") {
  const input = String(raw ?? "").trim();
  if (!input) return fallback;
  return input.startsWith("/") ? input : `/${input}`;
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

  return checks;
}

function readAccountConfigFromEnv(envVars, accountId) {
  const normalizedId = normalizeAccountId(accountId);
  const prefix = normalizedId === "default" ? "WECOM" : `WECOM_${normalizedId.toUpperCase()}`;
  const readVar = (suffix) =>
    envVars?.[`${prefix}_${suffix}`] ??
    (normalizedId === "default" ? envVars?.[`WECOM_${suffix}`] : undefined) ??
    process.env[`${prefix}_${suffix}`] ??
    (normalizedId === "default" ? process.env[`WECOM_${suffix}`] : undefined);

  const corpId = String(readVar("CORP_ID") ?? "").trim();
  const corpSecret = String(readVar("CORP_SECRET") ?? "").trim();
  const agentId = asNumber(readVar("AGENT_ID"));
  const callbackToken = String(readVar("CALLBACK_TOKEN") ?? "").trim();
  const callbackAesKey = String(readVar("CALLBACK_AES_KEY") ?? "").trim();
  const webhookPath = String(readVar("WEBHOOK_PATH") ?? "/wecom/callback").trim() || "/wecom/callback";
  const enabled = !isFalseLike(readVar("ENABLED"));

  if (!corpId || !corpSecret || !agentId) return null;
  return {
    accountId: normalizedId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    webhookPath,
    enabled,
    source: "env",
  };
}

function normalizeResolvedAccount(raw, accountId, source) {
  if (!raw || typeof raw !== "object") return null;
  const resolvedId = normalizeAccountId(accountId);
  const corpId = String(raw.corpId ?? "").trim();
  const corpSecret = String(raw.corpSecret ?? "").trim();
  const agentId = asNumber(raw.agentId);
  const callbackToken = String(raw.callbackToken ?? "").trim();
  const callbackAesKey = String(raw.callbackAesKey ?? "").trim();
  const webhookPath = String(raw.webhookPath ?? "/wecom/callback").trim() || "/wecom/callback";
  const enabled = raw.enabled !== false;
  if (!corpId || !corpSecret || !agentId) return null;
  return {
    accountId: resolvedId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    webhookPath,
    enabled,
    source,
  };
}

function resolveAccountFromConfig(config, accountId, options = {}) {
  const allowFallback = options.allowFallback !== false;
  const normalizedId = normalizeAccountId(accountId);
  const channelConfig = config?.channels?.wecom;
  const envVars = config?.env?.vars ?? {};

  if (channelConfig && normalizedId === "default") {
    const byTop = normalizeResolvedAccount(channelConfig, "default", "channels.wecom");
    if (byTop) return byTop;
  }

  const byAccounts = normalizeResolvedAccount(
    channelConfig?.accounts?.[normalizedId],
    normalizedId,
    `channels.wecom.accounts.${normalizedId}`,
  );
  if (byAccounts) return byAccounts;

  const byEnv = readAccountConfigFromEnv(envVars, normalizedId);
  if (byEnv) return byEnv;

  if (allowFallback && normalizedId !== "default") {
    const fallbackDefault =
      normalizeResolvedAccount(channelConfig, "default", "channels.wecom") ||
      normalizeResolvedAccount(channelConfig?.accounts?.default, "default", "channels.wecom.accounts.default") ||
      readAccountConfigFromEnv(envVars, "default");
    if (fallbackDefault) return { ...fallbackDefault, accountId: "default", fallbackFor: normalizedId };
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

  const harvest = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      const m = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
      if (!m) continue;
      if (m[1] === "CORP") ids.add("default");
      else ids.add(m[1].toLowerCase());
    }
  };

  harvest(envVars);
  harvest(process.env);

  if (ids.size === 0) ids.add("default");

  const ordered = Array.from(ids);
  ordered.sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (a !== "default" && b === "default") return 1;
    return a.localeCompare(b);
  });
  return ordered;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
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

  const required = [
    ["corpId", resolved.corpId],
    ["corpSecret", resolved.corpSecret],
    ["agentId", resolved.agentId],
    ["callbackToken", resolved.callbackToken],
    ["callbackAesKey", resolved.callbackAesKey],
  ];
  for (const [k, v] of required) {
    checks.push(makeCheck(`config.${k}`, Boolean(v), v ? "ok" : "missing"));
  }

  const aes = decodeAesKey(resolved.callbackAesKey || "");
  checks.push(
    makeCheck(
      "config.callbackAesKey.length",
      aes?.length === 32,
      `decoded-bytes=${aes?.length ?? 0} (expected 32)`,
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

  if (!args.skipNetwork && resolved.enabled !== false && resolved.corpId && resolved.corpSecret) {
    const tokenUrl =
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(resolved.corpId)}` +
      `&corpsecret=${encodeURIComponent(resolved.corpSecret)}`;
    try {
      const tokenResp = await fetchJsonWithTimeout(tokenUrl, args.timeoutMs);
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
        const cbIpUrl = `https://qyapi.weixin.qq.com/cgi-bin/getcallbackip?access_token=${encodeURIComponent(token)}`;
        const cbIpResp = await fetchJsonWithTimeout(cbIpUrl, args.timeoutMs);
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
      const resp = await fetchJsonWithTimeout(localWebhookUrl, Math.min(args.timeoutMs, 4000));
      const raw = resp.json?.raw ?? "";
      const healthy = resp.status === 200 && String(raw).includes("wecom webhook");
      checks.push(
        makeCheck(
          "local.webhook.health",
          healthy,
          `status=${resp.status} body=${String(raw).slice(0, 120)}`,
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
      fallbackFor: resolved.fallbackFor || null,
    },
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

  for (const accountReport of report.accounts) {
    console.log(`\nAccount: ${accountReport.accountId}`);
    if (accountReport.resolved) {
      const meta = accountReport.resolved;
      console.log(
        `- resolved: ${meta.accountId} source=${meta.source}${meta.fallbackFor ? ` fallback-for=${meta.fallbackFor}` : ""}`,
      );
      console.log(`- webhookPath: ${meta.webhookPath}`);
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
    accounts: accountReports,
    summary: summarizeAccounts(accountReports),
  };
  reportAndExit(finalReport, args.json);
}

main().catch((err) => {
  console.error(`Selfcheck failed: ${String(err?.message || err)}`);
  process.exit(1);
});
