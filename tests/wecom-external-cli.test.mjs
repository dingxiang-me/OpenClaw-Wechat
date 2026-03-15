import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runExternalCli(args = [], options = {}) {
  const cliPath = path.resolve(process.cwd(), "packages/openclaw-wecom-cli/bin/openclaw-wecom-cli.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      stdio: [options.stdinData != null ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    if (options.stdinData != null) {
      child.stdin.write(String(options.stdinData));
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

test("external installer writes plugin entry and starter config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-install-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runExternalCli([
    "install",
    "--config",
    configPath,
    "--bot-id",
    "bot-123",
    "--bot-secret",
    "secret-123",
    "--skip-plugin-install",
    "--skip-doctor",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.pluginInstall.skipped, true);
  assert.equal(report.write.applied, true);
  assert.equal(report.placeholdersRemaining, 0);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.plugins.entries["openclaw-wechat"].enabled, true);
  assert.equal(merged.channels.wecom.bot.longConnection.botId, "bot-123");
  assert.equal(merged.channels.wecom.bot.longConnection.secret, "secret-123");
});

test("external installer dry-run leaves config untouched", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-dryrun-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runExternalCli([
    "install",
    "--config",
    configPath,
    "--skip-plugin-install",
    "--skip-doctor",
    "--dry-run",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "configured_with_placeholders");
  assert.equal(report.write.skipped, true);
  assert.equal(report.placeholdersRemaining > 0, true);
});

test("external installer can migrate official-style layout with --from official-wecom", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-migrate-official-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      wecom: {
        botId: "legacy-bot-id",
        secret: "legacy-secret",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runExternalCli([
    "install",
    "--from",
    "official-wecom",
    "--config",
    configPath,
    "--skip-plugin-install",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.migration.requestedSource, "official-wecom");
  assert.equal(report.migration.detectedSource, "official-wecom");
  assert.equal(report.migration.guide.source, "official-wecom");
  assert.match(report.migration.guide.title, /官方 WeCom/);
  assert.equal(Array.isArray(report.migration.guide.notes), true);
  assert.equal(report.migration.guide.notes.length > 0, true);
  assert.equal(Array.isArray(report.actions), true);
  assert.equal(report.actions.some((item) => item.id === "review-installer-migration-source"), true);
  assert.equal(report.actions.some((item) => item.id === "migration:migrate-legacy-wecom-config"), true);
  assert.equal(report.actions.some((item) => item.id === "review-installer-check-order"), true);
  assert.equal(report.actions.some((item) => item.id === "runtime:preferred-check-doctor-offline"), true);
  assert.equal(report.actions.some((item) => item.id === "runtime:preferred-check-bot-longconn-probe"), true);
  assert.equal(report.actions.some((item) => item.id === "runtime:rollback-installer-write"), true);
  assert.equal(report.doctor.fix, true);
  assert.equal(report.doctor.status, "ok");
  assert.match(report.migration.rollbackCommand, /^cp /);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.bot.longConnection.botId, "legacy-bot-id");
  assert.equal(merged.channels.wecom.bot.longConnection.secret, "legacy-secret");
  assert.equal(merged.channels.wecom.botId, undefined);
  assert.equal(merged.channels.wecom.secret, undefined);
  assert.equal(merged.plugins.entries["openclaw-wechat"].enabled, true);
  assert.deepEqual(merged.plugins.allow, ["openclaw-wechat"]);
});

test("external installer can decline confirmed doctor fix and still run doctor without --fix", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-confirm-fix-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      wecom: {
        botId: "legacy-bot-id",
        secret: "legacy-secret",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runExternalCli(
    [
      "install",
      "--from",
      "official-wecom",
      "--config",
      configPath,
      "--skip-plugin-install",
      "--confirm-doctor-fix",
      "--json",
    ],
    { stdinData: "n\n" },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.doctor.fix, false);
  assert.equal(report.doctor.fixDecision.available, true);
  assert.equal(report.doctor.fixDecision.prompted, true);
  assert.equal(report.doctor.fixDecision.confirmed, false);
  assert.equal(report.doctor.status, "ok");
  assert.equal(report.migration.detectedSource, "official-wecom");
  assert.equal(report.migration.guide.source, "official-wecom");
  assert.equal(report.actions.some((item) => item.id === "runtime:rerun-installer-with-doctor-fix"), true);
  assert.match(result.stderr, /doctor --fix/);
});

test("external installer auto-selects agent_callback for legacy agent-only source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-legacy-agent-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000008,
          callbackToken: "legacy-token",
          callbackAesKey: "legacy-aes",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runExternalCli([
    "install",
    "--from",
    "legacy-openclaw-wechat",
    "--config",
    configPath,
    "--skip-plugin-install",
    "--skip-doctor",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "agent_callback");
  assert.equal(report.sourceProfile.source, "legacy-openclaw-wechat");
  assert.equal(report.sourceProfile.selectedMode, "agent_callback");
  assert.equal(report.sourceProfile.modeDerived, true);
  assert.equal(report.actions.some((item) => item.id === "review-installer-selected-mode"), true);
});

test("external installer keeps sunnoy migrations on confirm-first doctor fix defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-cli-sunnoy-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      wecom: {
        botId: "compat-bot-id",
        secret: "compat-secret",
        network: {
          egressProxyUrl: "http://127.0.0.1:7890",
          apiBaseUrl: "https://wecom.internal",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runExternalCli([
    "install",
    "--from",
    "sunnoy-wecom",
    "--config",
    configPath,
    "--skip-plugin-install",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.sourceProfile.source, "sunnoy-wecom");
  assert.equal(report.sourceProfile.repairDefaults.doctorFixMode, "confirm");
  assert.equal(report.doctor.fix, false);
  assert.equal(report.doctor.fixDecision.available, true);
  assert.equal(report.doctor.fixDecision.reason, "source repair defaults require explicit confirmation");
  assert.equal(report.actions.some((item) => item.id === "runtime:preferred-check-doctor-online"), true);
  assert.equal(report.actions.some((item) => item.id === "runtime:preferred-check-bot-longconn-probe"), true);
  assert.equal(report.nextSteps.some((item) => /显式确认 doctor --fix/.test(item)), true);
});

test("external CLI forwards doctor --help to plugin doctor script", async () => {
  const result = await runExternalCli(["doctor", "--help"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OpenClaw-Wechat doctor/);
});
