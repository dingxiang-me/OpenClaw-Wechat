#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { listLegacyInlineAccountEntries } from "../src/wecom/account-config.js";
import { collectWecomEnvAccountIds, normalizeAccountId } from "../src/wecom/account-config-core.js";
import { resolveWecomProxyConfig } from "../src/core.js";
import { collectWecomMigrationDiagnostics } from "../src/wecom/migration-diagnostics.js";
import {
  WECOM_DOCTOR_COMMAND,
  WECOM_QUICKSTART_MIGRATION_COMMAND,
  WECOM_QUICKSTART_SETUP_COMMAND,
  WECOM_QUICKSTART_WIZARD_COMMAND,
} from "../src/wecom/quickstart-metadata.js";
import { resolveWecomApiBaseUrl } from "../src/wecom/network-config.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WECOM_PLUGIN_ENTRY_ID = "openclaw-wechat";
const SCRIPT_PATHS = Object.freeze({
  selfcheck: path.join(SCRIPT_DIR, "wecom-selfcheck.mjs"),
  agentSelfcheck: path.join(SCRIPT_DIR, "wecom-agent-selfcheck.mjs"),
  botSelfcheck: path.join(SCRIPT_DIR, "wecom-bot-selfcheck.mjs"),
  botLongconnProbe: path.join(SCRIPT_DIR, "wecom-bot-longconn-probe.mjs"),
  callbackMatrix: path.join(SCRIPT_DIR, "wecom-callback-matrix.mjs"),
});
let sharedNonTtyAnswersPromise = null;
let sharedNonTtyAnswerIndex = 0;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
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

function normalizeYesNo(answer, fallback = false) {
  const normalized = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
  return fallback;
}

async function readStdinLines() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      resolve(raw.split(/\r?\n/));
    });
    process.stdin.on("error", reject);
  });
}

async function createPrompt() {
  if (process.stdin.isTTY) {
    return createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stderr.isTTY === true,
    });
  }
  if (!sharedNonTtyAnswersPromise) {
    sharedNonTtyAnswersPromise = readStdinLines();
  }
  const answers = await sharedNonTtyAnswersPromise;
  return {
    output: process.stderr,
    async question(prompt) {
      this.output.write(prompt);
      const answer = answers[sharedNonTtyAnswerIndex] ?? "";
      sharedNonTtyAnswerIndex += 1;
      this.output.write(answer ? `${answer}\n` : "\n");
      return answer;
    },
    close() {},
  };
}

