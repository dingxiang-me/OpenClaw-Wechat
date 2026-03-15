import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runDoctor(args = [], { input = "" } = {}) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-doctor.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
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
    if (input) {
      child.stdin.write(input);
    }
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

function validAesKey(fill = 9) {
  return Buffer.alloc(32, fill).toString("base64").replace(/=+$/g, "");
}

test("wecom-doctor reports ready for modern config when network checks are skipped", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-doctor-ready-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
    },
    channels: {
      wecom: {
        defaultAccount: "default",
        accounts: {
          default: {
            corpId: "ww-modern",
            corpSecret: "modern-secret",
            agentId: 1000001,
            callbackToken: "modern-token",
            callbackAesKey: validAesKey(9),
            webhookPath: "/wecom/callback",
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.status, "ready");
  assert.equal(report.commands.doctor, "npm run wecom:doctor -- --json");
  assert.equal(report.migrationSection.status, "ok");
  assert.equal(report.migrationSource, "native-openclaw-wechat");
  assert.equal(report.migrationSection.report.migrationSource, "native-openclaw-wechat");
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].accountId, "default");
  assert.equal(report.accounts[0].sections.selfcheck.status, "ok");
  assert.equal(report.accounts[0].sections.agentE2E.status, "skipped");
  assert.equal(report.accounts[0].sections.botE2E.status, "skipped");
  assert.equal(report.accounts[0].sections.longConnection.status, "skipped");
  assert.equal(report.accounts[0].sections.callbackMatrix.status, "skipped");
});

test("wecom-doctor flags legacy layout and stale package as action required", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-doctor-legacy-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
      installs: {
        "openclaw-wechat": {
          version: "1.7.2",
          resolvedVersion: "1.7.2",
        },
      },
    },
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
          token: "legacy-token",
          encodingAesKey: validAesKey(11),
          webhookPath: "/legacy/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.status, "action_required");
  assert.equal(report.migrationSection.status, "failed");
  assert.equal(report.migrationSource, "legacy-openclaw-wechat");
  assert.equal(report.migrationSection.report.migrationSource, "legacy-openclaw-wechat");
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_agent_block"), true);
  assert.equal(report.recommendedActions.some((item) => item.id === "upgrade-plugin-package"), true);
  assert.equal(report.recommendedActions.some((item) => item.id === "migrate-legacy-wecom-config"), true);
  assert.equal(report.recommendedActions.some((item) => item.id === "apply-doctor-fix"), true);
});

test("wecom-doctor --fix applies local migration patch and reruns on merged config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-doctor-fix-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
          token: "legacy-token",
          encodingAesKey: validAesKey(13),
          webhookPath: "/legacy/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--fix",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.fix.requested, true);
  assert.equal(report.fix.applied, true);
  assert.equal(report.migrationState, "ready");
  assert.equal(report.migrationSource, "native-openclaw-wechat");
  assert.equal(report.summary.status, "ready");

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.accounts.default.corpId, "ww-legacy");
  assert.equal(merged.channels.wecom.accounts.default.callbackToken, "legacy-token");
});

test("wecom-doctor --confirm-fix can decline patch application", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-doctor-confirm-fix-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    channels: {
      wecom: {
        botId: "official-bot-id",
        secret: "official-secret",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runDoctor([
    "--config",
    configPath,
    "--skip-network",
    "--confirm-fix",
    "--json",
  ], { input: "n\n" });
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.fix.requested, true);
  assert.equal(report.fix.prompted, true);
  assert.equal(report.fix.confirmed, false);
  assert.equal(report.fix.applied, false);
  assert.match(report.fix.reason, /declined|not approved/);

  const unchanged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(unchanged.channels.wecom.botId, "official-bot-id");
});
