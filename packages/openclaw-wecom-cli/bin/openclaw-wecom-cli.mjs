#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BIN_DIR, "../../..");

function printHelp() {
  console.log(`OpenClaw WeCom CLI

Usage:
  npx -y @dingxiang-me/openclaw-wecom-cli install [options]
  npx -y @dingxiang-me/openclaw-wecom-cli doctor [args...]
  npx -y @dingxiang-me/openclaw-wecom-cli quickstart [args...]
  npx -y @dingxiang-me/openclaw-wecom-cli migrate [args...]

Commands:
  install      install plugin, write starter config, optionally run doctor
  doctor       forward to the plugin doctor entry
  quickstart   forward to the plugin quickstart entry
  migrate      forward to the plugin migrate entry

Install options:
  --mode <id>               bot_long_connection | agent_callback | hybrid
  --from <source>           auto | official-wecom | sunnoy-wecom | legacy-openclaw-wechat
  --account <id>            account id (default: default)
  --dm-mode <mode>          open | allowlist | pairing | deny
  --group-profile <id>      inherit | mention_only | open_direct | allowlist_template | deny
  --group-chat-id <id>      optional group chatId for allowlist template
  --group-allow <list>      comma-separated allowlist members
  --config <path>           target openclaw.json path (default: ~/.openclaw/openclaw.json)
  --openclaw-bin <path>     openclaw binary used for plugin install (default: openclaw)
  --bot-id <id>             fill Bot long-connection BotID
  --bot-secret <secret>     fill Bot long-connection Secret
  --corp-id <id>            fill Agent corpId
  --corp-secret <secret>    fill Agent corpSecret
  --agent-id <id>           fill AgentId
  --callback-token <token>  fill Agent callback token
  --callback-aes-key <key>  fill Agent callback aes key
  --webhook-path <path>     fill Agent webhookPath
  --api-base-url <url>      fill account apiBaseUrl
  --outbound-proxy <url>    fill account outboundProxy
  --bot-webhook-token <t>   fill Bot webhook token
  --bot-encoding-aes-key <k> fill Bot webhook encodingAesKey
  --bot-webhook-path <p>    fill Bot webhookPath
  --skip-plugin-install     do not run openclaw plugins install
  --skip-doctor             do not run post-install doctor
  --doctor-network          run doctor without --skip-network/--skip-local-webhook
  --confirm-doctor-fix      preview and confirm source-aware doctor --fix before running
  --no-doctor-fix           do not append --fix even if migration patch is available
  --yes                     auto-confirm interactive install prompts
  --force-doctor            run doctor even when placeholders remain
  --dry-run                 preview install plan without writing config
  --json                    print machine-readable JSON
  -h, --help                show this help
`);
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function uniqueActions(actions = []) {
  const seen = new Set();
  const out = [];
  for (const action of actions) {
    const id = String(action?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(action);
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function quoteShellArg(value) {
  return JSON.stringify(String(value ?? ""));
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

async function promptYesNo(message, defaultValue = false) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true && process.stderr.isTTY === true,
  });
  try {
    const label = defaultValue ? "Y/n" : "y/N";
    const answer = await rl.question(`${message} [${label}]: `);
    return normalizeYesNo(answer, defaultValue);
  } finally {
    rl.close();
  }
}

async function loadInstallerApi() {
  try {
    return await import("@dingxiang-me/openclaw-wechat/installer");
  } catch {
    return import(pathToFileURL(path.join(REPO_ROOT, "src/wecom/installer-api.js")).href);
  }
}

function resolvePluginRoot() {
  try {
    const entryPath = require.resolve("@dingxiang-me/openclaw-wechat");
    return path.resolve(path.dirname(entryPath), "..");
  } catch {
    return REPO_ROOT;
  }
}

function resolvePluginScriptPath(scriptName) {
  return path.join(resolvePluginRoot(), "scripts", scriptName);
}

function parseInstallArgs(argv) {
  const out = {
    mode: "bot_long_connection",
    modeExplicit: false,
    from: "auto",
    account: "default",
    dmMode: "pairing",
    dmModeExplicit: false,
    groupProfile: "inherit",
    groupProfileExplicit: false,
    groupChatId: "",
    groupAllow: "",
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    openclawBin: "openclaw",
    dryRun: false,
    skipPluginInstall: false,
    skipDoctor: false,
    doctorNetwork: false,
    confirmDoctorFix: false,
    noDoctorFix: false,
    yes: false,
    forceDoctor: false,
    json: false,
    values: {
      botId: pickFirstNonEmptyString(process.env.WECOM_BOT_ID),
      botSecret: pickFirstNonEmptyString(process.env.WECOM_BOT_SECRET),
      corpId: pickFirstNonEmptyString(process.env.WECOM_CORP_ID),
      corpSecret: pickFirstNonEmptyString(process.env.WECOM_CORP_SECRET),
      agentId: pickFirstNonEmptyString(process.env.WECOM_AGENT_ID),
      callbackToken: pickFirstNonEmptyString(process.env.WECOM_CALLBACK_TOKEN),
      callbackAesKey: pickFirstNonEmptyString(process.env.WECOM_CALLBACK_AES_KEY, process.env.WECOM_ENCODING_AES_KEY),
      webhookPath: pickFirstNonEmptyString(process.env.WECOM_WEBHOOK_PATH),
      outboundProxy: pickFirstNonEmptyString(process.env.WECOM_PROXY, process.env.HTTPS_PROXY),
      apiBaseUrl: pickFirstNonEmptyString(process.env.WECOM_API_BASE_URL),
      botWebhookToken: pickFirstNonEmptyString(process.env.WECOM_BOT_TOKEN),
      botEncodingAesKey: pickFirstNonEmptyString(process.env.WECOM_BOT_ENCODING_AES_KEY),
      botWebhookPath: pickFirstNonEmptyString(process.env.WECOM_BOT_WEBHOOK_PATH),
    },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "-h" || arg === "--help")) {
      printHelp();
      process.exit(0);
    } else if (arg === "--mode" && next) {
      out.mode = String(next).trim().toLowerCase();
      out.modeExplicit = true;
      index += 1;
    } else if (arg === "--from" && next) {
      out.from = String(next).trim().toLowerCase() || "auto";
      index += 1;
    } else if (arg === "--account" && next) {
      out.account = String(next).trim().toLowerCase() || "default";
      index += 1;
    } else if (arg === "--dm-mode" && next) {
      out.dmMode = String(next).trim().toLowerCase();
      out.dmModeExplicit = true;
      index += 1;
    } else if (arg === "--group-profile" && next) {
      out.groupProfile = String(next).trim().toLowerCase();
      out.groupProfileExplicit = true;
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
    } else if (arg === "--openclaw-bin" && next) {
      out.openclawBin = String(next).trim() || "openclaw";
      index += 1;
    } else if (arg === "--bot-id" && next) {
      out.values.botId = String(next).trim();
      index += 1;
    } else if (arg === "--bot-secret" && next) {
      out.values.botSecret = String(next).trim();
      index += 1;
    } else if (arg === "--corp-id" && next) {
      out.values.corpId = String(next).trim();
      index += 1;
    } else if (arg === "--corp-secret" && next) {
      out.values.corpSecret = String(next).trim();
      index += 1;
    } else if (arg === "--agent-id" && next) {
      out.values.agentId = String(next).trim();
      index += 1;
    } else if (arg === "--callback-token" && next) {
      out.values.callbackToken = String(next).trim();
      index += 1;
    } else if (arg === "--callback-aes-key" && next) {
      out.values.callbackAesKey = String(next).trim();
      index += 1;
    } else if (arg === "--webhook-path" && next) {
      out.values.webhookPath = String(next).trim();
      index += 1;
    } else if (arg === "--api-base-url" && next) {
      out.values.apiBaseUrl = String(next).trim();
      index += 1;
    } else if (arg === "--outbound-proxy" && next) {
      out.values.outboundProxy = String(next).trim();
      index += 1;
    } else if (arg === "--bot-webhook-token" && next) {
      out.values.botWebhookToken = String(next).trim();
      index += 1;
    } else if (arg === "--bot-encoding-aes-key" && next) {
      out.values.botEncodingAesKey = String(next).trim();
      index += 1;
    } else if (arg === "--bot-webhook-path" && next) {
      out.values.botWebhookPath = String(next).trim();
      index += 1;
    } else if (arg === "--skip-plugin-install") {
      out.skipPluginInstall = true;
    } else if (arg === "--skip-doctor") {
      out.skipDoctor = true;
    } else if (arg === "--doctor-network") {
      out.doctorNetwork = true;
    } else if (arg === "--confirm-doctor-fix") {
      out.confirmDoctorFix = true;
    } else if (arg === "--no-doctor-fix") {
      out.noDoctorFix = true;
    } else if (arg === "--yes") {
      out.yes = true;
    } else if (arg === "--force-doctor") {
      out.forceDoctor = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--json") {
      out.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

async function runCommand(bin, args, { parseJson = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
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
      let parsed = null;
      if (parseJson) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
      }
      resolve({
        ok: Number(code ?? -1) === 0,
        exitCode: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
        parsed,
      });
    });
  });
}