async function askBoolean(rl, message, defaultValue = false) {
  const label = defaultValue ? "Y/n" : "y/N";
  const answer = await rl.question(`${message} [${label}]: `);
  return normalizeYesNo(answer, defaultValue);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== "object") return patch;
  const out = { ...asObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeDeep(asObject(base?.[key]), value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectChangedPaths(baseValue, patchValue, prefix = "", out = []) {
  if (Array.isArray(patchValue)) {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  if (!patchValue || typeof patchValue !== "object") {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(patchValue)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const nextBase = baseValue && typeof baseValue === "object" ? baseValue[key] : undefined;
    collectChangedPaths(nextBase, value, nextPrefix, out);
  }
  return out;
}

function deleteNestedPath(target, dottedPath = "") {
  const parts = String(dottedPath ?? "").split(".").filter(Boolean);
  if (parts.length === 0) return;
  const stack = [];
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return;
    stack.push([cursor, part]);
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return;
  delete cursor[parts.at(-1)];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const [parent, key] = stack[index];
    const child = parent?.[key];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    }
  }
}

function buildMigratedConfig(baseConfig, patch, legacyFields = []) {
  const merged = mergeDeep(baseConfig, patch);
  for (const field of legacyFields) {
    deleteNestedPath(merged, field?.path);
  }
  return merged;
}

function ensureArrayIncludes(values, item) {
  const out = Array.isArray(values) ? values.slice() : [];
  if (!out.includes(item)) out.push(item);
  return out;
}

function buildDoctorFixPatch(config = {}, diagnostics = {}) {
  const patch = diagnostics?.configPatch ? mergeDeep({}, diagnostics.configPatch) : {};
  const hasWecomConfig = Object.keys(asObject(config?.channels?.wecom)).length > 0;
  if (!hasWecomConfig) {
    return Object.keys(patch).length > 0 ? patch : null;
  }

  const currentPlugins = asObject(config?.plugins);
  const currentEntries = asObject(currentPlugins?.entries);
  if (currentPlugins.enabled !== true) {
    patch.plugins = mergeDeep(asObject(patch.plugins), { enabled: true });
  }
  const desiredAllow = ensureArrayIncludes(currentPlugins.allow, WECOM_PLUGIN_ENTRY_ID);
  if (!valuesEqual(currentPlugins.allow, desiredAllow)) {
    patch.plugins = mergeDeep(asObject(patch.plugins), { allow: desiredAllow });
  }
  if (currentEntries?.[WECOM_PLUGIN_ENTRY_ID]?.enabled !== true) {
    patch.plugins = mergeDeep(asObject(patch.plugins), {
      entries: {
        [WECOM_PLUGIN_ENTRY_ID]: { enabled: true },
      },
    });
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function buildBackupPath(configPath) {
  return `${configPath}.bak-${Date.now()}`;
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(expandHome(configPath));
  try {
    const raw = await readFile(resolvedPath, "utf8");
    return {
      exists: true,
      configPath: resolvedPath,
      config: JSON.parse(raw),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        exists: false,
        configPath: resolvedPath,
        config: {},
      };
    }
    throw err;
  }
}

async function writeMergedConfig(configPath, patch) {
  const loaded = await loadConfig(configPath);
  const changedPaths = collectChangedPaths(loaded.config, patch);
  const merged = mergeDeep(loaded.config, patch);
  const backupPath = loaded.exists ? buildBackupPath(loaded.configPath) : null;
  await mkdir(path.dirname(loaded.configPath), { recursive: true });
  if (loaded.exists) {
    await writeFile(backupPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  }
  await writeFile(loaded.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    applied: true,
    configPath: loaded.configPath,
    backupPath,
    existed: loaded.exists,
    changedPaths,
  };
}

async function writeDoctorFixConfig(configPath, patch, legacyFields = []) {
  const loaded = await loadConfig(configPath);
  const merged = buildMigratedConfig(loaded.config, patch, legacyFields);
  const changedPaths = collectChangedPaths(loaded.config, merged);
  const backupPath = loaded.exists ? buildBackupPath(loaded.configPath) : null;
  await mkdir(path.dirname(loaded.configPath), { recursive: true });
  if (loaded.exists) {
    await writeFile(backupPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  }
  await writeFile(loaded.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    applied: true,
    configPath: loaded.configPath,
    backupPath,
    existed: loaded.exists,
    changedPaths,
  };
}

function formatPreviewValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function collectPatchPreviewLines(value, prefix = "", out = []) {
  if (Array.isArray(value)) {
    out.push(`${prefix} = ${formatPreviewValue(value)}`);
    return out;
  }
  if (!value || typeof value !== "object") {
    out.push(`${prefix} = ${formatPreviewValue(value)}`);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    collectPatchPreviewLines(child, childPrefix, out);
  }
  return out;
}

function parseArgs(argv) {
  const out = {
    account: "default",
    allAccounts: false,
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    timeoutMs: 8000,
    skipNetwork: false,
    skipLocalWebhook: false,
    skipAgentE2E: false,
    skipBotE2E: false,
    skipLongconn: false,
    skipCallbackMatrix: false,
    fix: false,
    confirmFix: false,
    agentUrl: "",
    botUrl: "",
    agentLegacyUrl: "",
    botLegacyUrl: "",
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--account" && next) {
      out.account = normalizeAccountId(next);
      index += 1;
    } else if (arg === "--all-accounts") {
      out.allAccounts = true;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) out.timeoutMs = Math.floor(parsed);
      index += 1;
    } else if (arg === "--skip-network") {
      out.skipNetwork = true;
    } else if (arg === "--skip-local-webhook") {
      out.skipLocalWebhook = true;
    } else if (arg === "--skip-agent-e2e") {
      out.skipAgentE2E = true;
    } else if (arg === "--skip-bot-e2e") {
      out.skipBotE2E = true;
    } else if (arg === "--skip-longconn") {
      out.skipLongconn = true;
    } else if (arg === "--skip-callback-matrix") {
      out.skipCallbackMatrix = true;
    } else if (arg === "--fix") {
      out.fix = true;
    } else if (arg === "--confirm-fix") {
      out.confirmFix = true;
      out.fix = true;
    } else if (arg === "--agent-url" && next) {
      out.agentUrl = String(next).trim();
      index += 1;
    } else if (arg === "--bot-url" && next) {
      out.botUrl = String(next).trim();
      index += 1;
    } else if (arg === "--agent-legacy-url" && next) {
      out.agentLegacyUrl = String(next).trim();
      index += 1;
    } else if (arg === "--bot-legacy-url" && next) {
      out.botLegacyUrl = String(next).trim();
      index += 1;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (out.allAccounts && (out.agentUrl || out.botUrl || out.agentLegacyUrl || out.botLegacyUrl)) {
    throw new Error("--agent-url/--bot-url overrides cannot be used together with --all-accounts");
  }
  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat doctor

Usage:
  npm run wecom:doctor -- [options]

Options:
  --account <id>            account id to diagnose (default: default)
  --all-accounts            diagnose all discovered accounts
  --config <path>           OpenClaw config path (default: ~/.openclaw/openclaw.json)
  --timeout-ms <ms>         timeout for each network diagnostic (default: 8000)
  --skip-network            skip all remote/e2e diagnostics and keep local migration/selfcheck only
  --skip-local-webhook      pass through to wecom:selfcheck
  --skip-agent-e2e          skip agent callback e2e checks
  --skip-bot-e2e            skip bot callback e2e checks
  --skip-longconn           skip Bot long connection probe
  --skip-callback-matrix    skip public callback matrix checks
  --fix                     apply the generated local migration patch before rerunning doctor
  --confirm-fix             preview fix patch and ask before applying it
  --agent-url <url>         override public Agent callback URL for callback matrix (single-account only)
  --bot-url <url>           override public Bot callback URL for callback matrix (single-account only)
  --agent-legacy-url <url>  optional legacy Agent alias URL for callback matrix
  --bot-legacy-url <url>    optional legacy Bot alias URL for callback matrix
  --json                    print machine-readable JSON report
  -h, --help                show this help
`);
}

function makeSkippedSection(id, title, reason, command = "") {
  return {
    id,
    title,
    status: "skipped",
    ok: true,
    command: command || undefined,
    summary: reason,
    detail: reason,
    report: null,
  };
}

function buildAccountCommand(baseCommand, args = [], { redact = [] } = {}) {
  const hidden = new Set(redact);
  const parts = [baseCommand];
  for (let index = 0; index < args.length; index += 1) {
    const part = String(args[index] ?? "");
    if (hidden.has(part)) {
      parts.push(part, "<redacted>");
      index += 1;
      continue;
    }
    parts.push(part.includes(" ") ? JSON.stringify(part) : part);
  }
  return parts.join(" ");
}

function buildSection(id, title, ok, summary, detail, command, report) {
  return {
    id,
    title,
    status: ok ? "ok" : "failed",
    ok: Boolean(ok),
    command,
    summary,
    detail,
    report,
  };
}

function summarizeChecks(summary = {}) {
  const passed = Number(summary?.passed ?? 0);
  const total = Number(summary?.total ?? 0);
  return `${passed}/${total} passed`;
}

function sanitizeResultOutput(stdout = "", stderr = "") {
  const stdoutText = String(stdout ?? "").trim();
  const stderrText = String(stderr ?? "").trim();
  return pickFirstNonEmptyString(stderrText, stdoutText);
}

function parseJsonMaybe(text = "") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function runJsonScript(scriptPath, scriptArgs, command) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        command,
        args: scriptArgs.slice(),
        exitCode: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
        parsed: parseJsonMaybe(stdout),
      });
    });
  });
}

function discoverConfiguredAccountIds(config = {}) {
  const ids = new Set();
  const channel = config?.channels?.wecom;
  if (channel && typeof channel === "object") ids.add("default");
  if (channel?.accounts && typeof channel.accounts === "object") {
    for (const key of Object.keys(channel.accounts)) ids.add(normalizeAccountId(key));
  }
  for (const [accountId] of listLegacyInlineAccountEntries(channel)) {
    ids.add(normalizeAccountId(accountId));
  }
  for (const accountId of collectWecomEnvAccountIds({
    envVars: config?.env?.vars ?? {},
    processEnv: process.env,
  })) {
    ids.add(normalizeAccountId(accountId));
  }
  return Array.from(ids).sort((left, right) => {
    if (left === "default") return -1;
    if (right === "default") return 1;
    return left.localeCompare(right);
  });
}

function resolveBotConfig(config = {}, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channel = config?.channels?.wecom ?? {};
  const accountBlock =
    normalizedAccountId === "default"
      ? channel
      : channel?.accounts && typeof channel.accounts === "object"
        ? channel.accounts[normalizedAccountId] ??
          (listLegacyInlineAccountEntries(channel).find(([id]) => normalizeAccountId(id) === normalizedAccountId)?.[1] ?? {})
        : {};
  const bot =
    normalizedAccountId === "default"
      ? channel?.bot ?? {}
      : accountBlock?.bot && typeof accountBlock.bot === "object"
        ? accountBlock.bot
        : {};
  const envVars = config?.env?.vars ?? {};
  const accountEnvPrefix = normalizedAccountId === "default" ? null : `WECOM_${normalizedAccountId.toUpperCase()}_BOT_`;
  const readBotEnv = (suffix) => {
    const scopedKey = accountEnvPrefix ? `${accountEnvPrefix}${suffix}` : "";
    return pickFirstNonEmptyString(
      scopedKey ? envVars?.[scopedKey] : "",
      scopedKey ? process.env[scopedKey] : "",
      envVars?.[`WECOM_BOT_${suffix}`],
      process.env[`WECOM_BOT_${suffix}`],
    );
  };
  const networkBlock = accountBlock?.network && typeof accountBlock.network === "object" ? accountBlock.network : {};
  const channelNetwork = channel?.network && typeof channel.network === "object" ? channel.network : {};
  const longConnection =
    bot?.longConnection && typeof bot.longConnection === "object"
      ? bot.longConnection
      : {};
  const compatBotId = pickFirstNonEmptyString(accountBlock?.botId, accountBlock?.botid, channel?.botId, channel?.botid);
  const compatSecret = pickFirstNonEmptyString(accountBlock?.secret, channel?.secret);
  const token = pickFirstNonEmptyString(bot.token, bot.callbackToken, readBotEnv("TOKEN"));
  const encodingAesKey = pickFirstNonEmptyString(bot.encodingAesKey, bot.callbackAesKey, readBotEnv("ENCODING_AES_KEY"));
  const botId = pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid, compatBotId);
  const secret = pickFirstNonEmptyString(longConnection?.secret, compatSecret);
  const longConnectionEnabled =
    longConnection?.enabled === true || (Boolean(botId) && Boolean(secret));
  const enabled = parseBooleanLike(bot.enabled, parseBooleanLike(readBotEnv("ENABLED"), longConnectionEnabled));
  const callbackEnabled = enabled && Boolean(token) && Boolean(encodingAesKey);
  const proxyUrl = String(
    resolveWecomProxyConfig({
      channelConfig: channel,
      accountConfig: {
        ...accountBlock,
        outboundProxy: pickFirstNonEmptyString(
          accountBlock?.outboundProxy,
          accountBlock?.proxyUrl,
          accountBlock?.proxy,
          networkBlock?.egressProxyUrl,
          networkBlock?.proxyUrl,
          networkBlock?.proxy,
        ),
      },
      envVars,
      processEnv: process.env,
      accountId: normalizedAccountId,
    }) ??
      pickFirstNonEmptyString(
        bot?.outboundProxy,
        bot?.proxyUrl,
        bot?.proxy,
        channel?.outboundProxy,
        channel?.proxyUrl,
        channel?.proxy,
        networkBlock?.egressProxyUrl,
        channelNetwork?.egressProxyUrl,
        process.env.WECOM_BOT_PROXY,
        process.env.WECOM_PROXY,
        process.env.HTTPS_PROXY,
        process.env.HTTP_PROXY,
      ),
  ).trim();
  const apiBaseUrl = resolveWecomApiBaseUrl({
    channelConfig: channel,
    accountConfig: accountBlock,
    envVars,
    processEnv: process.env,
    accountId: normalizedAccountId,
  });
  return {
    accountId: normalizedAccountId,
    enabled,
    callbackEnabled,
    longConnectionEnabled: enabled && Boolean(botId) && Boolean(secret) && longConnectionEnabled,
    token,
    encodingAesKey,
    proxyUrl,
    apiBaseUrl,
    longConnection: {
      ...longConnection,
      botId,
      secret,
      url: pickFirstNonEmptyString(longConnection?.url),
    },
  };
}

function getAccountReportById(report, accountId, fallbackKeys = ["accountId", "account"]) {
  const accounts = Array.isArray(report?.accounts) ? report.accounts : [];
  for (const item of accounts) {
    for (const key of fallbackKeys) {
      if (normalizeAccountId(item?.[key]) === normalizeAccountId(accountId)) return item;
    }
  }
  return null;
}

function unique(list = []) {
  return Array.from(new Set(list.map((item) => normalizeAccountId(item)).filter(Boolean)));
}

function makeSectionAction(accountId, section) {
  if (!section || section.status !== "failed" || !section.command) return null;
  return {
    id: `${accountId}-${section.id}`,
    accountId,
    kind: "run_check",
    title: `修复 ${accountId} 的 ${section.title}`,
    detail: section.detail,
    command: section.command,
  };
}

function summarizeAccountSections(sections) {
  const items = Object.values(sections);
  const passed = items.filter((item) => item.status === "ok").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  return {
    ok: failed === 0 && passed >= 1,
    total: items.length,
    passed,
    failed,
    skipped,
  };
}

function buildTopLevelSummary({ migrationSection, accounts }) {
  const accountFailures = accounts.filter((item) => item.summary.ok !== true).length;
  const accountPassed = accounts.length - accountFailures;
  const sectionItems = accounts.flatMap((item) => Object.values(item.sections));
  const sectionsPassed = sectionItems.filter((item) => item.status === "ok").length + (migrationSection.ok ? 1 : 0);
  const sectionsFailed = sectionItems.filter((item) => item.status === "failed").length + (migrationSection.ok ? 0 : 1);
  const sectionsSkipped = sectionItems.filter((item) => item.status === "skipped").length;
  const status =
    migrationSection.ok === true && accounts.length > 0 && accountFailures === 0 ? "ready" : "action_required";
  return {
    ok: status === "ready",
    status,
    accountsTotal: accounts.length,
    accountsPassed: accountPassed,
    accountsFailed: accountFailures,
    sectionsTotal: sectionItems.length + 1,
    sectionsPassed,
    sectionsFailed,
    sectionsSkipped,
  };
}

function buildMigrationSection(diagnostics) {
  const installState = String(diagnostics?.installState ?? "");
  const migrationState = String(diagnostics?.migrationState ?? "");
  const migrationSource = String(diagnostics?.migrationSource ?? "unknown");
  const ok = installState !== "stale_package" && !["legacy_config", "mixed_layout"].includes(migrationState);
  const detail = [
    String(diagnostics?.migrationSourceSummary ?? "").trim(),
    String(diagnostics?.installStateSummary ?? "").trim(),
    String(diagnostics?.migrationStateSummary ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" ");
  return buildSection(
    "migration",
    "migration",
    ok,
    `${migrationSource} ${installState}/${migrationState}`.trim(),
    detail || "migration diagnostics complete",
    WECOM_QUICKSTART_MIGRATION_COMMAND,
    {
      installState,
      migrationState,
      migrationSource,
      migrationSourceSummary: diagnostics?.migrationSourceSummary ?? "",
      migrationSourceSignals: diagnostics?.migrationSourceSignals ?? [],
      detectedLegacyFields: diagnostics?.detectedLegacyFields ?? [],
      recommendedActions: diagnostics?.recommendedActions ?? [],
    },
  );
}

function buildDoctorFixCommand(args = {}) {
  const parts = [
    "npm run wecom:doctor --",
    "--config",
    JSON.stringify(path.resolve(expandHome(args.configPath || "~/.openclaw/openclaw.json"))),
  ];
  if (args.allAccounts) {
    parts.push("--all-accounts");
  } else {
    parts.push("--account", normalizeAccountId(args.account || "default"));
  }
  if (args.skipNetwork) parts.push("--skip-network");
  if (args.skipLocalWebhook) parts.push("--skip-local-webhook");
  if (args.skipAgentE2E) parts.push("--skip-agent-e2e");
  if (args.skipBotE2E) parts.push("--skip-bot-e2e");
  if (args.skipLongconn) parts.push("--skip-longconn");
  if (args.skipCallbackMatrix) parts.push("--skip-callback-matrix");
  if (args.agentUrl) parts.push("--agent-url", JSON.stringify(String(args.agentUrl)));
  if (args.botUrl) parts.push("--bot-url", JSON.stringify(String(args.botUrl)));
  if (args.agentLegacyUrl) parts.push("--agent-legacy-url", JSON.stringify(String(args.agentLegacyUrl)));
  if (args.botLegacyUrl) parts.push("--bot-legacy-url", JSON.stringify(String(args.botLegacyUrl)));
  if (args.timeoutMs) parts.push("--timeout-ms", String(args.timeoutMs));
  parts.push("--fix", "--json");
  return parts.join(" ");
}

function buildDoctorConfirmFixCommand(args = {}) {
  return buildDoctorFixCommand(args).replace("--fix --json", "--confirm-fix --json");
}

async function maybeConfirmDoctorFix(args, fixPatch) {
  if (args?.fix !== true) {
    return {
      ...args,
      fixPrompted: false,
      fixApproved: false,
    };
  }
  if (!fixPatch) {
    return {
      ...args,
      fixPrompted: false,
      fixApproved: false,
    };
  }
  const shouldPrompt =
    args.confirmFix === true ||
    (args.json !== true && process.stdin.isTTY === true);
  if (!shouldPrompt) {
    return {
      ...args,
      fixPrompted: false,
      fixApproved: true,
    };
  }

  const previewLines = collectPatchPreviewLines(fixPatch, "", []);
  const rl = await createPrompt();
  try {
    rl.output.write("\nDoctor fix preview\n");
    for (const line of previewLines) {
      rl.output.write(`  - ${line}\n`);
    }
    const approved = await askBoolean(
      rl,
      `Apply this doctor fix patch to ${path.resolve(expandHome(args.configPath))} now`,
      false,
    );
    return {
      ...args,
      fixPrompted: true,
      fixApproved: approved,
    };
  } finally {
    rl.close();
  }
}

async function maybeApplyDoctorFix(args, fixPatch, diagnostics) {
  const configPath = path.resolve(expandHome(args?.configPath || "~/.openclaw/openclaw.json"));
  if (args?.fix !== true) {
    return {
      requested: false,
      applied: false,
      configPath,
      changedPaths: [],
    };
  }
  if (!fixPatch) {
    return {
      requested: true,
      prompted: args?.fixPrompted === true,
      confirmed: false,
      applied: false,
      configPath,
      changedPaths: [],
      reason: "no local config patch available",
    };
  }
  if (args?.fixApproved !== true) {
    return {
      requested: true,
      prompted: args?.fixPrompted === true,
      confirmed: false,
      applied: false,
      configPath,
      changedPaths: [],
      reason: args?.fixPrompted === true ? "user declined doctor fix patch" : "doctor fix patch not approved",
    };
  }
  const result = await writeDoctorFixConfig(
    args.configPath,
    fixPatch,
    diagnostics.detectedLegacyFields ?? [],
  );
  return {
    requested: true,
    prompted: args?.fixPrompted === true,
    confirmed: true,
    applied: true,
    configPath: result.configPath,
    backupPath: result.backupPath,
    existed: result.existed,
    changedPaths: result.changedPaths,
  };
}

function buildSelfcheckSection(result, accountId) {
  const accountReport = getAccountReportById(result?.parsed, accountId, ["accountId"]);
  if (!accountReport) {
    return makeSkippedSection(
      "selfcheck",
      "selfcheck",
      "account not present in selfcheck report",
      result?.command,
    );
  }
  return buildSection(
    "selfcheck",
    "selfcheck",
    accountReport?.summary?.ok === true,
    summarizeChecks(accountReport?.summary),
    accountReport?.checks?.filter((item) => item?.ok !== true).map((item) => item?.detail).join(" | ") ||
      "selfcheck passed",
    result?.command,
    accountReport,
  );
}

function buildAgentSection(result, accountId) {
  if (!result?.parsed) {
    return buildSection(
      "agentE2E",
      "agent-e2e",
      false,
      "agent selfcheck failed",
      sanitizeResultOutput(result?.stdout, result?.stderr) || "agent selfcheck returned invalid JSON",
      result?.command,
      null,
    );
  }
  const accountReport = getAccountReportById(result?.parsed, accountId, ["accountId"]);
  if (!accountReport) {
    return makeSkippedSection("agentE2E", "agent-e2e", "account has no Agent callback config", result?.command);
  }
  return buildSection(
    "agentE2E",
    "agent-e2e",
    accountReport?.summary?.ok === true,
    summarizeChecks(accountReport?.summary),
    accountReport?.checks?.filter((item) => item?.ok !== true).map((item) => item?.detail).join(" | ") ||
      "agent callback e2e passed",
    result?.command,
    accountReport,
  );
}

function buildBotSection(result, accountId) {
  if (!result?.parsed) {
    return buildSection(
      "botE2E",
      "bot-e2e",
      false,
      "bot selfcheck failed",
      sanitizeResultOutput(result?.stdout, result?.stderr) || "bot selfcheck returned invalid JSON",
      result?.command,
      null,
    );
  }
  const accountReport = getAccountReportById(result?.parsed, accountId, ["account", "accountId"]);
  if (!accountReport) {
    return makeSkippedSection("botE2E", "bot-e2e", "account has no Bot callback config", result?.command);
  }
  return buildSection(
    "botE2E",
    "bot-e2e",
    accountReport?.summary?.ok === true,
    summarizeChecks(accountReport?.summary),
    accountReport?.checks?.filter((item) => item?.ok !== true).map((item) => item?.detail).join(" | ") ||
      "bot callback e2e passed",
    result?.command,
    accountReport,
  );
}

function buildLongconnSection(result, command) {
  const ok = String(result?.parsed?.diagnosis?.code ?? "") === "ok";
  return buildSection(
    "longConnection",
    "long-connection",
    ok,
    String(result?.parsed?.diagnosis?.code ?? "unknown"),
    pickFirstNonEmptyString(result?.parsed?.diagnosis?.summary, sanitizeResultOutput(result?.stdout, result?.stderr), "long connection probe finished"),
    command,
    result?.parsed ?? null,
  );
}

function buildCallbackMatrixSection(result, command) {
  const ok = result?.parsed?.summary?.ok === true;
  return buildSection(
    "callbackMatrix",
    "callback-matrix",
    ok,
    summarizeChecks(result?.parsed?.summary),
    result?.parsed?.entries?.filter((item) => item?.ok !== true).map((item) => item?.detail).join(" | ") ||
      "callback matrix passed",
    command,
    result?.parsed ?? null,
  );
}

function printTextReport(report) {
  console.log("WeCom doctor");
  console.log(`- config: ${report.configPath}`);
  console.log(`- scope: ${report.args.allAccounts ? "all-accounts" : `single-account (${report.args.account})`}`);
  console.log(`- status: ${report.summary.status}`);
  console.log(`- installState: ${report.installState}`);
  console.log(`- installSummary: ${report.installStateSummary}`);
  console.log(`- migrationState: ${report.migrationState}`);
  console.log(`- migrationSummary: ${report.migrationStateSummary}`);
  console.log(`- migrationSource: ${report.migrationSource}`);
  console.log(`- sourceSummary: ${report.migrationSourceSummary}`);
  console.log(`- doctorCommand: ${report.commands.doctor}`);
  console.log(`- migrateCommand: ${report.commands.migrate}`);
  console.log(`- fixCommand: ${report.commands.fix}`);
  console.log(`- confirmFixCommand: ${report.commands.confirmFix}`);

  if (report.fix?.requested) {
    console.log("- fix:");
    console.log(`  - applied: ${report.fix.applied ? "yes" : "no"}`);
    if (report.fix.prompted === true) console.log(`  - prompted: yes`);
    if (report.fix.requested) console.log(`  - confirmed: ${report.fix.confirmed === true ? "yes" : "no"}`);
    if (report.fix.backupPath) console.log(`  - backupPath: ${report.fix.backupPath}`);
    if (Array.isArray(report.fix.changedPaths) && report.fix.changedPaths.length > 0) {
      console.log(`  - changedPaths: ${report.fix.changedPaths.join(", ")}`);
    }
    if (report.fix.reason) console.log(`  - detail: ${report.fix.reason}`);
  }

  if (Array.isArray(report.migrationSourceSignals) && report.migrationSourceSignals.length > 0) {
    console.log("- migrationSourceSignals:");
    for (const item of report.migrationSourceSignals) {
      console.log(`  - [${item.source}] ${item.path}: ${item.detail}`);
    }
  }

  if (Array.isArray(report.detectedLegacyFields) && report.detectedLegacyFields.length > 0) {
    console.log("- detectedLegacyFields:");
    for (const item of report.detectedLegacyFields) {
      console.log(`  - ${item.path}: ${item.detail}`);
    }
  }

  for (const account of report.accounts) {
    console.log(`\nAccount: ${account.accountId}`);
    if (account.overview) {
      console.log(
        `- readiness: receive=${account.overview.canReceive ? "yes" : "no"} reply=${account.overview.canReply ? "yes" : "no"} send=${account.overview.canSend ? "yes" : "no"} doc=${account.overview.docEnabled ? "on" : "off"}`,
      );
    }
    for (const section of Object.values(account.sections)) {
      const prefix = section.status === "ok" ? "OK " : section.status === "failed" ? "FAIL" : "SKIP";
      console.log(`${prefix} ${section.title} :: ${section.detail}`);
    }
    console.log(
      `Account summary: ${account.summary.passed}/${account.summary.total} passed, ${account.summary.skipped} skipped`,
    );
  }

  if (Array.isArray(report.recommendedActions) && report.recommendedActions.length > 0) {
    console.log("\nRecommended actions:");
    for (const action of report.recommendedActions) {
      console.log(`- [${action.kind}] ${action.title}: ${action.detail}`);
      if (action.command) console.log(`  command: ${action.command}`);
    }
  }

  console.log(
    `\nSummary: ${report.summary.accountsPassed}/${report.summary.accountsTotal} accounts ready, ${report.summary.sectionsPassed}/${report.summary.sectionsTotal} sections passed, ${report.summary.sectionsSkipped} skipped`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(expandHome(args.configPath));
  let config = {};

  try {
    const loaded = await loadConfig(configPath);
    config = loaded.config;
  } catch (err) {
    const report = {
      args,
      configPath,
      commands: {
        doctor: WECOM_DOCTOR_COMMAND,
        migrate: WECOM_QUICKSTART_MIGRATION_COMMAND,
        quickstart: WECOM_QUICKSTART_SETUP_COMMAND,
        wizard: WECOM_QUICKSTART_WIZARD_COMMAND,
        fix: buildDoctorFixCommand(args),
        confirmFix: buildDoctorConfirmFixCommand(args),
      },
      installState: "config_error",
      installStateSummary: `failed to load ${configPath}: ${String(err?.message || err)}`,
      migrationState: "config_error",
      migrationStateSummary: "unable to inspect migration state because config could not be parsed",
      migrationSource: "unknown",
      migrationSourceSummary: "unable to inspect migration source because config could not be parsed",
      migrationSourceSignals: [],
      detectedLegacyFields: [],
      fix: {
        requested: args.fix === true,
        applied: false,
        configPath,
        changedPaths: [],
        reason: "unable to inspect config before applying doctor fix",
      },
      migrationSection: buildSection(
        "migration",
        "migration",
        false,
        "config_error",
        `failed to load ${configPath}: ${String(err?.message || err)}`,
        WECOM_QUICKSTART_MIGRATION_COMMAND,
        null,
      ),
      accounts: [],
      recommendedActions: [
        {
          id: "fix-config-path",
          kind: "fill_config",
          title: "修复 OpenClaw 配置文件",
          detail: `先修复 ${configPath} 的路径或 JSON 语法，再重跑 doctor。`,
          command: WECOM_DOCTOR_COMMAND,
        },
      ],
      summary: {
        ok: false,
        status: "action_required",
        accountsTotal: 0,
        accountsPassed: 0,
        accountsFailed: 0,
        sectionsTotal: 1,
        sectionsPassed: 0,
        sectionsFailed: 1,
        sectionsSkipped: 0,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printTextReport(report);
    }
    process.exit(1);
    return;
  }

  let diagnostics = collectWecomMigrationDiagnostics({
    config,
    accountId: args.account,
  });
  const fixPatch = buildDoctorFixPatch(config, diagnostics);
  const confirmedArgs = await maybeConfirmDoctorFix(args, fixPatch);
  const fixApply = await maybeApplyDoctorFix(confirmedArgs, fixPatch, diagnostics);
  if (fixApply.applied === true) {
    const reloaded = await loadConfig(configPath);
    config = reloaded.config;
    diagnostics = collectWecomMigrationDiagnostics({
      config,
      accountId: args.account,
    });
  }
  const migrationSection = buildMigrationSection(diagnostics);

  const selfcheckArgs = [
    "--config",
    configPath,
    "--timeout-ms",
    String(args.timeoutMs),
    ...(args.allAccounts ? ["--all-accounts"] : ["--account", normalizeAccountId(args.account)]),
    ...(args.skipNetwork ? ["--skip-network"] : []),
    ...(args.skipLocalWebhook ? ["--skip-local-webhook"] : []),
    "--json",
  ];
  const selfcheckCommand = buildAccountCommand(
    "npm run wecom:selfcheck --",
    selfcheckArgs,
  );
  const selfcheckResult = await runJsonScript(SCRIPT_PATHS.selfcheck, selfcheckArgs, selfcheckCommand);

  const discoveredAccountIds = unique([
    ...(args.allAccounts ? discoverConfiguredAccountIds(config) : [normalizeAccountId(args.account)]),
    ...((selfcheckResult?.parsed?.accounts ?? []).map((item) => item?.accountId)),
  ]);
  const targetAccountIds = discoveredAccountIds.length > 0 ? discoveredAccountIds : [normalizeAccountId(args.account)];

  const agentSelfcheckArgs = [
    "--config",
    configPath,
    "--timeout-ms",
    String(args.timeoutMs),
    ...(args.allAccounts ? ["--all-accounts"] : ["--account", normalizeAccountId(args.account)]),
    "--json",
  ];
  const agentSelfcheckCommand = buildAccountCommand("npm run wecom:agent:selfcheck --", agentSelfcheckArgs);
  const runAgentChecks = args.skipNetwork !== true && args.skipAgentE2E !== true;
  const agentResult = runAgentChecks
    ? await runJsonScript(SCRIPT_PATHS.agentSelfcheck, agentSelfcheckArgs, agentSelfcheckCommand)
    : null;

  const botSelfcheckArgs = [
    "--config",
    configPath,
    "--timeout-ms",
    String(args.timeoutMs),
    ...(args.allAccounts ? ["--all-accounts"] : ["--account", normalizeAccountId(args.account)]),
    "--json",
  ];
  const botSelfcheckCommand = buildAccountCommand("npm run wecom:bot:selfcheck --", botSelfcheckArgs);
  const runBotChecks = args.skipNetwork !== true && args.skipBotE2E !== true;
  const botResult = runBotChecks
    ? await runJsonScript(SCRIPT_PATHS.botSelfcheck, botSelfcheckArgs, botSelfcheckCommand)
    : null;

  const accounts = [];

  for (const accountId of targetAccountIds) {
    const normalizedId = normalizeAccountId(accountId);
    const selfSection = selfcheckResult?.parsed
      ? buildSelfcheckSection(selfcheckResult, normalizedId)
      : buildSection(
          "selfcheck",
          "selfcheck",
          false,
          "selfcheck failed",
          sanitizeResultOutput(selfcheckResult?.stdout, selfcheckResult?.stderr) || "selfcheck returned invalid JSON",
          selfcheckCommand,
          null,
        );
    const selfReport = getAccountReportById(selfcheckResult?.parsed, normalizedId, ["accountId"]);
    const overview = selfReport?.overview ?? null;
    const resolved = selfReport?.resolved ?? null;
    const botConfig = resolveBotConfig(config, normalizedId);

    let agentSection = makeSkippedSection("agentE2E", "agent-e2e", "skipped by --skip-network", agentSelfcheckCommand);
    if (args.skipNetwork !== true && args.skipAgentE2E === true) {
      agentSection = makeSkippedSection("agentE2E", "agent-e2e", "skipped by --skip-agent-e2e", agentSelfcheckCommand);
    } else if (runAgentChecks) {
      agentSection = buildAgentSection(agentResult, normalizedId);
    }

    let botSection = makeSkippedSection("botE2E", "bot-e2e", "skipped by --skip-network", botSelfcheckCommand);
    if (args.skipNetwork !== true && args.skipBotE2E === true) {
      botSection = makeSkippedSection("botE2E", "bot-e2e", "skipped by --skip-bot-e2e", botSelfcheckCommand);
    } else if (runBotChecks) {
      botSection = buildBotSection(botResult, normalizedId);
    }

    let longconnSection = makeSkippedSection(
      "longConnection",
      "long-connection",
      "skipped by --skip-network",
      "npm run wecom:bot:longconn:probe -- --json",
    );
    if (args.skipNetwork !== true && args.skipLongconn === true) {
      longconnSection = makeSkippedSection(
        "longConnection",
        "long-connection",
        "skipped by --skip-longconn",
        "npm run wecom:bot:longconn:probe -- --json",
      );
    } else if (args.skipNetwork !== true) {
      if (!botConfig.longConnectionEnabled) {
        longconnSection = makeSkippedSection(
          "longConnection",
          "long-connection",
          "account has no Bot long connection credentials",
          "npm run wecom:bot:longconn:probe -- --json",
        );
      } else {
        const longconnArgs = [
          "--config",
          configPath,
          "--bot-id",
          botConfig.longConnection.botId,
          "--secret",
          botConfig.longConnection.secret,
          "--timeout-ms",
          String(args.timeoutMs),
          ...(botConfig.longConnection.url ? ["--url", botConfig.longConnection.url] : []),
          ...(botConfig.proxyUrl ? ["--proxy-url", botConfig.proxyUrl] : []),
          "--json",
        ];
        const longconnCommand = buildAccountCommand(
          "npm run wecom:bot:longconn:probe --",
          longconnArgs,
          { redact: ["--secret"] },
        );
        // Keep each account probe explicit so multi-account output stays attributable.
        // eslint-disable-next-line no-await-in-loop
        const longconnResult = await runJsonScript(SCRIPT_PATHS.botLongconnProbe, longconnArgs, longconnCommand);
        longconnSection = buildLongconnSection(longconnResult, longconnCommand);
      }
    }

    let callbackSection = makeSkippedSection(
      "callbackMatrix",
      "callback-matrix",
      "skipped by --skip-network",
      "npm run wecom:callback:matrix -- --json",
    );
    if (args.skipNetwork !== true && args.skipCallbackMatrix === true) {
      callbackSection = makeSkippedSection(
        "callbackMatrix",
        "callback-matrix",
        "skipped by --skip-callback-matrix",
        "npm run wecom:callback:matrix -- --json",
      );
    } else if (args.skipNetwork !== true) {
      const agentReport = getAccountReportById(agentResult?.parsed, normalizedId, ["accountId"]);
      const botReport = getAccountReportById(botResult?.parsed, normalizedId, ["account", "accountId"]);
      const agentUrl = pickFirstNonEmptyString(args.agentUrl, agentReport?.endpoint);
      const botUrl = pickFirstNonEmptyString(args.botUrl, botReport?.endpoint);
      if (!agentUrl && !botUrl) {
        callbackSection = makeSkippedSection(
          "callbackMatrix",
          "callback-matrix",
          "no public callback URL available for this account",
          "npm run wecom:callback:matrix -- --json",
        );
      } else {
        const callbackArgs = [
          ...(agentUrl ? ["--agent-url", agentUrl] : []),
          ...(botUrl ? ["--bot-url", botUrl] : []),
          ...(args.agentLegacyUrl ? ["--agent-legacy-url", args.agentLegacyUrl] : []),
          ...(args.botLegacyUrl ? ["--bot-legacy-url", args.botLegacyUrl] : []),
          "--timeout-ms",
          String(args.timeoutMs),
          "--json",
        ];
        const callbackCommand = buildAccountCommand("npm run wecom:callback:matrix --", callbackArgs);
        // Callback URLs can differ per account, so run per-account.
        // eslint-disable-next-line no-await-in-loop
        const callbackResult = await runJsonScript(SCRIPT_PATHS.callbackMatrix, callbackArgs, callbackCommand);
        callbackSection = buildCallbackMatrixSection(callbackResult, callbackCommand);
      }
    }

    const sections = {
      selfcheck: selfSection,
      agentE2E: agentSection,
      botE2E: botSection,
      longConnection: longconnSection,
      callbackMatrix: callbackSection,
    };
    const summary = summarizeAccountSections(sections);
    const commands = {
      selfcheck: selfcheckCommand,
      agentE2E: agentSelfcheckCommand,
      botE2E: botSelfcheckCommand,
      longConnection: longconnSection.command,
      callbackMatrix: callbackSection.command,
    };
    const recommendedActions = unique(
      Object.values(sections)
        .map((section) => makeSectionAction(normalizedId, section))
        .filter(Boolean)
        .map((item) => `${item.id}`),
    ).map((id) =>
      Object.values(sections)
        .map((section) => makeSectionAction(normalizedId, section))
        .filter(Boolean)
        .find((item) => item.id === id),
    );

    accounts.push({
      accountId: normalizedId,
      resolved,
      overview,
      commands,
      sections,
      summary,
      recommendedActions,
    });
  }

  const recommendedActions = [];
  const seenActionIds = new Set();
  const pushAction = (action) => {
    const id = String(action?.id ?? "").trim();
    if (!id || seenActionIds.has(id)) return;
    seenActionIds.add(id);
    recommendedActions.push(action);
  };

  for (const action of diagnostics?.recommendedActions ?? []) pushAction(action);
  if (diagnostics?.configPatch && args.fix !== true) {
    pushAction({
      id: "apply-doctor-fix",
      kind: "apply_patch",
      title: "应用 doctor 本地修复 patch",
      detail: "先应用当前可落盘的 migration patch，再重跑 doctor/selfcheck。",
      command: buildDoctorFixCommand(args),
      recommended: true,
      blocking: false,
    });
  }
  if (accounts.length === 0) {
    pushAction({
      id: "run-wecom-quickstart",
      kind: "write_patch",
      title: "生成 WeCom starter config",
      detail: "当前没有可诊断的 WeCom 账号，先运行 quickstart 或 wizard 生成配置。",
      command: WECOM_QUICKSTART_WIZARD_COMMAND,
    });
  }
  for (const account of accounts) {
    for (const action of account.recommendedActions) pushAction(action);
  }

  const report = {
    args,
    configPath,
    commands: {
      doctor: WECOM_DOCTOR_COMMAND,
      migrate: WECOM_QUICKSTART_MIGRATION_COMMAND,
      quickstart: WECOM_QUICKSTART_SETUP_COMMAND,
      wizard: WECOM_QUICKSTART_WIZARD_COMMAND,
      fix: buildDoctorFixCommand(args),
      confirmFix: buildDoctorConfirmFixCommand(args),
      selfcheck: selfcheckCommand,
      agentE2E: agentSelfcheckCommand,
      botE2E: botSelfcheckCommand,
    },
    installState: diagnostics.installState,
    installStateSummary: diagnostics.installStateSummary,
    migrationState: diagnostics.migrationState,
    migrationStateSummary: diagnostics.migrationStateSummary,
    migrationSource: diagnostics.migrationSource,
    migrationSourceSummary: diagnostics.migrationSourceSummary,
    migrationSourceSignals: diagnostics.migrationSourceSignals ?? [],
    fix: fixApply,
    installedVersion: diagnostics.installedVersion,
    expectedVersion: diagnostics.expectedVersion,
    stalePackage: diagnostics.stalePackage,
    detectedLegacyFields: diagnostics.detectedLegacyFields ?? [],
    migrationSection,
    accounts,
    recommendedActions,
  };
  report.summary = buildTopLevelSummary({
    migrationSection,
    accounts,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }
  process.exit(report.summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`WeCom doctor failed: ${String(err?.message || err)}`);
  process.exit(1);
});
