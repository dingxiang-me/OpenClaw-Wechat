#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  WECOM_QUICKSTART_APPLY_REPAIR_COMMAND,
  WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND,
  buildWecomQuickstartSetupPlan,
  WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
  listWecomQuickstartGroupProfiles,
  WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  listWecomQuickstartModes,
  WECOM_QUICKSTART_RECOMMENDED_MODE,
  WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
  WECOM_QUICKSTART_WIZARD_COMMAND,
} from "../src/wecom/quickstart-metadata.js";

const DM_MODES = new Set(["open", "allowlist", "pairing", "deny"]);
const DM_MODE_OPTIONS = Object.freeze([
  { id: "pairing", label: "pairing", summary: "首次私聊先审批" },
  { id: "open", label: "open", summary: "私聊直接可用" },
  { id: "allowlist", label: "allowlist", summary: "仅白名单可私聊" },
  { id: "deny", label: "deny", summary: "关闭私聊入口" },
]);
let sharedNonTtyAnswersPromise = null;
let sharedNonTtyAnswerIndex = 0;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const out = {
    mode: WECOM_QUICKSTART_RECOMMENDED_MODE,
    account: "default",
    dmMode: "pairing",
    groupProfile: WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
    groupChatId: "",
    groupAllow: "",
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    write: false,
    json: false,
    wizard: false,
    runChecks: false,
    forceChecks: false,
    applyRepair: false,
    confirmRepair: false,
    repairDir: "",
    checkTimeoutMs: 120000,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--mode" && next) {
      out.mode = String(next).trim().toLowerCase();
      index += 1;
    } else if (arg === "--account" && next) {
      out.account = String(next).trim().toLowerCase() || "default";
      index += 1;
    } else if (arg === "--dm-mode" && next) {
      out.dmMode = String(next).trim().toLowerCase();
      index += 1;
    } else if (arg === "--group-profile" && next) {
      out.groupProfile = String(next).trim().toLowerCase();
      index += 1;
    } else if (arg === "--group-chat-id" && next) {
      out.groupChatId = String(next).trim();
      index += 1;
    } else if (arg === "--group-allow" && next) {
      out.groupAllow = String(next).trim();
      index += 1;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      index += 1;
    } else if (arg === "--write") {
      out.write = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--wizard") {
      out.wizard = true;
    } else if (arg === "--run-checks") {
      out.runChecks = true;
    } else if (arg === "--force-checks") {
      out.forceChecks = true;
      out.runChecks = true;
    } else if (arg === "--apply-repair") {
      out.applyRepair = true;
      out.runChecks = true;
    } else if (arg === "--confirm-repair") {
      out.confirmRepair = true;
      out.applyRepair = true;
      out.runChecks = true;
    } else if (arg === "--repair-dir" && next) {
      out.repairDir = next;
      index += 1;
    } else if (arg === "--check-timeout-ms" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.checkTimeoutMs = Math.floor(parsed);
      }
      index += 1;
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
  console.log(`OpenClaw-Wechat quickstart

Usage:
  npm run wecom:quickstart -- [options]

Options:
  --mode <id>           quickstart mode: bot_long_connection | agent_callback | hybrid
  --account <id>        account id to scaffold (default: default)
  --dm-mode <mode>      dm policy: open | allowlist | pairing | deny (default: pairing)
  --group-profile <id>  group policy template: inherit | mention_only | open_direct | allowlist_template | deny
  --group-chat-id <id>  optional chatId used by allowlist_template
  --group-allow <list>  optional comma-separated member ids for allowlist_template
  --config <path>       target OpenClaw config path when using --write (default: ~/.openclaw/openclaw.json)
  --wizard              run an interactive setup wizard before generating the report
  --run-checks          execute recommended selfcheck commands after generating config
  --force-checks        run checks even when starter config still contains placeholders
  --apply-repair        merge the generated repair configPatch into the target config file
  --confirm-repair      preview the repair patch and ask before applying it
  --repair-dir <path>   write generated repairArtifacts files into this directory
  --check-timeout-ms    timeout for each check command (default: 120000)
  --write               merge generated starter config into the target config file
  --json                print machine-readable JSON report
  -h, --help            show this help
`);
}

function normalizeYesNo(value, defaultValue = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
  return defaultValue;
}

function findOptionByAnswer(options, answer, fallbackId) {
  const normalized = String(answer ?? "").trim().toLowerCase();
  if (!normalized) return options.find((item) => item.id === fallbackId) ?? options[0];
  const byIndex = Number.parseInt(normalized, 10);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= options.length) {
    return options[byIndex - 1];
  }
  return options.find((item) => item.id === normalized) ?? options.find((item) => item.id === fallbackId) ?? options[0];
}

