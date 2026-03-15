import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function validAesKey(fill = 21) {
  return Buffer.alloc(32, fill).toString("base64").replace(/=+$/g, "");
}

async function runNodeScript(scriptPath, args = [], { input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => {
      resolve({
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

async function runInstaller(args = [], options = {}) {
  const cliPath = path.resolve(process.cwd(), "packages/openclaw-wecom-cli/bin/openclaw-wecom-cli.mjs");
  return runNodeScript(cliPath, ["install", ...args], options);
}

async function runDoctor(args = [], options = {}) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-doctor.mjs");
  return runNodeScript(scriptPath, args, options);
}

test("local onboarding e2e: compat bot install migrates config and passes offline doctor", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-local-e2e-install-"));
  const configPath = path.join(tempDir, "openclaw.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        channels: {
          wecom: {
            botId: "official-bot-id",
            secret: "official-secret",
            network: {
              egressProxyUrl: "http://127.0.0.1:7890",
              apiBaseUrl: "https://wecom.example.internal",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const installResult = await runInstaller([
    "--from",
    "official-wecom",
    "--config",
    configPath,
    "--skip-plugin-install",
    "--skip-doctor",
    "--json",
  ]);
  assert.equal(installResult.code, 0, installResult.stderr || installResult.stdout);
  const installReport = JSON.parse(installResult.stdout);
  assert.equal(installReport.status, "ready");
  assert.equal(installReport.migration.detectedSource, "sunnoy-wecom");

  const doctorResult = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);
  assert.equal(doctorResult.code, 0, doctorResult.stderr || doctorResult.stdout);
  const doctorReport = JSON.parse(doctorResult.stdout);
  assert.equal(doctorReport.summary.status, "ready");
  assert.equal(doctorReport.migrationSource, "native-openclaw-wechat");

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.bot.longConnection.botId, "official-bot-id");
  assert.equal(merged.channels.wecom.bot.longConnection.secret, "official-secret");
  assert.equal(merged.channels.wecom.outboundProxy, "http://127.0.0.1:7890");
  assert.equal(merged.channels.wecom.apiBaseUrl, "https://wecom.example.internal");
  assert.equal(merged.channels.wecom.botId, undefined);
  assert.equal(merged.channels.wecom.secret, undefined);
});

test("local onboarding e2e: doctor --fix upgrades legacy agent config and reruns ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-local-e2e-fix-"));
  const configPath = path.join(tempDir, "openclaw.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        channels: {
          wecom: {
            agent: {
              corpId: "ww-legacy",
              corpSecret: "legacy-secret",
              agentId: 1000010,
              token: "legacy-token",
              encodingAesKey: validAesKey(17),
              webhookPath: "/legacy/wecom/callback",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const doctorResult = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--fix",
    "--json",
  ]);
  assert.equal(doctorResult.code, 0, doctorResult.stderr || doctorResult.stdout);
  const report = JSON.parse(doctorResult.stdout);
  assert.equal(report.fix.requested, true);
  assert.equal(report.fix.applied, true);
  assert.equal(report.summary.status, "ready");
  assert.equal(report.migrationState, "ready");

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.accounts.default.corpId, "ww-legacy");
  assert.equal(merged.channels.wecom.accounts.default.corpSecret, "legacy-secret");
  assert.equal(merged.channels.wecom.accounts.default.callbackToken, "legacy-token");
  assert.equal(merged.plugins.entries["openclaw-wechat"].enabled, true);
});
