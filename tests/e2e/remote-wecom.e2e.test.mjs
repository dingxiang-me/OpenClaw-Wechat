import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runNodeScript(script, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

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

const legacyBaseUrl = pickFirstEnv("E2E_WECOM_BASE_URL");
const legacyBotPath = pickFirstEnv("E2E_WECOM_WEBHOOK_PATH") || "/wecom/bot/callback";
const legacyAgentPath = pickFirstEnv("E2E_WECOM_AGENT_WEBHOOK_PATH") || "/wecom/callback";
const legacyToken = pickFirstEnv("E2E_WECOM_TOKEN");
const legacyAesKey = pickFirstEnv("E2E_WECOM_ENCODING_AES_KEY");
const explicitEnable = pickFirstEnv("WECOM_E2E_ENABLE", "E2E_WECOM_ENABLE") === "1";
const impliedEnable = Boolean(legacyBaseUrl && legacyToken && legacyAesKey);
const enabled = explicitEnable || impliedEnable;

const botUrl =
  pickFirstEnv("WECOM_E2E_BOT_URL") ||
  joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_BOT_PATH")) ||
  joinBaseUrl(legacyBaseUrl, legacyBotPath);
const agentUrl =
  pickFirstEnv("WECOM_E2E_AGENT_URL") ||
  joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_AGENT_PATH")) ||
  joinBaseUrl(legacyBaseUrl, legacyAgentPath);
const timeoutMs = pickFirstEnv("WECOM_E2E_TIMEOUT_MS", "E2E_WECOM_STREAM_TIMEOUT_MS") || "15000";
const pollCount = pickFirstEnv("WECOM_E2E_POLL_COUNT") || "20";
const pollIntervalMs = pickFirstEnv("WECOM_E2E_POLL_INTERVAL_MS", "E2E_WECOM_POLL_INTERVAL_MS") || "1000";
const content = pickFirstEnv("WECOM_E2E_CONTENT", "E2E_WECOM_TEST_COMMAND") || "/status";
const fromUser = pickFirstEnv("WECOM_E2E_FROM_USER", "E2E_WECOM_TEST_USER");
const configPath = pickFirstEnv("WECOM_E2E_CONFIG", "OPENCLAW_CONFIG_PATH");
const accountId = pickFirstEnv("WECOM_E2E_ACCOUNT") || "default";
const legacyCompatibleEnv = {
  WECOM_BOT_TOKEN: process.env.WECOM_BOT_TOKEN || legacyToken,
  WECOM_BOT_ENCODING_AES_KEY: process.env.WECOM_BOT_ENCODING_AES_KEY || legacyAesKey,
};

test(
  "remote wecom bot e2e selfcheck",
  {
    skip: !enabled || !botUrl,
  },
  async () => {
    const args = ["--url", botUrl, "--content", content, "--timeout-ms", timeoutMs, "--poll-count", pollCount, "--poll-interval-ms", pollIntervalMs];
    if (fromUser) args.push("--from-user", fromUser);
    if (configPath) args.push("--config", configPath);
    await runNodeScript("./scripts/wecom-bot-selfcheck.mjs", args, legacyCompatibleEnv);
    assert.equal(true, true);
  },
);

test(
  "remote wecom agent e2e selfcheck",
  {
    skip: !enabled || !agentUrl,
  },
  async () => {
    const args = [
      "--url",
      agentUrl,
      "--account",
      accountId,
      "--content",
      content,
      "--timeout-ms",
      timeoutMs,
    ];
    if (fromUser) args.push("--from-user", fromUser);
    if (configPath) args.push("--config", configPath);
    await runNodeScript("./scripts/wecom-agent-selfcheck.mjs", args, legacyCompatibleEnv);
    assert.equal(true, true);
  },
);
