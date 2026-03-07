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
    mode: "bot",
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
    content: pickFirstEnv("WECOM_E2E_CONTENT", "E2E_WECOM_TEST_COMMAND") || "/status",
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
    if (arg === "--mode" && next) {
      out.mode = String(next).trim().toLowerCase();
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
    } else if (arg === "--content" && next) {
      out.content = next;
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

  const mode = out.mode;
  if (!["bot", "agent", "all"].includes(mode)) {
    throw new Error("Invalid --mode, expected one of: bot | agent | all");
  }
  if ((mode === "bot" || mode === "all") && !String(out.botUrl ?? "").trim()) {
    throw new Error("Missing required argument: --bot-url <https://.../wecom/bot/callback>");
  }
  if ((mode === "agent" || mode === "all") && !String(out.agentUrl ?? "").trim()) {
    throw new Error("Missing required argument: --agent-url <https://.../wecom/callback>");
  }
  if (out.browserPrepareMode && !["check", "install", "off"].includes(out.browserPrepareMode)) {
    throw new Error("Invalid --browser-prepare-mode, expected one of: check | install | off");
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat remote E2E

Usage:
  npm run wecom:remote:e2e -- --mode <bot|agent|all> [options]

Options:
  --mode <m>               Required: bot | agent | all
  --bot-url <url>          Required when mode=bot/all (or set via env)
  --agent-url <url>        Required when mode=agent/all (or set via env)
  --bot-legacy-url <url>   Optional legacy Bot callback URL for matrix diagnostics
  --agent-legacy-url <url> Optional legacy Agent callback URL for matrix diagnostics
  --config <path>          Optional: OpenClaw config path (or env WECOM_E2E_CONFIG)
  --account <id>           Optional: account id for Agent e2e (default: default)
  --from-user <userid>     Optional: simulated sender
  --content <text>         Optional: simulated content (default: /status)
  --timeout-ms <ms>        Optional: HTTP timeout (default: 12000)
  --poll-count <n>         Optional: stream refresh polls (default: 15)
  --poll-interval-ms <ms>  Optional: stream refresh interval (default: 800)
  --prepare-browser        Optional: run remote browser sandbox preparation check before E2E
  --collect-pdf            Optional: collect browser-generated PDFs after E2E
  --browser-prepare-mode   Optional: check | install | off (for prepare step)
  --browser-require-ready  Optional: fail if browser sandbox not ready
  -h, --help               Show this help

Env shortcuts:
  WECOM_E2E_BOT_URL / WECOM_E2E_AGENT_URL / WECOM_E2E_BASE_URL + *_PATH
  WECOM_E2E_CONTENT / WECOM_E2E_TIMEOUT_MS / WECOM_E2E_POLL_*
  Legacy: E2E_WECOM_BASE_URL / E2E_WECOM_WEBHOOK_PATH / E2E_WECOM_*
`);
}

async function runNode(script, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
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

async function runShell(script, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
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

async function main() {
  const args = parseArgs(process.argv);

  const selfcheckArgs = ["--all-accounts", "--skip-local-webhook", "--timeout-ms", String(args.timeoutMs)];
  if (args.configPath) {
    selfcheckArgs.unshift(args.configPath);
    selfcheckArgs.unshift("--config");
  }

  const steps = [];
  if (args.prepareBrowser) {
    const prepareEnv = {
      ...(args.browserPrepareMode ? { E2E_BROWSER_PREPARE_MODE: args.browserPrepareMode } : {}),
      ...(args.browserRequireReady ? { E2E_BROWSER_REQUIRE_READY: "1" } : {}),
    };
    steps.push({
      label: "Remote browser sandbox prepare",
      runner: "shell",
      script: "./tests/e2e/prepare-browser-sandbox.sh",
      args: [],
      env: prepareEnv,
    });
  }
  const callbackMatrixArgs = ["--timeout-ms", String(args.timeoutMs)];
  if (args.agentUrl) callbackMatrixArgs.push("--agent-url", args.agentUrl);
  if (args.botUrl) callbackMatrixArgs.push("--bot-url", args.botUrl);
  if (args.agentLegacyUrl) callbackMatrixArgs.push("--agent-legacy-url", args.agentLegacyUrl);
  if (args.botLegacyUrl) callbackMatrixArgs.push("--bot-legacy-url", args.botLegacyUrl);
  steps.push({
    label: "Public callback matrix",
    runner: "node",
    script: "./scripts/wecom-callback-matrix.mjs",
    args: callbackMatrixArgs,
  });
  steps.push({
    label: "WeCom account selfcheck (network)",
    runner: "node",
    script: "./scripts/wecom-selfcheck.mjs",
    args: selfcheckArgs,
  });
  if (args.mode === "agent" || args.mode === "all") {
    const agentArgs = [
      "--url",
      args.agentUrl,
      "--account",
      args.account,
      "--content",
      args.content,
      "--timeout-ms",
      String(args.timeoutMs),
    ];
    if (args.configPath) {
      agentArgs.unshift(args.configPath);
      agentArgs.unshift("--config");
    }
    if (args.fromUser) {
      agentArgs.push("--from-user", args.fromUser);
    }
    steps.push({
      label: "WeCom Agent remote E2E",
      runner: "node",
      script: "./scripts/wecom-agent-selfcheck.mjs",
      args: agentArgs,
    });
  }
  if (args.mode === "bot" || args.mode === "all") {
    const botArgs = [
      "--url",
      args.botUrl,
      "--content",
      args.content,
      "--timeout-ms",
      String(args.timeoutMs),
      "--poll-count",
      String(args.pollCount),
      "--poll-interval-ms",
      String(args.pollIntervalMs),
    ];
    if (args.configPath) {
      botArgs.unshift(args.configPath);
      botArgs.unshift("--config");
    }
    if (args.fromUser) {
      botArgs.push("--from-user", args.fromUser);
    }
    steps.push({
      label: "WeCom Bot remote E2E",
      runner: "node",
      script: "./scripts/wecom-bot-selfcheck.mjs",
      args: botArgs,
    });
  }
  if (args.collectPdf) {
    steps.push({
      label: "Collect remote browser PDF artifacts",
      runner: "shell",
      script: "./tests/e2e/collect-browser-pdf.sh",
      args: [],
      env: {},
    });
  }

  let stepIndex = 0;
  const totalSteps = steps.length;
  for (const step of steps) {
    stepIndex += 1;
    console.log(`[${stepIndex}/${totalSteps}] ${step.label}`);
    if (step.runner === "shell") {
      // eslint-disable-next-line no-await-in-loop
      await runShell(step.script, step.args, step.env || {});
    } else {
      // eslint-disable-next-line no-await-in-loop
      await runNode(step.script, step.args, step.env || {});
    }
  }

  console.log("Remote E2E completed.");
}

main().catch((err) => {
  console.error(`Remote E2E failed: ${String(err?.message || err)}`);
  process.exit(1);
});
