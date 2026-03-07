#!/usr/bin/env node

import { spawn } from "node:child_process";

function pickFirstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function joinBaseUrl(baseUrl, path) {
  const safeBase = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const safePath = String(path ?? "").trim();
  if (!safeBase || !safePath) return "";
  return `${safeBase}${safePath.startsWith("/") ? safePath : `/${safePath}`}`;
}

function parseArgs(argv) {
  const out = {
    scenario: "full-smoke",
    botUrl:
      pickFirstEnv("WECOM_E2E_BOT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_BOT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_WEBHOOK_PATH") || "/wecom/bot/callback"),
    agentUrl:
      pickFirstEnv("WECOM_E2E_AGENT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_AGENT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_AGENT_WEBHOOK_PATH") || "/wecom/callback"),
    botLegacyUrl: pickFirstEnv("WECOM_E2E_BOT_LEGACY_URL"),
    agentLegacyUrl: pickFirstEnv("WECOM_E2E_AGENT_LEGACY_URL"),
    configPath: pickFirstEnv("WECOM_E2E_CONFIG", "OPENCLAW_CONFIG_PATH"),
    account: "default",
    fromUser: pickFirstEnv("WECOM_E2E_FROM_USER", "E2E_WECOM_TEST_USER"),
    timeoutMs: Number(pickFirstEnv("WECOM_E2E_TIMEOUT_MS", "E2E_WECOM_STREAM_TIMEOUT_MS")) || 12000,
    pollCount: Number(pickFirstEnv("WECOM_E2E_POLL_COUNT")) || 15,
    pollIntervalMs: Number(pickFirstEnv("WECOM_E2E_POLL_INTERVAL_MS", "E2E_WECOM_POLL_INTERVAL_MS")) || 800,
    prepareBrowser: false,
    collectPdf: false,
    browserPrepareMode: pickFirstEnv("E2E_BROWSER_PREPARE_MODE"),
    browserRequireReady: pickFirstEnv("E2E_BROWSER_REQUIRE_READY") === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenario" && next) {
      out.scenario = String(next).trim().toLowerCase();
      i += 1;
    } else if (arg === "--bot-url" && next) {
      out.botUrl = next;
      i += 1;
    } else if (arg === "--agent-url" && next) {
      out.agentUrl = next;
      i += 1;
    } else if (arg === "--bot-legacy-url" && next) {
      out.botLegacyUrl = next;
      i += 1;
    } else if (arg === "--agent-legacy-url" && next) {
      out.agentLegacyUrl = next;
      i += 1;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--account" && next) {
      out.account = next;
      i += 1;
    } else if (arg === "--from-user" && next) {
      out.fromUser = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-count" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollCount = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollIntervalMs = Math.floor(n);
      i += 1;
    } else if (arg === "--prepare-browser") {
      out.prepareBrowser = true;
    } else if (arg === "--collect-pdf") {
      out.collectPdf = true;
    } else if (arg === "--browser-prepare-mode" && next) {
      out.browserPrepareMode = String(next).trim().toLowerCase();
      i += 1;
    } else if (arg === "--browser-require-ready") {
      out.browserRequireReady = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const scenario = out.scenario;
  const valid = new Set(["bot-smoke", "agent-smoke", "full-smoke", "bot-queue", "compat-smoke", "matrix-smoke"]);
  valid.add("callback-matrix");
  if (!valid.has(scenario)) {
    throw new Error(`Invalid --scenario, expected one of: ${Array.from(valid).join(" | ")}`);
  }
  if (out.browserPrepareMode && !["check", "install", "off"].includes(out.browserPrepareMode)) {
    throw new Error("Invalid --browser-prepare-mode, expected one of: check | install | off");
  }
  if ((scenario === "bot-smoke" || scenario === "full-smoke" || scenario === "bot-queue") && !String(out.botUrl).trim()) {
    throw new Error("Missing required argument: --bot-url <https://.../wecom/bot/callback>");
  }
  if (scenario === "matrix-smoke" && !String(out.botUrl).trim()) {
    throw new Error("Missing required argument: --bot-url <https://.../wecom/bot/callback>");
  }
  if ((scenario === "agent-smoke" || scenario === "full-smoke") && !String(out.agentUrl).trim()) {
    throw new Error("Missing required argument: --agent-url <https://.../wecom/callback>");
  }
  if (scenario === "compat-smoke") {
    const hasBotPair = String(out.botUrl).trim() && String(out.botLegacyUrl).trim();
    const hasAgentPair = String(out.agentUrl).trim() && String(out.agentLegacyUrl).trim();
    if (!hasBotPair && !hasAgentPair) {
      throw new Error(
        "compat-smoke requires at least one pair: (--bot-url + --bot-legacy-url) or (--agent-url + --agent-legacy-url)",
      );
    }
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat scenario E2E

Usage:
  npm run wecom:e2e:scenario -- --scenario <bot-smoke|agent-smoke|full-smoke|bot-queue|compat-smoke|matrix-smoke|callback-matrix> [options]

Scenarios:
  bot-smoke    Run remote bot E2E once
  agent-smoke  Run remote agent E2E once
  full-smoke   Run remote all-in-one E2E (agent + bot + account selfcheck)
  bot-queue    Run bot E2E twice with same sender to validate queue/stream recovery
  compat-smoke Run compatibility matrix on new + legacy webhook URLs
  matrix-smoke Run remote bot protocol matrix E2E test suite
  callback-matrix Probe public callback health for Agent/Bot (+ optional legacy alias)

Options:
  --bot-url <url>          Bot callback URL (required for bot/full/bot-queue)
  --agent-url <url>        Agent callback URL (required for agent/full)
  --bot-legacy-url <url>   Legacy Bot callback URL (used by compat-smoke)
  --agent-legacy-url <url> Legacy Agent callback URL (used by compat-smoke)
  --config <path>          Optional OpenClaw config path
  --account <id>           Agent account id (default: default)
  --from-user <userid>     Fixed sender id for scenario checks
  --timeout-ms <ms>        HTTP timeout (default: 12000)
  --poll-count <n>         Bot stream-refresh polls (default: 15)
  --poll-interval-ms <ms>  Bot poll interval (default: 800)
  --prepare-browser        Run remote browser sandbox prepare before E2E
  --collect-pdf            Collect browser-generated PDFs after E2E
  --browser-prepare-mode   check | install | off
  --browser-require-ready  Fail when browser sandbox is not ready
  -h, --help               Show help

Env shortcuts:
  WECOM_E2E_BOT_URL / WECOM_E2E_AGENT_URL / WECOM_E2E_BASE_URL + *_PATH
  WECOM_E2E_TIMEOUT_MS / WECOM_E2E_POLL_* / WECOM_E2E_FROM_USER
  WECOM_E2E_BOT_LEGACY_URL / WECOM_E2E_AGENT_LEGACY_URL
  Legacy: E2E_WECOM_BASE_URL / E2E_WECOM_WEBHOOK_PATH / E2E_WECOM_*
`);
}

async function runNodeScript(script, args = [], extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

function buildRemoteE2eArgs({ mode, options, content }) {
  const args = [
    "--mode",
    mode,
    "--timeout-ms",
    String(options.timeoutMs),
    "--poll-count",
    String(options.pollCount),
    "--poll-interval-ms",
    String(options.pollIntervalMs),
    "--content",
    content,
    "--account",
    options.account,
  ];
  if (options.botUrl) args.push("--bot-url", options.botUrl);
  if (options.agentUrl) args.push("--agent-url", options.agentUrl);
  if (options.botLegacyUrl) args.push("--bot-legacy-url", options.botLegacyUrl);
  if (options.agentLegacyUrl) args.push("--agent-legacy-url", options.agentLegacyUrl);
  if (options.configPath) args.push("--config", options.configPath);
  if (options.fromUser) args.push("--from-user", options.fromUser);
  if (options.prepareBrowser) args.push("--prepare-browser");
  if (options.collectPdf) args.push("--collect-pdf");
  if (options.browserPrepareMode) args.push("--browser-prepare-mode", options.browserPrepareMode);
  if (options.browserRequireReady) args.push("--browser-require-ready");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const steps = [];

  if (args.scenario === "bot-smoke") {
    steps.push({
      label: "Bot smoke E2E",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: args, content: "/status" }),
    });
  } else if (args.scenario === "agent-smoke") {
    steps.push({
      label: "Agent smoke E2E",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "agent", options: args, content: "/status" }),
    });
  } else if (args.scenario === "full-smoke") {
    steps.push({
      label: "Full smoke E2E (agent+bot)",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "all", options: args, content: "/status" }),
    });
  } else if (args.scenario === "bot-queue") {
    const queueUser = args.fromUser || `e2e-queue-${Date.now().toString(36).slice(-6)}`;
    const queueOptions = { ...args, fromUser: queueUser };
    steps.push({
      label: "Bot queue scenario: first message",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: queueOptions, content: "第一条队列消息 /status" }),
    });
    steps.push({
      label: "Bot queue scenario: second message",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: queueOptions, content: "第二条队列消息 /status" }),
    });
  } else if (args.scenario === "compat-smoke") {
    if (args.agentUrl && args.agentLegacyUrl) {
      steps.push({
        label: "Compat smoke: Agent new URL",
        script: "./scripts/wecom-remote-e2e.mjs",
        args: buildRemoteE2eArgs({ mode: "agent", options: args, content: "/status" }),
      });
      const legacyAgentOptions = { ...args, agentUrl: args.agentLegacyUrl };
      steps.push({
        label: "Compat smoke: Agent legacy URL",
        script: "./scripts/wecom-remote-e2e.mjs",
        args: buildRemoteE2eArgs({ mode: "agent", options: legacyAgentOptions, content: "/status" }),
      });
    }
    if (args.botUrl && args.botLegacyUrl) {
      steps.push({
        label: "Compat smoke: Bot new URL",
        script: "./scripts/wecom-remote-e2e.mjs",
        args: buildRemoteE2eArgs({ mode: "bot", options: args, content: "/status" }),
      });
      const legacyBotOptions = { ...args, botUrl: args.botLegacyUrl };
      steps.push({
        label: "Compat smoke: Bot legacy URL",
        script: "./scripts/wecom-remote-e2e.mjs",
        args: buildRemoteE2eArgs({ mode: "bot", options: legacyBotOptions, content: "/status" }),
      });
    }
  } else if (args.scenario === "matrix-smoke") {
    const matrixToken = pickFirstEnv("WECOM_BOT_TOKEN", "WECOM_E2E_TOKEN", "E2E_WECOM_TOKEN");
    const matrixAesKey = pickFirstEnv(
      "WECOM_BOT_ENCODING_AES_KEY",
      "WECOM_E2E_ENCODING_AES_KEY",
      "E2E_WECOM_ENCODING_AES_KEY",
    );
    if (!matrixToken || !matrixAesKey) {
      throw new Error(
        "matrix-smoke requires bot crypto env: WECOM_BOT_TOKEN and WECOM_BOT_ENCODING_AES_KEY (or compatible E2E_WECOM_* vars)",
      );
    }
    steps.push({
      label: "Matrix smoke: Bot protocol matrix",
      script: "--test",
      args: ["tests/e2e/remote-wecom.matrix.test.mjs"],
      env: {
        WECOM_E2E_MATRIX_ENABLE: "1",
        WECOM_E2E_BOT_URL: args.botUrl,
        WECOM_BOT_TOKEN: matrixToken,
        WECOM_BOT_ENCODING_AES_KEY: matrixAesKey,
        WECOM_E2E_MATRIX_TIMEOUT_MS: String(args.timeoutMs),
        WECOM_E2E_MATRIX_POLL_COUNT: String(args.pollCount),
        WECOM_E2E_MATRIX_POLL_INTERVAL_MS: String(args.pollIntervalMs),
        ...(args.fromUser ? { WECOM_E2E_FROM_USER: args.fromUser } : {}),
      },
    });
  } else if (args.scenario === "callback-matrix") {
    const matrixArgs = ["--timeout-ms", String(args.timeoutMs)];
    if (args.agentUrl) matrixArgs.push("--agent-url", args.agentUrl);
    if (args.botUrl) matrixArgs.push("--bot-url", args.botUrl);
    if (args.agentLegacyUrl) matrixArgs.push("--agent-legacy-url", args.agentLegacyUrl);
    if (args.botLegacyUrl) matrixArgs.push("--bot-legacy-url", args.botLegacyUrl);
    steps.push({
      label: "Callback matrix",
      script: "./scripts/wecom-callback-matrix.mjs",
      args: matrixArgs,
    });
  }

  let index = 0;
  const total = steps.length;
  for (const step of steps) {
    index += 1;
    console.log(`[${index}/${total}] ${step.label}`);
    // eslint-disable-next-line no-await-in-loop
    await runNodeScript(step.script, step.args, step.env || {});
  }
  console.log(`Scenario completed: ${args.scenario}`);
}

main().catch((err) => {
  console.error(`Scenario E2E failed: ${String(err?.message || err)}`);
  process.exit(1);
});