async function forwardPluginScript(scriptName, args) {
  const scriptPath = resolvePluginScriptPath(scriptName);
  const result = await runCommand(process.execPath, [scriptPath, ...args], { parseJson: false });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

function buildInstallNextSteps(report) {
  const steps = [];
  if (report.migration?.guide?.notes?.length > 0) {
    steps.push(`先按迁移来源说明审阅当前布局：${report.migration.guide.title}。`);
  }
  if (report.migration?.sourceMismatch) {
    steps.push(
      `当前检测到的来源是 ${report.migration.detectedSource}，和你指定的 ${report.migration.requestedSource} 不一致；先审阅 migrate/doctor 输出再继续。`,
    );
  }
  if (report.placeholdersRemaining > 0) {
    steps.push("补齐剩余占位项后，再执行 doctor。");
  }
  if (Array.isArray(report.sourceProfile?.checkOrder) && report.sourceProfile.checkOrder.length > 0) {
    steps.push(`推荐按 ${report.sourceProfile.checkOrder.map((item) => item.title).join(" -> ")} 的顺序继续验证。`);
  }
  if (report.migration?.canAutoFix && report.doctor?.fix === true && report.doctor?.status === "ok") {
    steps.push("旧布局来源的本地迁移 patch 已经应用，后续只需要继续补公网回调或网络项。");
  }
  if (report.migration?.canAutoFix && report.doctor?.fixDecision?.available === true && report.doctor?.fix !== true) {
    steps.push("如果要自动迁移旧布局并重跑体检，重新执行 install 并允许 doctor --fix。");
  }
  if (
    report.migration?.canAutoFix &&
    report.sourceProfile?.repairDefaults?.doctorFixMode === "confirm" &&
    report.doctor?.fix !== true
  ) {
    steps.push("当前来源默认要求显式确认 doctor --fix；要自动应用本地迁移 patch，请加 --confirm-doctor-fix 或 --yes。");
  }
  if (report.pluginInstall?.ok !== true && report.pluginInstall?.skipped !== true) {
    steps.push("先修复 openclaw 插件安装，再重试 install 或单独执行 doctor。");
  }
  if (report.doctor?.status === "failed") {
    steps.push("根据 doctor 输出修复安装或网络问题。");
  }
  if (report.write?.backupPath) {
    steps.push(`如需回滚当前安装写入，可执行 ${quoteShellArg(report.write.backupPath)} 覆盖回 ${quoteShellArg(report.configPath)}。`);
  }
  if (steps.length === 0) {
    steps.push("继续在企业微信后台填入真实凭据并按 doctor/selfcheck 验证。");
  }
  return steps;
}

function buildRuntimeCommandCatalog(report = {}) {
  const configArg = quoteShellArg(report.configPath || "~/.openclaw/openclaw.json");
  const accountArg = quoteShellArg(report.accountId || "default");
  return {
    doctorOffline: `npm run wecom:doctor -- --config ${configArg} --skip-network --skip-local-webhook --json`,
    doctorOnline: `npm run wecom:doctor -- --config ${configArg} --json`,
    selfcheck: `npm run wecom:selfcheck -- --config ${configArg} --account ${accountArg}`,
    agentSelfcheck: `npm run wecom:agent:selfcheck -- --config ${configArg} --account ${accountArg}`,
    botSelfcheck: `npm run wecom:bot:selfcheck -- --config ${configArg} --account ${accountArg}`,
    botLongconnProbe: `npm run wecom:bot:longconn:probe -- --config ${configArg} --json`,
  };
}

function resolvePreferredCheckCommand(report = {}, checkId = "") {
  const commands = report.commands ?? {};
  switch (String(checkId || "").trim()) {
    case "doctor_offline":
      return commands.doctorOffline || "";
    case "doctor_online":
      return commands.doctorOnline || "";
    case "channel_selfcheck":
      return commands.selfcheck || "";
    case "agent_selfcheck":
      return commands.agentSelfcheck || "";
    case "bot_selfcheck":
      return commands.botSelfcheck || "";
    case "bot_longconn_probe":
      return commands.botLongconnProbe || "";
    default:
      return "";
  }
}

function buildRuntimeInstallActions(report = {}) {
  const actions = [];
  if (Array.isArray(report.sourceProfile?.checkOrder)) {
    for (const check of report.sourceProfile.checkOrder) {
      const command = resolvePreferredCheckCommand(report, check.id);
      if (!command) continue;
      actions.push({
        id: `runtime:preferred-check-${String(check.id).replace(/_/g, "-")}`,
        kind: "run_check",
        title: check.title || "运行推荐检查",
        detail: check.detail || "按来源推荐的顺序继续验证当前安装状态。",
        paths: report.configPath ? [report.configPath] : [],
        command,
        recommended: true,
        blocking: false,
      });
    }
  }
  if (report.write?.backupPath && report.configPath) {
    actions.push({
      id: "runtime:rollback-installer-write",
      kind: "rollback_patch",
      title: "回滚本次安装写入",
      detail: "用安装前自动生成的备份文件恢复 openclaw.json。",
      paths: [report.configPath],
      command: report.migration?.rollbackCommand || "",
      recommended: false,
      blocking: false,
    });
  }
  if (report.migration?.canAutoFix && report.doctor?.fixDecision?.available === true && report.doctor?.fix !== true) {
    actions.push({
      id: "runtime:rerun-installer-with-doctor-fix",
      kind: "apply_patch",
      title: "重新运行安装器并允许 doctor --fix",
      detail: "当前安装没有附带执行 doctor --fix；如需自动应用本地迁移 patch，可重新运行安装器并确认。",
      paths: report.migration?.guide?.legacyFieldPaths ?? [],
      command: `${report.commands?.externalInstall || "npx -y @dingxiang-me/openclaw-wecom-cli install"} --confirm-doctor-fix`,
      recommended: true,
      blocking: false,
    });
  }
  if (report.doctor?.status === "failed" && report.commands?.doctor) {
    actions.push({
      id: "runtime:rerun-doctor",
      kind: "run_check",
      title: "重新运行 doctor",
      detail: "修复当前阻塞项后，重新执行 doctor 验证安装状态。",
      paths: [],
      command: report.commands.doctor,
      recommended: true,
      blocking: false,
    });
  }
  return actions;
}

function printInstallReport(report) {
  console.log("OpenClaw WeCom install");
  console.log(`- config: ${report.configPath}`);
  console.log(`- mode: ${report.mode}`);
  if (report.sourceProfile?.modeDerived) {
    console.log(`- modeDerived: yes (${report.sourceProfile.selectedMode})`);
  }
  console.log(`- from: ${report.migration.requestedSource}`);
  console.log(`- account: ${report.accountId}`);
  console.log(`- dryRun: ${report.dryRun ? "yes" : "no"}`);
  console.log(`- placeholdersRemaining: ${report.placeholdersRemaining}`);
  console.log(`- detectedSource: ${report.migration.detectedSource}`);
  console.log(`- effectiveSource: ${report.migration.effectiveSource}`);
  if (report.migration.sourceSummary) {
    console.log(`- sourceSummary: ${report.migration.sourceSummary}`);
  }
  if (report.migration.guide?.title) {
    console.log(`- migrationGuide: ${report.migration.guide.title}`);
    for (const note of report.migration.guide.notes ?? []) {
      console.log(`  note: ${note}`);
    }
  }
  if (report.sourceProfile?.notes?.length > 0) {
    console.log(`- sourceProfile: ${report.sourceProfile.source}`);
    for (const note of report.sourceProfile.notes) {
      console.log(`  note: ${note}`);
    }
  }
  if (report.sourceProfile?.repairDefaults) {
    console.log(
      `- repairDefaults: doctorFix=${report.sourceProfile.repairDefaults.doctorFixMode}, preserveNetworkCompatibility=${
        report.sourceProfile.repairDefaults.preserveNetworkCompatibility ? "yes" : "no"
      }, removeLegacyFieldAliases=${report.sourceProfile.repairDefaults.removeLegacyFieldAliases ? "yes" : "no"}`,
    );
  }
  if (Array.isArray(report.sourceProfile?.checkOrder) && report.sourceProfile.checkOrder.length > 0) {
    console.log("- preferredChecks:");
    for (const check of report.sourceProfile.checkOrder) {
      console.log(`  - ${check.title}`);
      if (check.detail) console.log(`    detail: ${check.detail}`);
      const command = resolvePreferredCheckCommand(report, check.id);
      if (command) console.log(`    command: ${command}`);
    }
  }
  if (report.migration.sourceMismatch) {
    console.log(`- sourceMismatch: yes`);
  }
  if (report.pluginInstall) {
    const state = report.pluginInstall.skipped ? "skipped" : report.pluginInstall.ok ? "ok" : "failed";
    console.log(`- pluginInstall: ${state}`);
    console.log(`  command: ${report.pluginInstall.command}`);
    if (report.pluginInstall.detail) console.log(`  detail: ${report.pluginInstall.detail}`);
  }
  if (report.write) {
    const state = report.write.skipped ? "skipped" : report.write.applied ? "applied" : "failed";
    console.log(`- configWrite: ${state}`);
    if (report.write.backupPath) console.log(`  backup: ${report.write.backupPath}`);
    if (Array.isArray(report.write.changedPaths) && report.write.changedPaths.length > 0) {
      console.log(`  changedPaths: ${report.write.changedPaths.join(", ")}`);
    }
    if (report.write.reason) console.log(`  detail: ${report.write.reason}`);
  }
  if (report.doctor) {
    console.log(`- doctor: ${report.doctor.status}`);
    if (report.doctor.command) console.log(`  command: ${report.doctor.command}`);
    if (report.doctor.fix) console.log(`  fix: yes`);
    if (report.doctor.fixDecision?.prompted) {
      console.log(`  fixPrompted: yes`);
      console.log(`  fixConfirmed: ${report.doctor.fixDecision.confirmed ? "yes" : "no"}`);
    }
    if (report.doctor.detail) console.log(`  detail: ${report.doctor.detail}`);
  }
  if (Array.isArray(report.actions) && report.actions.length > 0) {
    console.log("- actions:");
    for (const action of report.actions) {
      const prefix = action.recommended ? "*" : "-";
      console.log(`  ${prefix} ${action.id}: ${action.title}`);
      if (action.detail) console.log(`    detail: ${action.detail}`);
      if (action.command) console.log(`    command: ${action.command}`);
    }
  }
  if (Array.isArray(report.nextSteps) && report.nextSteps.length > 0) {
    console.log("- nextSteps:");
    for (const step of report.nextSteps) {
      console.log(`  - ${step}`);
    }
  }
}

async function resolveDoctorFixDecision(args, plan) {
  const available = plan.migration?.canAutoFix === true;
  const defaultMode = String(plan.sourceProfile?.repairDefaults?.doctorFixMode ?? "auto");
  if (!available) {
    return {
      available: false,
      requested: false,
      prompted: false,
      confirmed: false,
      reason: "no source-aware migration patch available",
      useFix: false,
    };
  }
  if (args.noDoctorFix) {
    return {
      available: true,
      requested: false,
      prompted: false,
      confirmed: false,
      reason: "disabled by --no-doctor-fix",
      useFix: false,
    };
  }
  if (!args.confirmDoctorFix && defaultMode === "off") {
    return {
      available: true,
      requested: false,
      prompted: false,
      confirmed: false,
      reason: "disabled by source repair defaults",
      useFix: false,
    };
  }
  if (!args.confirmDoctorFix && defaultMode === "confirm") {
    return {
      available: true,
      requested: false,
      prompted: false,
      confirmed: false,
      reason: "source repair defaults require explicit confirmation",
      useFix: false,
    };
  }
  if (!args.confirmDoctorFix) {
    return {
      available: true,
      requested: true,
      prompted: false,
      confirmed: true,
      reason: args.yes ? "auto-confirmed by --yes" : "auto-enabled for source-aware migration",
      useFix: true,
    };
  }

  if (args.yes) {
    return {
      available: true,
      requested: true,
      prompted: true,
      confirmed: true,
      reason: "auto-confirmed by --yes",
      useFix: true,
    };
  }

  const noteSummary = (plan.migration?.guide?.notes ?? []).slice(0, 2).join(" ");
  const confirmed = await promptYesNo(
    `检测到 ${plan.migration?.guide?.title || plan.migration?.detectedSource || "legacy WeCom 配置"}。是否允许安装器附带执行 doctor --fix？${noteSummary ? ` ${noteSummary}` : ""}`,
    false,
  );
  return {
    available: true,
    requested: true,
    prompted: true,
    confirmed,
    reason: confirmed ? "confirmed interactively" : "declined interactively",
    useFix: confirmed,
  };
}

async function runInstall(argv) {
  const args = parseInstallArgs(argv);
  const installer = await loadInstallerApi();
  const loaded = await installer.loadWecomInstallerConfig(args.configPath);
  const plan = installer.buildWecomInstallerPlan({
    mode: args.mode,
    modeExplicit: args.modeExplicit,
    from: args.from,
    accountId: args.account,
    dmMode: args.dmMode,
    dmModeExplicit: args.dmModeExplicit,
    groupProfile: args.groupProfile,
    groupProfileExplicit: args.groupProfileExplicit,
    groupChatId: args.groupChatId,
    groupAllow: args.groupAllow,
    currentConfig: loaded.config,
    values: args.values,
  });

  const pluginInstallCommand = installer.buildWecomPluginInstallCommand({
    openclawBin: args.openclawBin,
  });

  let pluginInstall = {
    requested: args.skipPluginInstall !== true,
    skipped: args.skipPluginInstall === true || args.dryRun === true,
    ok: args.skipPluginInstall === true || args.dryRun === true,
    command: [pluginInstallCommand.bin, ...pluginInstallCommand.args].join(" "),
    detail: args.skipPluginInstall ? "skipped by --skip-plugin-install" : args.dryRun ? "skipped by --dry-run" : "",
  };
  if (!pluginInstall.skipped) {
    const result = await runCommand(pluginInstallCommand.bin, pluginInstallCommand.args);
    pluginInstall = {
      requested: true,
      skipped: false,
      ok: result.ok,
      exitCode: result.exitCode,
      command: [pluginInstallCommand.bin, ...pluginInstallCommand.args].join(" "),
      detail: pickFirstNonEmptyString(result.stderr.trim(), result.stdout.trim()),
    };
  }

  let write = {
    requested: args.dryRun !== true,
    skipped: args.dryRun === true,
    applied: false,
    configPath: loaded.configPath,
    backupPath: null,
    changedPaths: installer.previewWecomInstallerChangedPaths(
      loaded.config,
      plan.configPatch,
      plan.migration?.legacyFields ?? [],
    ),
    reason: args.dryRun ? "skipped by --dry-run" : "",
  };
  if (!args.dryRun) {
    const applied = await installer.applyWecomInstallerConfigPatch(
      loaded.configPath,
      plan.configPatch,
      plan.migration?.legacyFields ?? [],
    );
    write = {
      requested: true,
      skipped: false,
      ...applied,
    };
  }

  const doctorFixDecision = await resolveDoctorFixDecision(args, plan);
  const shouldUseDoctorFix = doctorFixDecision.useFix === true;
  const doctorCommand = `npm run wecom:doctor -- --config ${JSON.stringify(path.resolve(expandHome(args.configPath)))} --json${
    args.doctorNetwork ? "" : " --skip-network --skip-local-webhook"
  }${shouldUseDoctorFix ? " --fix" : ""}`;
  let doctor = {
    requested: args.skipDoctor !== true,
    status: args.skipDoctor ? "skipped" : "pending",
    command: doctorCommand,
    fix: shouldUseDoctorFix,
    fixDecision: doctorFixDecision,
    detail: "",
    report: null,
  };
  if (args.skipDoctor) {
    doctor.detail = "skipped by --skip-doctor";
  } else if (args.dryRun) {
    doctor.status = "skipped";
    doctor.detail = "skipped by --dry-run";
  } else if (plan.placeholders.length > 0 && args.forceDoctor !== true) {
    doctor.status = "skipped";
    doctor.detail = "skipped because placeholders remain; pass --force-doctor to override";
  } else {
    const doctorArgs = [
      resolvePluginScriptPath("wecom-doctor.mjs"),
      "--config",
      path.resolve(expandHome(args.configPath)),
      ...(args.doctorNetwork ? [] : ["--skip-network", "--skip-local-webhook"]),
      ...(shouldUseDoctorFix ? ["--fix"] : []),
      "--json",
    ];
    const result = await runCommand(process.execPath, doctorArgs, { parseJson: true });
    doctor = {
      requested: true,
      status: result.ok ? "ok" : "failed",
      ok: result.ok,
      exitCode: result.exitCode,
      command: doctorCommand,
      fix: shouldUseDoctorFix,
      fixDecision: doctorFixDecision,
      detail: result.parsed?.summary?.status || pickFirstNonEmptyString(result.stderr.trim(), result.stdout.trim()),
      report: result.parsed,
    };
  }

  const status =
    pluginInstall.ok === true &&
    (args.dryRun === true || write.applied === true) &&
    (doctor.status === "ok" || doctor.status === "skipped")
      ? plan.placeholders.length > 0
        ? "configured_with_placeholders"
        : "ready"
      : "action_required";
  const report = {
    command: "install",
    status,
    dryRun: args.dryRun,
    configPath: path.resolve(expandHome(args.configPath)),
    mode: plan.mode.id,
    sourceProfile: plan.sourceProfile,
    accountId: plan.accountId,
    dmMode: plan.dmMode,
    groupProfile: plan.groupProfile.id,
    migration: plan.migration,
    actions: [],
    placeholdersRemaining: plan.placeholders.length,
    placeholders: plan.placeholders,
    pluginInstall,
    write,
    doctor,
    commands: {
      externalInstall: installer.WECOM_INSTALLER_COMMAND || "npx -y @dingxiang-me/openclaw-wecom-cli install",
      quickstart: plan.installer.quickstartCommand,
      migrate: plan.installer.migrateCommand,
      doctor: plan.installer.doctorCommand,
      wizard: plan.installer.wizardCommand,
      ...buildRuntimeCommandCatalog({
        configPath: path.resolve(expandHome(args.configPath)),
        accountId: plan.accountId,
      }),
    },
    nextSteps: [],
  };
  if (write.backupPath) {
    report.migration.rollbackCommand = `cp ${quoteShellArg(write.backupPath)} ${quoteShellArg(report.configPath)}`;
  }
  report.actions = uniqueActions([...(plan.actions ?? []), ...buildRuntimeInstallActions(report)]);
  report.nextSteps = buildInstallNextSteps(report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInstallReport(report);
  }
  process.exit(status === "action_required" ? 1 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  const [maybeCommand, ...rest] = argv;
  const command = !maybeCommand || maybeCommand.startsWith("-") ? "install" : maybeCommand;

  if (command === "install") {
    const installArgs = maybeCommand === "install" ? rest : argv;
    await runInstall(installArgs);
    return;
  }
  if (command === "doctor") {
    await forwardPluginScript("wecom-doctor.mjs", rest);
    return;
  }
  if (command === "quickstart") {
    await forwardPluginScript("wecom-quickstart.mjs", rest);
    return;
  }
  if (command === "migrate") {
    await forwardPluginScript("wecom-migrate.mjs", rest);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`OpenClaw WeCom CLI failed: ${String(err?.message || err)}`);
  process.exit(1);
});
