import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runMigrate(args = [], { env = {} } = {}) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-migrate.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
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
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

test("wecom-migrate reports fresh state for empty config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-fresh-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runMigrate(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.installState, "fresh");
  assert.equal(report.migrationState, "fresh");
  assert.equal(report.migrationSource, "fresh");
  assert.equal(report.configPatch, null);
  assert.deepEqual(report.detectedLegacyFields, []);
  assert.deepEqual(report.migrationSourceSignals, []);
});

test("wecom-migrate detects legacy fields and builds migration patch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-legacy-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const legacyConfig = {
    plugins: {
      installs: {
        "openclaw-wechat": {
          version: "1.7.2",
        },
      },
    },
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
          token: "legacy-callback-token",
          encodingAesKey: "legacy-callback-aes",
          webhookPath: "/legacy/callback",
        },
        token: "legacy-bot-token",
        encodingAesKey: "legacy-bot-aes",
        webhookPath: "/legacy/bot-callback",
        sales: {
          corpId: "ww-sales",
          corpSecret: "sales-secret",
          agentId: 1000003,
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

  const result = await runMigrate(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.installState, "stale_package");
  assert.equal(report.migrationState, "legacy_config");
  assert.equal(report.migrationSource, "legacy-openclaw-wechat");
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_agent_block"), true);
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_inline_account"), true);
  assert.equal(report.recommendedActions.some((item) => item.id === "upgrade-plugin-package"), true);
  assert.equal(report.recommendedActions.some((item) => item.id === "migrate-legacy-wecom-config"), true);
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "legacy-openclaw-wechat"), true);
  assert.equal(report.configPatch.channels.wecom.accounts.default.callbackToken, "legacy-callback-token");
  assert.equal(report.configPatch.channels.wecom.accounts.default.bot.token, "legacy-bot-token");
  assert.equal(report.configPatch.channels.wecom.accounts.sales.corpId, "ww-sales");
  assert.equal(report.envTemplate.lines.includes("WECOM_BOT_TOKEN=legacy-bot-token"), true);
});

test("wecom-migrate can apply migration patch into target config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-write-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const legacyConfig = {
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
          token: "legacy-token",
          encodingAesKey: "legacy-aes",
          webhookPath: "/legacy/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

  const result = await runMigrate(["--config", configPath, "--write", "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.write.requested, true);
  assert.equal(report.write.applied, true);
  assert.equal(typeof report.write.backupPath, "string");
  assert.equal(report.write.changedPaths.includes("channels.wecom.accounts.default.corpId"), true);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.accounts.default.corpId, "ww-legacy");
  assert.equal(merged.channels.wecom.accounts.default.callbackToken, "legacy-token");
});

test("wecom-migrate normalizes flat bot credentials and network compatibility fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-compat-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const legacyConfig = {
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
  await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

  const result = await runMigrate(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_flat_bot_id"), true);
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_network_api_base_url"), true);
  assert.equal(report.migrationSource, "sunnoy-wecom");
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "official-wecom"), true);
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "sunnoy-wecom"), true);
  assert.equal(report.configPatch.channels.wecom.accounts.default.bot.longConnection.botId, "compat-bot-id");
  assert.equal(report.configPatch.channels.wecom.accounts.default.bot.longConnection.secret, "compat-secret");
  assert.equal(report.configPatch.channels.wecom.accounts.default.outboundProxy, "http://127.0.0.1:7890");
  assert.equal(report.configPatch.channels.wecom.accounts.default.apiBaseUrl, "https://wecom.internal");
});

test("wecom-migrate classifies flat bot credentials without network compatibility as official source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-official-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const compatConfig = {
    channels: {
      wecom: {
        botId: "official-bot-id",
        secret: "official-secret",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(compatConfig, null, 2)}\n`, "utf8");

  const result = await runMigrate(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.migrationSource, "official-wecom");
  assert.equal(report.migrationSourceSignals.every((item) => item.source === "official-wecom"), true);
  assert.equal(report.recommendedActions.some((item) => /官方 WeCom 插件/.test(item.title)), true);
});

test("wecom-migrate flags mixed source layouts when legacy and external compat fields coexist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-migrate-mixed-source-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const mixedConfig = {
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
        },
        botId: "compat-bot-id",
        secret: "compat-secret",
        network: {
          egressProxyUrl: "http://127.0.0.1:7890",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(mixedConfig, null, 2)}\n`, "utf8");

  const result = await runMigrate(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.migrationSource, "mixed-source");
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "legacy-openclaw-wechat"), true);
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "sunnoy-wecom"), true);
});