async function askQuestion(rl, message, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${message}${suffix}: `);
  const normalized = String(answer ?? "").trim();
  return normalized || defaultValue;
}

async function askSelect(rl, title, options, defaultId) {
  const fallback = options.find((item) => item.id === defaultId) ?? options[0];
  options.forEach((item, index) => {
    const marker = item.id === fallback?.id ? " (default)" : "";
    const summary = item.summary ? ` - ${item.summary}` : "";
    rl.output.write(`  ${index + 1}. ${item.label}${summary}${marker}\n`);
  });
  const answer = await askQuestion(rl, title, fallback?.id ?? "");
  return findOptionByAnswer(options, answer, fallback?.id);
}

async function askBoolean(rl, message, defaultValue = false) {
  const label = defaultValue ? "Y/n" : "y/N";
  const answer = await rl.question(`${message} [${label}]: `);
  return normalizeYesNo(answer, defaultValue);
}

function summarizeCheckResults(checks = []) {
  const failed = checks.filter((item) => item.ok !== true).length;
  return {
    ok: failed === 0,
    total: checks.length,
    passed: checks.length - failed,
    failed,
  };
}

function dedupeRemediation(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function buildRemediationItem(id, title, detail, command = "") {
  return {
    id,
    title,
    detail,
    command: String(command ?? "").trim() || undefined,
  };
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

async function createWizardPrompt() {
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
      if (answer) {
        this.output.write(`${answer}\n`);
      } else {
        this.output.write("\n");
      }
      return answer;
    },
    close() {},
  };
}

async function runWizard(args) {
  const availableModes = listWecomQuickstartModes().map((item) => ({
    id: item.id,
    label: `${item.label} (${item.id})`,
    summary: item.summary,
  }));
  const availableGroupProfiles = listWecomQuickstartGroupProfiles().map((item) => ({
    id: item.id,
    label: `${item.label} (${item.id})`,
    summary: item.summary,
  }));
  const rl = await createWizardPrompt();

  try {
    rl.output.write("WeCom quickstart wizard\n");
    rl.output.write(`Use Enter to keep the default shown in brackets. You can still rerun ${WECOM_QUICKSTART_WIZARD_COMMAND} later.\n\n`);

    const mode = await askSelect(rl, "Select mode", availableModes, args.mode);
    const account = (await askQuestion(rl, "Account id", args.account || "default")).toLowerCase() || "default";
    const dmMode = await askSelect(rl, "DM mode", DM_MODE_OPTIONS, args.dmMode);
    const groupProfile = await askSelect(rl, "Group profile", availableGroupProfiles, args.groupProfile);

    let groupChatId = args.groupChatId;
    let groupAllow = args.groupAllow;
    if (groupProfile.id === "allowlist_template") {
      groupChatId = await askQuestion(rl, "Group chatId", args.groupChatId || "");
      groupAllow = await askQuestion(
        rl,
        "Group allowlist (comma-separated member ids)",
        args.groupAllow || "",
      );
    }

    const write = await askBoolean(rl, "Merge generated config into openclaw.json now", args.write === true);
    let configPath = args.configPath;
    if (write) {
      configPath = await askQuestion(rl, "Target config path", args.configPath);
    }

    return {
      ...args,
      wizard: true,
      mode: mode.id,
      account,
      dmMode: dmMode.id,
      groupProfile: groupProfile.id,
      groupChatId,
      groupAllow,
      write,
      configPath,
      runChecks: args.runChecks === true,
      forceChecks: args.forceChecks === true,
    };
  } finally {
    rl.close();
  }
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

function normalizeAccountId(accountId = "default") {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function getNestedValue(value, dottedPath = "") {
  if (!dottedPath) return value;
  return dottedPath.split(".").reduce((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return current[segment];
  }, value);
}

function setNestedValue(target, dottedPath, value) {
  const parts = String(dottedPath ?? "").split(".").filter(Boolean);
  if (parts.length === 0) return target;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
  return target;
}

function pickPathsFromObject(source, dottedPaths = []) {
  const patch = {};
  for (const dottedPath of dottedPaths) {
    const value = getNestedValue(source, dottedPath);
    if (value === undefined) continue;
    setNestedValue(patch, dottedPath, value);
  }
  return patch;
}

function resolveTargetAccountConfig(starterConfig, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(starterConfig?.channels?.wecom);
  if (normalizedAccountId === "default") return channelConfig;
  return asObject(channelConfig?.accounts?.[normalizedAccountId]);
}

function buildScopedConfigPatch(accountId, patch) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (normalizedAccountId === "default") {
    return {
      path: "channels.wecom",
      configPatch: {
        channels: {
          wecom: patch,
        },
      },
    };
  }
  return {
    path: `channels.wecom.accounts.${normalizedAccountId}`,
    configPatch: {
      channels: {
        wecom: {
          accounts: {
            [normalizedAccountId]: patch,
          },
        },
      },
    },
  };
}

const REPAIR_PATH_GROUPS = Object.freeze({
  agentCore: Object.freeze([
    "enabled",
    "corpId",
    "corpSecret",
    "agentId",
    "callbackToken",
    "callbackAesKey",
    "webhookPath",
  ]),
  botWebhook: Object.freeze([
    "enabled",
    "bot.enabled",
    "bot.token",
    "bot.encodingAesKey",
    "bot.webhookPath",
  ]),
  botLongConnection: Object.freeze([
    "enabled",
    "bot.enabled",
    "bot.longConnection.enabled",
    "bot.longConnection.botId",
    "bot.longConnection.secret",
    "bot.longConnection.url",
  ]),
});

const REPAIR_VALUE_PRESERVE_PATHS = Object.freeze([
  "corpId",
  "corpSecret",
  "agentId",
  "callbackToken",
  "callbackAesKey",
  "webhookPath",
  "bot.token",
  "bot.encodingAesKey",
  "bot.webhookPath",
  "bot.longConnection.botId",
  "bot.longConnection.secret",
  "bot.longConnection.url",
]);

function buildBackupPath(configPath) {
  return `${configPath}.bak-${Date.now()}`;
}

async function loadConfig(configPath) {
  try {
    const raw = await readFile(configPath, "utf8");
    return {
      exists: true,
      config: JSON.parse(raw),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        exists: false,
        config: {},
      };
    }
    throw err;
  }
}

async function writeMergedConfig(configPath, patch) {
  const resolvedPath = path.resolve(expandHome(configPath));
  const loaded = await loadConfig(resolvedPath);
  const backupPath = loaded.exists ? buildBackupPath(resolvedPath) : null;
  const changedPaths = collectChangedPaths(loaded.config, patch);
  const merged = mergeDeep(asObject(loaded.config), patch);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  if (loaded.exists) {
    await writeFile(backupPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  }
  await writeFile(resolvedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    configPath: resolvedPath,
    backupPath,
    existed: loaded.exists,
    mergedConfig: merged,
    changedPaths,
  };
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

function resolveCheckCommands(modeChecks = [], { accountId = "default", configPath = "" } = {}) {
  const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
  const escapedConfigPath = JSON.stringify(String(configPath ?? ""));
  return modeChecks.map((rawCommand) => {
    let command = String(rawCommand ?? "").trim();
    if (!command) return command;
    if (/--account\s+\S+/.test(command)) {
      command = command.replace(/--account\s+\S+/g, `--account ${normalizedAccountId}`);
    }
    if (/--config\s+\S+/.test(command)) {
      command = command.replace(/--config\s+\S+/g, `--config ${escapedConfigPath}`);
    } else if (/--\s/.test(command)) {
      command = command.replace(/--\s/, `-- --config ${escapedConfigPath} `);
    } else {
      command = `${command} --config ${escapedConfigPath}`;
    }
    if (!/--json(?:\s|$)/.test(command)) {
      command = `${command} --json`;
    }
    return command;
  });
}

function buildReport(args, currentConfig = {}) {
  const availableModes = listWecomQuickstartModes();
  const availableGroupProfiles = listWecomQuickstartGroupProfiles();
  const selectedMode =
    availableModes.find((item) => item.id === args.mode) ??
    availableModes.find((item) => item.id === WECOM_QUICKSTART_RECOMMENDED_MODE);
  if (!selectedMode) {
    throw new Error("No quickstart modes available");
  }
  if (!DM_MODES.has(args.dmMode)) {
    throw new Error(`Unsupported dm mode: ${args.dmMode}`);
  }
  const selectedGroupProfile =
    availableGroupProfiles.find((item) => item.id === args.groupProfile) ??
    availableGroupProfiles.find((item) => item.id === WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE);
  if (!selectedGroupProfile) {
    throw new Error("No quickstart group profiles available");
  }
  const setupPlan = buildWecomQuickstartSetupPlan({
    mode: selectedMode.id,
    accountId: args.account,
    dmMode: args.dmMode,
    groupProfile: selectedGroupProfile.id,
    groupChatId: args.groupChatId,
    groupAllow: args.groupAllow,
    currentConfig,
  });
  const preferredChecks =
    Array.isArray(setupPlan.sourcePlaybook?.checkOrder) && setupPlan.sourcePlaybook.checkOrder.length > 0
      ? setupPlan.sourcePlaybook.checkOrder.map((item) => item.command).filter(Boolean)
      : selectedMode.checks;
  return {
    mode: selectedMode,
    checkCommands: resolveCheckCommands(preferredChecks, {
      accountId: args.account,
      configPath: path.resolve(expandHome(args.configPath)),
    }),
    groupProfile: selectedGroupProfile,
    accountId: args.account,
    dmMode: args.dmMode,
    groupChatId: args.groupChatId,
    groupAllow: String(args.groupAllow ?? "")
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
    configPath: path.resolve(expandHome(args.configPath)),
    wizard: {
      used: args.wizard === true,
      command: WECOM_QUICKSTART_WIZARD_COMMAND,
    },
    commands: setupPlan.commands,
    installState: setupPlan.installState,
    installStateSummary: setupPlan.installStateSummary,
    migrationState: setupPlan.migrationState,
    migrationStateSummary: setupPlan.migrationStateSummary,
    migrationSource: setupPlan.migrationSource,
    migrationSourceSummary: setupPlan.migrationSourceSummary,
    migrationSourceSignals: setupPlan.migrationSourceSignals,
    detectedLegacyFields: setupPlan.detectedLegacyFields,
    migration: setupPlan.migration,
    sourcePlaybook: setupPlan.sourcePlaybook,
    actions: setupPlan.actions,
    runChecks: {
      requested: args.runChecks === true,
      forced: args.forceChecks === true,
      applyRepair: args.applyRepair === true,
      confirmRepair: args.confirmRepair === true,
      command: WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
      forceCommand: WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
      repairDir: args.repairDir ? path.resolve(expandHome(args.repairDir)) : "",
      timeoutMs: args.checkTimeoutMs,
    },
    starterConfig: setupPlan.starterConfig,
    placeholders: setupPlan.placeholders,
    setupChecklist: setupPlan.checklist,
    warnings: setupPlan.warnings,
  };
}

function printTextReport(report, writeResult = null) {
  const runChecksLabel = report.runChecks?.requested
    ? `${report.runChecks.forced ? "forced" : "requested"}${report.runChecks.applyRepair ? report.runChecks.confirmRepair ? " + confirmRepair" : " + applyRepair" : ""}`
    : "off";
  console.log("WeCom quickstart");
  console.log(`- mode: ${report.mode.label} (${report.mode.id})${report.mode.recommended ? " [recommended]" : ""}`);
  console.log(`- account: ${report.accountId}`);
  console.log(`- dmMode: ${report.dmMode}`);
  console.log(`- groupProfile: ${report.groupProfile.label} (${report.groupProfile.id})`);
  if (report.wizard?.used) {
    console.log("- wizard: interactive");
  }
  if (report.groupChatId) {
    console.log(`- groupChatId: ${report.groupChatId}`);
  }
  if (Array.isArray(report.groupAllow) && report.groupAllow.length > 0) {
    console.log(`- groupAllow: ${report.groupAllow.join(", ")}`);
  }
  console.log(`- publicWebhook: ${report.mode.requiresPublicWebhook ? "required" : "not required"}`);
  console.log(`- docsAnchor: ${report.mode.docsAnchor}`);
  console.log(`- summary: ${report.mode.summary}`);
  console.log(`- groupSummary: ${report.groupProfile.summary}`);
  console.log(`- installState: ${report.installState}`);
  console.log(`- migrationState: ${report.migrationState}`);
  console.log(`- migrationSource: ${report.migrationSource}`);
  console.log(`- sourceSummary: ${report.migrationSourceSummary}`);
  if (report.sourcePlaybook?.repairDefaults) {
    console.log(
      `- repairDefaults: doctorFix=${report.sourcePlaybook.repairDefaults.doctorFixMode}, preserveNetworkCompatibility=${
        report.sourcePlaybook.repairDefaults.preserveNetworkCompatibility ? "yes" : "no"
      }, removeLegacyFieldAliases=${report.sourcePlaybook.repairDefaults.removeLegacyFieldAliases ? "yes" : "no"}`,
    );
  }
  console.log(`- placeholders: ${report.placeholders.length}`);
  console.log(`- runChecks: ${runChecksLabel}`);
  if (report.commands?.preview) {
    console.log(`- previewCommand: ${report.commands.preview}`);
  }
  if (report.runChecks?.command) {
    console.log(`- runChecksCommand: ${report.runChecks.command}`);
  }
  if (report.runChecks?.forceCommand) {
    console.log(`- forceChecksCommand: ${report.runChecks.forceCommand}`);
  }
  if (report.commands?.applyRepair) {
    console.log(`- applyRepairCommand: ${report.commands.applyRepair}`);
  }
  if (report.commands?.confirmRepair) {
    console.log(`- confirmRepairCommand: ${report.commands.confirmRepair}`);
  }
  if (report.commands?.migrate) {
    console.log(`- migrateCommand: ${report.commands.migrate}`);
  }
  if (report.runChecks?.repairDir) {
    console.log(`- repairDir: ${report.runChecks.repairDir}`);
  }
  if (report.wizard?.command) {
    console.log(`- wizardCommand: ${report.wizard.command}`);
  }
  if (report.commands?.write) {
    console.log(`- writeCommand: ${report.commands.write}`);
  }
  if (writeResult) {
    console.log(
      `- write: merged into ${writeResult.configPath}${writeResult.backupPath ? ` (backup: ${writeResult.backupPath})` : " (new file)"}`,
    );
  } else {
    console.log("- write: not applied (use --write to merge into openclaw.json)");
  }
  console.log("- checks:");
  for (const check of report.checkCommands) {
    console.log(`  - ${check}`);
  }
  console.log("- requiredConfigPaths:");
  for (const item of report.mode.requiredConfigPaths) {
    console.log(`  - ${item}`);
  }
  if (Array.isArray(report.mode.notes) && report.mode.notes.length > 0) {
    console.log("- notes:");
    for (const note of report.mode.notes) {
      console.log(`  - ${note}`);
    }
  }
  if (Array.isArray(report.groupProfile.notes) && report.groupProfile.notes.length > 0) {
    console.log("- groupNotes:");
    for (const note of report.groupProfile.notes) {
      console.log(`  - ${note}`);
    }
  }
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    console.log("- warnings:");
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }
  if (Array.isArray(report.sourcePlaybook?.notes) && report.sourcePlaybook.notes.length > 0) {
    console.log("- sourceNotes:");
    for (const note of report.sourcePlaybook.notes) {
      console.log(`  - ${note}`);
    }
  }
  if (Array.isArray(report.placeholders) && report.placeholders.length > 0) {
    console.log("- placeholders:");
    for (const placeholder of report.placeholders) {
      console.log(`  - ${placeholder.path}: ${placeholder.action}`);
    }
  }
  if (Array.isArray(report.sourcePlaybook?.checkOrder) && report.sourcePlaybook.checkOrder.length > 0) {
    console.log("- preferredChecks:");
    for (const item of report.sourcePlaybook.checkOrder) {
      console.log(`  - ${item.title}: ${item.detail}`);
    }
  }
  if (Array.isArray(report.setupChecklist) && report.setupChecklist.length > 0) {
    console.log("- setupChecklist:");
    for (const item of report.setupChecklist) {
      console.log(`  - [${item.kind}] ${item.title}: ${item.detail}`);
    }
  }
  if (Array.isArray(report.detectedLegacyFields) && report.detectedLegacyFields.length > 0) {
    console.log("- detectedLegacyFields:");
    for (const item of report.detectedLegacyFields) {
      console.log(`  - ${item.path}: ${item.detail}`);
    }
  }
  if (Array.isArray(report.migrationSourceSignals) && report.migrationSourceSignals.length > 0) {
    console.log("- migrationSourceSignals:");
    for (const item of report.migrationSourceSignals) {
      console.log(`  - [${item.source}] ${item.path}: ${item.detail}`);
    }
  }
  if (Array.isArray(report.actions) && report.actions.length > 0) {
    console.log("- actions:");
    for (const action of report.actions) {
      const flags = [
        action.recommended ? "recommended" : "",
        action.blocking ? "blocking" : "",
      ].filter(Boolean);
      console.log(`  - [${action.kind}] ${action.title}: ${action.detail}${flags.length ? ` (${flags.join(", ")})` : ""}`);
      if (action.command) {
        console.log(`    command: ${action.command}`);
      }
    }
  }
  console.log("\nStarter config:");
  console.log(JSON.stringify(report.starterConfig, null, 2));
}

function printPostcheckSummary(postcheck) {
  console.log("\nPostcheck:");
  if (!postcheck?.requested) {
    console.log("- status: not requested");
    return;
  }
  if (postcheck?.blockedByPlaceholders) {
    console.log("- status: blocked by placeholders");
    for (const item of postcheck.blockingPlaceholders ?? []) {
      console.log(`  - ${item}`);
    }
    if (Array.isArray(postcheck.remediation) && postcheck.remediation.length > 0) {
      console.log("- remediation:");
      for (const item of postcheck.remediation) {
        console.log(`  - ${item.title}: ${item.detail}`);
        if (item.command) {
          console.log(`    command: ${item.command}`);
        }
      }
    }
    printRepairArtifacts(postcheck.repairArtifacts);
    printRepairPlan(postcheck.repairPlan);
    return;
  }
  console.log(
    `- summary: ${postcheck.summary?.passed ?? 0}/${postcheck.summary?.total ?? 0} passed${postcheck.usedTempConfig ? " (temp config)" : ""}`,
  );
  for (const check of postcheck.checks ?? []) {
    console.log(`${check.ok ? "OK " : "FAIL"} ${check.command} :: ${check.summary}`);
  }
  if (Array.isArray(postcheck.remediation) && postcheck.remediation.length > 0) {
    console.log("- remediation:");
    for (const item of postcheck.remediation) {
      console.log(`  - ${item.title}: ${item.detail}`);
      if (item.command) {
        console.log(`    command: ${item.command}`);
      }
    }
  }
  printRepairArtifacts(postcheck.repairArtifacts);
  printRepairPlan(postcheck.repairPlan);
}

function printRepairArtifacts(repairArtifacts) {
  if (!repairArtifacts) return;
  console.log("- repairArtifacts:");
  if (Array.isArray(repairArtifacts.groups) && repairArtifacts.groups.length > 0) {
    console.log(`  - groups: ${repairArtifacts.groups.join(", ")}`);
  }
  if (repairArtifacts.configPath) {
    console.log(`  - configPath: ${repairArtifacts.configPath}`);
  }
  if (repairArtifacts.accountPatch && Object.keys(repairArtifacts.accountPatch).length > 0) {
    console.log("  - accountPatch:");
    for (const line of JSON.stringify(repairArtifacts.accountPatch, null, 2).split("\n")) {
      console.log(`      ${line}`);
    }
  }
  if (repairArtifacts.configPatch && Object.keys(repairArtifacts.configPatch).length > 0) {
    console.log("  - configPatch:");
    for (const line of JSON.stringify(repairArtifacts.configPatch, null, 2).split("\n")) {
      console.log(`      ${line}`);
    }
  }
  if (Array.isArray(repairArtifacts.envTemplate?.lines) && repairArtifacts.envTemplate.lines.length > 0) {
    console.log(`  - envTemplate (${repairArtifacts.envTemplate.format || "dotenv"}):`);
    for (const line of repairArtifacts.envTemplate.lines) {
      console.log(`      ${line}`);
    }
  }
  if (Array.isArray(repairArtifacts.notes) && repairArtifacts.notes.length > 0) {
    console.log("  - notes:");
    for (const note of repairArtifacts.notes) {
      console.log(`      ${note}`);
    }
  }
  if (repairArtifacts.files) {
    console.log("  - files:");
    if (repairArtifacts.files.directory) {
      console.log(`      directory: ${repairArtifacts.files.directory}`);
    }
    if (repairArtifacts.files.configPatchFile) {
      console.log(`      configPatchFile: ${repairArtifacts.files.configPatchFile}`);
    }
    if (repairArtifacts.files.accountPatchFile) {
      console.log(`      accountPatchFile: ${repairArtifacts.files.accountPatchFile}`);
    }
    if (repairArtifacts.files.envTemplateFile) {
      console.log(`      envTemplateFile: ${repairArtifacts.files.envTemplateFile}`);
    }
    if (repairArtifacts.files.notesFile) {
      console.log(`      notesFile: ${repairArtifacts.files.notesFile}`);
    }
  }
}

function printRepairPlan(repairPlan) {
  if (!repairPlan) return;
  console.log("- repairPlan:");
  console.log(`  - summary: ${repairPlan.summary}`);
  console.log(`  - requiresConfirmation: ${repairPlan.requiresConfirmation ? "yes" : "no"}`);
  if (Array.isArray(repairPlan.changes) && repairPlan.changes.length > 0) {
    console.log("  - changes:");
    for (const change of repairPlan.changes) {
      console.log(`      ${change.path} = ${formatRepairPreviewValue(change.value)}`);
    }
  }
  if (Array.isArray(repairPlan.envChanges) && repairPlan.envChanges.length > 0) {
    console.log("  - envChanges:");
    for (const change of repairPlan.envChanges) {
      console.log(`      ${change.line}`);
    }
  }
  if (Array.isArray(repairPlan.fileWrites) && repairPlan.fileWrites.length > 0) {
    console.log("  - fileWrites:");
    for (const fileWrite of repairPlan.fileWrites) {
      console.log(`      [${fileWrite.kind}] ${fileWrite.path}`);
    }
  }
}

function getStubbedPostcheckResult(report) {
  const raw = String(process.env.WECOM_QUICKSTART_CHECKS_STUB_JSON ?? "").trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const checks = Array.isArray(parsed?.checks) ? parsed.checks : [];
  return {
    requested: true,
    forced: report.runChecks?.forced === true,
    executed: checks.length,
    skipped: 0,
    blockedByPlaceholders: false,
    usedTempConfig: false,
    configPath: report.configPath,
    checks,
    summary: parsed?.summary ?? summarizeCheckResults(checks),
  };
}

async function buildCheckConfigPath(args, report) {
  if (args.write === true) {
    return {
      configPath: report.configPath,
      tempDir: null,
    };
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-checks-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const loaded = await loadConfig(report.configPath);
  const merged = mergeDeep(asObject(loaded.config), report.starterConfig);
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    configPath,
    tempDir,
  };
}

async function runShellCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: -1,
        timedOut: true,
        stdout,
        stderr,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: Number.isInteger(code) ? code : -1,
        timedOut: false,
        stdout,
        stderr,
      });
    });
  });
}

function parseCheckCommandJson(stdout = "") {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function extractFailedChecks(parsed = null) {
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = [];
  if (Array.isArray(parsed.checks)) {
    candidates.push(...parsed.checks);
  }
  if (Array.isArray(parsed.accounts)) {
    for (const account of parsed.accounts) {
      if (Array.isArray(account?.checks)) {
        candidates.push(...account.checks);
      }
    }
  }
  return candidates
    .filter((item) => item && typeof item === "object" && item.ok === false)
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      detail: String(item.detail ?? "").trim(),
      data: item.data ?? null,
    }));
}

function buildCheckResult(command, execution) {
  const parsed = parseCheckCommandJson(execution.stdout);
  const summaryText =
    typeof parsed?.summary === "string"
      ? parsed.summary
      : parsed?.summary && typeof parsed.summary === "object" && Number.isFinite(parsed.summary?.total)
        ? `${parsed.summary.passed}/${parsed.summary.total} passed`
        : typeof parsed?.diagnosis?.summary === "string"
          ? parsed.diagnosis.summary
          : execution.timedOut
            ? "timed out"
            : execution.ok
              ? "ok"
              : "failed";
  return {
    command,
    ok: execution.ok,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    diagnosisCode: String(parsed?.diagnosis?.code ?? "").trim() || undefined,
    summary: summaryText,
    stdoutPreview: String(execution.stdout ?? "").trim().slice(0, 400),
    stderrPreview: String(execution.stderr ?? "").trim().slice(0, 400),
    failedChecks: extractFailedChecks(parsed),
  };
}

async function runRecommendedChecks({ args, report }) {
  const stubbed = getStubbedPostcheckResult(report);
  if (stubbed) return stubbed;
  if (report.runChecks?.requested !== true) {
    return {
      requested: false,
      forced: false,
      executed: 0,
      skipped: report.checkCommands.length,
      blockedByPlaceholders: false,
      usedTempConfig: false,
      configPath: report.configPath,
      checks: [],
      summary: summarizeCheckResults([]),
    };
  }
  if (report.placeholders.length > 0 && report.runChecks?.forced !== true) {
    return {
      requested: true,
      forced: false,
      executed: 0,
      skipped: report.checkCommands.length,
      blockedByPlaceholders: true,
      blockingPlaceholders: report.placeholders.map((item) => item.path),
      usedTempConfig: false,
      configPath: report.configPath,
      checks: [],
      summary: {
        ok: false,
        total: 0,
        passed: 0,
        failed: 0,
      },
    };
  }

  const prepared = await buildCheckConfigPath(args, report);
  const checks = [];
  try {
    const commands = resolveCheckCommands(report.mode.checks, {
      accountId: report.accountId,
      configPath: prepared.configPath,
    });
    for (const command of commands) {
      // Keep execution order deterministic for easier diagnosis.
      // eslint-disable-next-line no-await-in-loop
      const execution = await runShellCommand(command, report.runChecks?.timeoutMs || 120000);
      checks.push(buildCheckResult(command, execution));
    }
  } finally {
    if (prepared.tempDir) {
      await rm(prepared.tempDir, { recursive: true, force: true });
    }
  }

  return {
    requested: true,
    forced: report.runChecks?.forced === true,
    executed: checks.length,
    skipped: 0,
    blockedByPlaceholders: false,
    usedTempConfig: Boolean(prepared.tempDir),
    configPath: prepared.configPath,
    checks,
    summary: summarizeCheckResults(checks),
  };
}

function buildPostcheckRemediation(postcheck, report) {
  const fixes = [];
  if (!postcheck?.requested) return fixes;

  if (postcheck?.blockedByPlaceholders) {
    fixes.push(
      buildRemediationItem(
        "fill-placeholders",
        "先替换模板占位项",
        "当前 starter config 里还有占位字段，先补齐 CorpId / Secret / Token / AES Key 等真实值，再重新运行推荐检查。",
        report.runChecks?.forceCommand,
      ),
    );
    return fixes;
  }

  for (const check of postcheck.checks ?? []) {
    const command = check?.command || "";
    const failedChecks = Array.isArray(check?.failedChecks) ? check.failedChecks : [];
    for (const failed of failedChecks) {
      const name = String(failed?.name ?? "").trim();
      const detail = String(failed?.detail ?? "").trim();
      if (name === "config.load") {
        fixes.push(
          buildRemediationItem(
            "config-load",
            "修正配置文件路径或 JSON 语法",
            "quickstart 在读取 openclaw.json 时失败。确认 --config 指向正确文件，且 JSON 结构可解析。",
            command,
          ),
        );
      } else if (name === "config.account") {
        fixes.push(
          buildRemediationItem(
            "config-account",
            "确认目标账号真实存在",
            "当前 accountId 没有在 channels.wecom 顶层或 accounts.<id> 下解析成功。确认账号 ID 和配置层级一致。",
            command,
          ),
        );
      } else if (
        [
          "config.callbackToken",
          "config.callbackAesKey",
          "config.callbackAesKey.length",
          "config.bot.token",
          "config.bot.encodingAesKey",
          "config.bot.encodingAesKey.length",
        ].includes(name)
      ) {
        fixes.push(
          buildRemediationItem(
            "callback-secrets",
            "补齐企业微信回调密钥",
            "企业微信 Token / EncodingAESKey 仍缺失或长度不正确。请从企业微信后台复制真实回调密钥，而不是保留模板值。",
            command,
          ),
        );
      } else if (["config.webhookPath", "config.bot.webhookPath"].includes(name)) {
        fixes.push(
          buildRemediationItem(
            "webhook-path",
            "确认 webhookPath 与企业微信后台一致",
            "当前 webhookPath 缺失或未命中。确认 openclaw.json、反向代理和企业微信后台填写的是同一路径。",
            command,
          ),
        );
      } else if (name === "network.gettoken") {
        fixes.push(
          buildRemediationItem(
            "access-token",
            "检查 CorpId / Secret、代理与可信 IP",
            "AccessToken 获取失败。优先检查 corpId/corpSecret、出网代理，以及企业微信后台是否已放行当前出口 IP。",
            command,
          ),
        );
      } else if (["local.webhook.health", "e2e.health.get", "e2e.health.get.legacyAlias"].includes(name)) {
        const reason = detail.toLowerCase();
        const title =
          reason.includes("gateway-auth") || reason.includes("redirect")
            ? "移除 webhook 路径上的鉴权或跳转"
            : "修正 webhook 反代与路由";
        fixes.push(
          buildRemediationItem(
            "webhook-health",
            title,
            "回调探测没有直达 OpenClaw webhook。请检查反向代理、Zero Trust / SSO、路径重写，以及是否误回到了 WebUI HTML。",
            command,
          ),
        );
      } else if (["e2e.url.verify", "e2e.url.verify.legacyAlias"].includes(name)) {
        fixes.push(
          buildRemediationItem(
            "url-verify",
            "修正 Token / AES Key 与回调 URL 验证",
            "企业微信 URL 验证失败。确认企业微信后台里的 Token / EncodingAESKey 与当前配置完全一致，并确保回调地址可被公网访问。",
            command,
          ),
        );
      } else if (["e2e.message.post", "e2e.message.response.stream", "e2e.stream.refresh"].includes(name)) {
        fixes.push(
          buildRemediationItem(
            "message-delivery",
            "检查消息回包链路",
            "请求已发出但消息投递链路没有闭环。检查 gateway 是否在线、插件是否加载、Bot/Agent 回调是否注册，以及长连接或 response_url 是否可用。",
            command,
          ),
        );
      } else if (name === "config.enabled" || name === "config.bot.enabled") {
        fixes.push(
          buildRemediationItem(
            "channel-disabled",
            "启用对应账号或 Bot 模式",
            "当前账号/机器人在配置里仍是 disabled。先启用它，再重新运行推荐检查。",
            command,
          ),
        );
      }
    }

    if (check?.timedOut === true) {
      fixes.push(
        buildRemediationItem(
          "check-timeout",
          "放宽检查超时或先单独跑目标自检",
          "某条推荐检查超时。先确认 gateway 在线，再根据链路情况提高 --check-timeout-ms，或单独执行对应 selfcheck 看完整日志。",
          command,
        ),
      );
    }

    if (check?.diagnosisCode === "proxy-blocked") {
      fixes.push(
        buildRemediationItem(
          "proxy-blocked",
          "更换支持 WebSocket 的代理",
          "长连接探针显示代理链路拦截了 WebSocket Upgrade。为长连接禁用该代理，或改用支持 CONNECT/WebSocket 的代理。",
          command,
        ),
      );
    } else if (check?.diagnosisCode === "direct-network-blocked") {
      fixes.push(
        buildRemediationItem(
          "direct-network",
          "保留代理并检查本机直连出网",
          "长连接探针显示直连失败但代理可用。优先保留代理，再检查本机到企业微信入口的防火墙、DNS 和直连出网策略。",
          command,
        ),
      );
    } else if (check?.diagnosisCode === "endpoint-unavailable") {
      fixes.push(
        buildRemediationItem(
          "longconn-endpoint",
          "确认 Bot 长连接入口已开通",
          "长连接探针显示官方入口在握手阶段不可用。确认机器人已切到长连接模式，并向企业微信确认当前租户是否已开通该能力。",
          command,
        ),
      );
    } else if (check?.diagnosisCode === "websocket-handshake-failed") {
      fixes.push(
        buildRemediationItem(
          "websocket-handshake",
          "检查长连接鉴权和握手参数",
          "长连接已到 WebSocket 阶段但未完成握手/鉴权。优先核对 BotID、Secret、代理和企业微信后台的长连接开通状态。",
          command,
        ),
      );
    }
  }

  if (!postcheck.summary?.ok && fixes.length === 0) {
    fixes.push(
      buildRemediationItem(
        "generic-postcheck",
        "按失败命令逐条查看 JSON 结果",
        "quickstart 已捕获失败，但还没识别到特定模式。先单独运行对应 selfcheck，看完整 JSON 中的 checks/detail。",
        report.runChecks?.command,
      ),
    );
  }

  return dedupeRemediation(fixes);
}

function buildModeRepairGroups(report) {
  if (report.mode?.id === "agent_callback") return ["agentCore"];
  if (report.mode?.id === "bot_long_connection") return ["botLongConnection"];
  if (report.mode?.id === "hybrid") return ["agentCore", "botLongConnection"];
  return [];
}

function classifyCheckCommand(command = "") {
  const normalized = String(command ?? "");
  if (normalized.includes("wecom:bot:longconn:probe")) return "bot-longconn";
  if (normalized.includes("wecom:bot:selfcheck")) return "bot-selfcheck";
  if (normalized.includes("wecom:agent:selfcheck")) return "agent-selfcheck";
  if (normalized.includes("wecom:selfcheck")) return "shared-selfcheck";
  return "unknown";
}

function buildRepairGroups(postcheck, report) {
  const groups = new Set();
  if (!postcheck?.requested) return groups;
  if (Array.isArray(report.placeholders) && report.placeholders.length > 0) {
    for (const group of buildModeRepairGroups(report)) {
      groups.add(group);
    }
  }
  if (postcheck?.blockedByPlaceholders) {
    return groups;
  }

  for (const check of postcheck.checks ?? []) {
    const command = String(check?.command ?? "");
    const commandKind = classifyCheckCommand(command);
    if (
      commandKind === "bot-longconn" &&
      (check?.ok === false || check?.timedOut === true || Boolean(check?.diagnosisCode))
    ) {
      groups.add("botLongConnection");
    }
    if (check?.diagnosisCode) {
      groups.add("botLongConnection");
    }
    if (check?.ok === false && Array.isArray(check?.failedChecks) && check.failedChecks.length === 0) {
      for (const group of buildModeRepairGroups(report)) {
        groups.add(group);
      }
    }
    for (const failed of check?.failedChecks ?? []) {
      const name = String(failed?.name ?? "").trim();
      if (name === "config.account") {
        for (const group of buildModeRepairGroups(report)) {
          groups.add(group);
        }
      } else if (
        [
          "config.callbackToken",
          "config.callbackAesKey",
          "config.callbackAesKey.length",
          "config.webhookPath",
          "network.gettoken",
          "e2e.health.get",
          "e2e.health.get.legacyAlias",
        ].includes(name)
      ) {
        groups.add("agentCore");
      } else if (["e2e.url.verify", "e2e.url.verify.legacyAlias"].includes(name)) {
        groups.add(commandKind === "bot-selfcheck" ? "botWebhook" : "agentCore");
      } else if (
        [
          "config.bot.token",
          "config.bot.encodingAesKey",
          "config.bot.encodingAesKey.length",
          "config.bot.webhookPath",
          "local.webhook.health",
          "e2e.message.post",
          "e2e.message.response.stream",
          "e2e.stream.refresh",
        ].includes(name)
      ) {
        groups.add(commandKind === "bot-selfcheck" ? "botWebhook" : "agentCore");
      } else if (name === "config.enabled") {
        if (commandKind === "bot-selfcheck" || commandKind === "bot-longconn") {
          groups.add("botWebhook");
        } else {
          groups.add("agentCore");
        }
      } else if (name === "config.bot.enabled") {
        groups.add("botWebhook");
      }
    }
  }
  return groups;
}

function buildAgentEnvTemplate(accountId, accountConfig) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const prefix = normalizedAccountId === "default" ? "WECOM" : `WECOM_${normalizedAccountId.toUpperCase()}`;
  return [
    `${prefix}_ENABLED=${accountConfig?.enabled === false ? "false" : "true"}`,
    `${prefix}_CORP_ID=${String(accountConfig?.corpId ?? "ww-your-corp-id")}`,
    `${prefix}_CORP_SECRET=${String(accountConfig?.corpSecret ?? "your-app-secret")}`,
    `${prefix}_AGENT_ID=${String(accountConfig?.agentId ?? 1000002)}`,
    `${prefix}_CALLBACK_TOKEN=${String(accountConfig?.callbackToken ?? "your-callback-token")}`,
    `${prefix}_CALLBACK_AES_KEY=${String(accountConfig?.callbackAesKey ?? "your-callback-aes-key")}`,
    `${prefix}_WEBHOOK_PATH=${String(accountConfig?.webhookPath ?? "/wecom/callback")}`,
  ];
}

function buildBotWebhookEnvTemplate(accountId, accountConfig) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const prefix = normalizedAccountId === "default" ? "WECOM_BOT" : `WECOM_${normalizedAccountId.toUpperCase()}_BOT`;
  const botConfig = asObject(accountConfig?.bot);
  return [
    `${prefix}_ENABLED=${botConfig?.enabled === false ? "false" : "true"}`,
    `${prefix}_TOKEN=${String(botConfig?.token ?? "your-bot-token")}`,
    `${prefix}_ENCODING_AES_KEY=${String(botConfig?.encodingAesKey ?? "your-bot-encoding-aes-key")}`,
    `${prefix}_WEBHOOK_PATH=${String(botConfig?.webhookPath ?? "/wecom/bot/callback")}`,
  ];
}

function buildBotLongConnectionEnvTemplate(accountId, accountConfig) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const prefix = normalizedAccountId === "default" ? "WECOM_BOT" : `WECOM_${normalizedAccountId.toUpperCase()}_BOT`;
  const longConnection = asObject(accountConfig?.bot?.longConnection);
  return [
    `${prefix}_ENABLED=${accountConfig?.bot?.enabled === false ? "false" : "true"}`,
    `${prefix}_LONG_CONNECTION_ENABLED=${longConnection?.enabled === false ? "false" : "true"}`,
    `${prefix}_LONG_CONNECTION_BOT_ID=${String(longConnection?.botId ?? "your-bot-id")}`,
    `${prefix}_LONG_CONNECTION_SECRET=${String(longConnection?.secret ?? "your-bot-secret")}`,
    `${prefix}_LONG_CONNECTION_URL=${String(longConnection?.url ?? "wss://openws.work.weixin.qq.com")}`,
  ];
}

function buildRepairArtifacts(postcheck, report, baseConfig = {}) {
  const existingAccountConfig = resolveTargetAccountConfig(baseConfig, report.accountId);
  const targetAccountConfig = mergeDeep(
    resolveTargetAccountConfig(report.starterConfig, report.accountId),
    pickPathsFromObject(existingAccountConfig, REPAIR_VALUE_PRESERVE_PATHS),
  );
  if (!targetAccountConfig || Object.keys(targetAccountConfig).length === 0) return null;

  const groups = Array.from(buildRepairGroups(postcheck, report));
  if (groups.length === 0) return null;

  const dottedPaths = Array.from(
    new Set(groups.flatMap((group) => REPAIR_PATH_GROUPS[group] ?? [])),
  );
  const accountPatch = pickPathsFromObject(targetAccountConfig, dottedPaths);
  const scopedPatch = buildScopedConfigPatch(report.accountId, accountPatch);
  const envLines = [];
  if (groups.includes("agentCore")) {
    envLines.push(...buildAgentEnvTemplate(report.accountId, targetAccountConfig));
  }
  if (groups.includes("botWebhook")) {
    envLines.push(...buildBotWebhookEnvTemplate(report.accountId, targetAccountConfig));
  }
  if (groups.includes("botLongConnection")) {
    envLines.push(...buildBotLongConnectionEnvTemplate(report.accountId, targetAccountConfig));
  }

  return {
    groups,
    configPath: scopedPatch.path,
    accountPatch,
    configPatch: scopedPatch.configPatch,
    envTemplate: {
      format: "dotenv",
      lines: Array.from(new Set(envLines)),
    },
    notes: [
      "configPatch 可直接按 JSON merge 方式合并到 openclaw.json。",
      "envTemplate 更适合放进 env.vars 或系统环境变量，用于覆盖 Secret / 回调参数。",
    ],
  };
}

function buildRepairPlan(repairArtifacts) {
  if (!repairArtifacts?.configPatch) return null;
  const changes = collectRepairPlanChanges(repairArtifacts.accountPatch, repairArtifacts.configPath);
  const envChanges = (repairArtifacts.envTemplate?.lines ?? []).map((line) => {
    const [key, ...rest] = String(line ?? "").split("=");
    return {
      key: String(key ?? "").trim(),
      value: rest.join("="),
      line,
    };
  });
  const fileWrites = repairArtifacts.files
    ? [
        repairArtifacts.files.configPatchFile
          ? { kind: "config_patch", path: repairArtifacts.files.configPatchFile }
          : null,
        repairArtifacts.files.accountPatchFile
          ? { kind: "account_patch", path: repairArtifacts.files.accountPatchFile }
          : null,
        repairArtifacts.files.envTemplateFile
          ? { kind: "env_template", path: repairArtifacts.files.envTemplateFile }
          : null,
        repairArtifacts.files.notesFile
          ? { kind: "notes", path: repairArtifacts.files.notesFile }
          : null,
      ].filter(Boolean)
    : [
        { kind: "config_patch", path: "wecom.config-patch.json" },
        { kind: "account_patch", path: "wecom.account-patch.json" },
        { kind: "env_template", path: "wecom.env.template" },
        { kind: "notes", path: "README.txt" },
      ];

  return {
    summary: `生成 ${repairArtifacts.groups.length} 组 repair patch，覆盖 ${changes.length} 个配置路径。`,
    changes,
    envChanges,
    fileWrites,
    requiresConfirmation: true,
  };
}

function collectRepairPlanChanges(value, prefix = "", out = []) {
  if (Array.isArray(value)) {
    out.push({
      path: prefix,
      value: deepClone(value),
    });
    return out;
  }
  if (!value || typeof value !== "object") {
    out.push({
      path: prefix,
      value,
    });
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    collectRepairPlanChanges(child, childPrefix, out);
  }
  return out;
}

function finalizePostcheck(postcheck, report, baseConfig = {}) {
  const repairArtifacts = buildRepairArtifacts(postcheck, report, baseConfig);
  return {
    ...postcheck,
    remediation: buildPostcheckRemediation(postcheck, report),
    repairArtifacts,
    repairPlan: buildRepairPlan(repairArtifacts),
  };
}

function buildRepairNotesText(repairArtifacts) {
  const lines = [
    "WeCom quickstart repair artifacts",
    "",
    `groups: ${(repairArtifacts?.groups ?? []).join(", ") || "none"}`,
    `configPath: ${repairArtifacts?.configPath || "channels.wecom"}`,
    "",
    "Files:",
    "- wecom.config-patch.json: JSON merge patch for openclaw.json",
    "- wecom.account-patch.json: account-scoped patch payload only",
    "- wecom.env.template: env template for secrets / callback parameters",
    "",
    "How to use:",
    "1. Merge wecom.config-patch.json into openclaw.json with your usual JSON merge workflow.",
    "2. Copy needed keys from wecom.env.template into env.vars or system env, then replace placeholder values.",
  ];
  if (Array.isArray(repairArtifacts?.notes) && repairArtifacts.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of repairArtifacts.notes) {
      lines.push(`- ${note}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatRepairPreviewValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function collectRepairPreviewLines(value, prefix = "", out = []) {
  if (Array.isArray(value)) {
    out.push(`${prefix} = ${formatRepairPreviewValue(value)}`);
    return out;
  }
  if (!value || typeof value !== "object") {
    out.push(`${prefix} = ${formatRepairPreviewValue(value)}`);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    collectRepairPreviewLines(child, childPrefix, out);
  }
  return out;
}

function buildRepairPreviewLines(repairArtifacts) {
  if (!repairArtifacts?.accountPatch || !repairArtifacts?.configPath) return [];
  return collectRepairPreviewLines(repairArtifacts.accountPatch, repairArtifacts.configPath, []);
}

function buildRepairPreviewLinesFromPlan(repairPlan) {
  return (repairPlan?.changes ?? []).map(
    (change) => `${change.path} = ${formatRepairPreviewValue(change.value)}`,
  );
}

async function maybeWriteRepairArtifacts(postcheck, args) {
  if (!args?.repairDir || !postcheck?.repairArtifacts) return postcheck;
  const outputDir = path.resolve(expandHome(args.repairDir));
  await mkdir(outputDir, { recursive: true });

  const configPatchFile = path.join(outputDir, "wecom.config-patch.json");
  const accountPatchFile = path.join(outputDir, "wecom.account-patch.json");
  const envTemplateFile = path.join(outputDir, "wecom.env.template");
  const notesFile = path.join(outputDir, "README.txt");

  await writeFile(configPatchFile, `${JSON.stringify(postcheck.repairArtifacts.configPatch, null, 2)}\n`, "utf8");
  await writeFile(accountPatchFile, `${JSON.stringify(postcheck.repairArtifacts.accountPatch, null, 2)}\n`, "utf8");
  await writeFile(
    envTemplateFile,
    `${(postcheck.repairArtifacts.envTemplate?.lines ?? []).join("\n")}\n`,
    "utf8",
  );
  await writeFile(notesFile, buildRepairNotesText(postcheck.repairArtifacts), "utf8");

  return {
    ...postcheck,
    repairArtifacts: {
      ...postcheck.repairArtifacts,
      files: {
        directory: outputDir,
        configPatchFile,
        accountPatchFile,
        envTemplateFile,
        notesFile,
      },
    },
    repairPlan: {
      ...(postcheck.repairPlan ?? {}),
      fileWrites: [
        { kind: "config_patch", path: configPatchFile },
        { kind: "account_patch", path: accountPatchFile },
        { kind: "env_template", path: envTemplateFile },
        { kind: "notes", path: notesFile },
      ],
    },
  };
}

async function maybeConfirmRepairApply(args, postcheck) {
  if (args?.applyRepair !== true) {
    return {
      ...args,
      repairPrompted: false,
      repairApproved: false,
    };
  }
  if (!postcheck?.repairArtifacts?.configPatch) {
    return {
      ...args,
      repairPrompted: false,
      repairApproved: false,
    };
  }
  const shouldPrompt =
    args.confirmRepair === true ||
    (args.json !== true && process.stdin.isTTY === true);
  if (!shouldPrompt) {
    return {
      ...args,
      repairPrompted: false,
      repairApproved: true,
    };
  }

  const previewLines = buildRepairPreviewLinesFromPlan(postcheck.repairPlan);
  const rl = await createWizardPrompt();
  try {
    rl.output.write("\nRepair preview\n");
    for (const line of previewLines) {
      rl.output.write(`  - ${line}\n`);
    }
    const approved = await askBoolean(
      rl,
      `Apply this repair patch to ${path.resolve(expandHome(args.configPath))} now`,
      false,
    );
    return {
      ...args,
      repairPrompted: true,
      repairApproved: approved,
    };
  } finally {
    rl.close();
  }
}

async function maybeApplyRepairArtifacts(postcheck, args) {
  if (args?.applyRepair !== true) {
    return {
      requested: false,
      applied: false,
      configPath: path.resolve(expandHome(args?.configPath || "~/.openclaw/openclaw.json")),
      changedPaths: [],
    };
  }
  if (!postcheck?.repairArtifacts?.configPatch) {
    return {
      requested: true,
      prompted: args?.repairPrompted === true,
      confirmed: false,
      applied: false,
      configPath: path.resolve(expandHome(args?.configPath || "~/.openclaw/openclaw.json")),
      reason: "no repair configPatch available",
      changedPaths: [],
    };
  }
  if (args?.repairApproved !== true) {
    return {
      requested: true,
      prompted: args?.repairPrompted === true,
      confirmed: false,
      applied: false,
      configPath: path.resolve(expandHome(args?.configPath || "~/.openclaw/openclaw.json")),
      reason: args?.repairPrompted === true ? "user declined repair patch" : "repair patch not approved",
      changedPaths: [],
    };
  }
  const result = await writeMergedConfig(args.configPath, postcheck.repairArtifacts.configPatch);
  return {
    requested: true,
    prompted: args?.repairPrompted === true,
    confirmed: true,
    applied: true,
    configPath: result.configPath,
    backupPath: result.backupPath,
    existed: result.existed,
    changedPaths: result.changedPaths,
  };
}

function printRepairApplySummary(repairApplyResult) {
  if (!repairApplyResult?.requested) return;
  console.log("- repairApply:");
  if (repairApplyResult.prompted === true) {
    console.log(`  - prompted: yes`);
    console.log(`  - confirmed: ${repairApplyResult.confirmed === true ? "yes" : "no"}`);
  }
  if (!repairApplyResult.applied) {
    console.log(`  - status: skipped (${repairApplyResult.reason || "no changes applied"})`);
    console.log(`  - configPath: ${repairApplyResult.configPath}`);
    return;
  }
  console.log(`  - status: applied`);
  console.log(`  - configPath: ${repairApplyResult.configPath}`);
  if (Array.isArray(repairApplyResult.changedPaths) && repairApplyResult.changedPaths.length > 0) {
    console.log(`  - changedPaths: ${repairApplyResult.changedPaths.join(", ")}`);
  }
  if (repairApplyResult.backupPath) {
    console.log(`  - backupPath: ${repairApplyResult.backupPath}`);
  }
}

async function maybePromptWizardChecks(args, report) {
  if (args.wizard !== true || args.runChecks === true) return args;
  const rl = await createWizardPrompt();
  try {
    const defaultRunChecks = args.write === true && report.placeholders.length === 0;
    const question =
      report.placeholders.length > 0
        ? "Starter config still has placeholders. Run recommended checks anyway"
        : "Run recommended checks now";
    const runChecks = await askBoolean(rl, question, defaultRunChecks);
    if (!runChecks) return args;
    let forceChecks = args.forceChecks === true;
    if (report.placeholders.length > 0) {
      forceChecks = true;
    }
    return {
      ...args,
      runChecks: true,
      forceChecks,
    };
  } finally {
    rl.close();
  }
}

async function main() {
  const parsedArgs = parseArgs(process.argv);
  const initialArgs = parsedArgs.wizard ? await runWizard(parsedArgs) : parsedArgs;
  const initialConfig = await loadConfig(initialArgs.configPath);
  const promptedArgs = await maybePromptWizardChecks(initialArgs, buildReport(initialArgs, initialConfig.config));
  const args = promptedArgs;
  const loadedConfig = await loadConfig(args.configPath);
  const report = buildReport(args, loadedConfig.config);
  const writeResult = args.write ? await writeMergedConfig(args.configPath, report.starterConfig) : null;
  const baseConfig = writeResult ? writeResult.mergedConfig : loadedConfig.config;
  const postcheck = await maybeWriteRepairArtifacts(
    finalizePostcheck(await runRecommendedChecks({ args, report }), report, baseConfig),
    args,
  );
  const confirmedArgs = await maybeConfirmRepairApply(args, postcheck);
  const repairApply = await maybeApplyRepairArtifacts(postcheck, confirmedArgs);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          postcheck,
          repairApply,
          write: writeResult
            ? {
              applied: true,
              configPath: writeResult.configPath,
              backupPath: writeResult.backupPath,
              existed: writeResult.existed,
              changedPaths: writeResult.changedPaths,
            }
            : {
                applied: false,
                configPath: report.configPath,
                changedPaths: [],
              },
        },
        null,
        2,
      ),
    );
    return;
  }

  printTextReport(report, writeResult);
  printPostcheckSummary(postcheck);
  printRepairApplySummary(repairApply);
}

main().catch((err) => {
  console.error(`WeCom quickstart failed: ${String(err?.message || err)}`);
  process.exit(1);
});
