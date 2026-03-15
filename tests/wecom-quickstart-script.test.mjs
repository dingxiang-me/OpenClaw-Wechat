import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runQuickstart(args = [], { input = "", env = {} } = {}) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-quickstart.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
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

test("wecom-quickstart prints recommended bot long connection starter config", async () => {
  const result = await runQuickstart(["--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode.id, "bot_long_connection");
  assert.equal(report.dmMode, "pairing");
  assert.equal(report.groupProfile.id, "inherit");
  assert.equal(report.installState, "fresh");
  assert.equal(report.migrationState, "fresh");
  assert.equal(report.migrationSource, "fresh");
  assert.equal(report.migration.source, "fresh");
  assert.ok(Array.isArray(report.placeholders));
  assert.ok(Array.isArray(report.setupChecklist));
  assert.ok(Array.isArray(report.actions));
  assert.equal(report.commands.migrate, "npm run wecom:migrate -- --json");
  assert.equal(report.commands.preview, "npm run wecom:quickstart -- --json");
  assert.equal(report.commands.runChecks, "npm run wecom:quickstart -- --run-checks");
  assert.equal(report.commands.forceChecks, "npm run wecom:quickstart -- --run-checks --force-checks");
  assert.equal(report.commands.applyRepair, "npm run wecom:quickstart -- --run-checks --apply-repair");
  assert.equal(report.commands.confirmRepair, "npm run wecom:quickstart -- --run-checks --confirm-repair");
  assert.equal(report.commands.wizard, "npm run wecom:quickstart -- --wizard");
  assert.equal(report.commands.write, "npm run wecom:quickstart -- --write");
  assert.equal(report.wizard.used, false);
  assert.equal(report.runChecks.command, "npm run wecom:quickstart -- --run-checks");
  assert.equal(report.runChecks.forceCommand, "npm run wecom:quickstart -- --run-checks --force-checks");
  assert.equal(report.runChecks.applyRepair, false);
  assert.equal(report.runChecks.confirmRepair, false);
  assert.equal(report.runChecks.requested, false);
  assert.equal(Array.isArray(report.checkCommands), true);
  assert.equal(report.checkCommands.every((item) => item.includes("--config")), true);
  assert.equal(report.checkCommands.some((item) => item.includes("wecom:doctor")), true);
  assert.equal(report.sourcePlaybook.source, "fresh");
  assert.equal(report.sourcePlaybook.repairDefaults.doctorFixMode, "off");
  assert.equal(report.sourcePlaybook.checkOrder[0].id, "doctor_offline");
  assert.equal(report.actions.some((item) => item.kind === "fill_config"), true);
  assert.equal(report.actions.some((item) => item.kind === "write_patch"), true);
  assert.equal(report.actions.some((item) => item.kind === "restart_gateway"), true);
  assert.equal(report.placeholders.some((item) => item.path === "channels.wecom.bot.longConnection.botId"), true);
  assert.equal(report.setupChecklist.some((item) => item.id === "fill-placeholders"), true);
  assert.equal(report.starterConfig.channels.wecom.bot.enabled, true);
  assert.equal(report.starterConfig.channels.wecom.bot.longConnection.enabled, true);
  assert.equal(report.starterConfig.channels.wecom.dm.mode, "pairing");
  assert.equal(report.mode.firstRunGoal, "先把 Bot 收消息、回消息和长连接健康跑通。");
  assert.equal(Array.isArray(report.mode.requiredAdminSteps), true);
  assert.equal(Array.isArray(report.mode.successChecks), true);
  assert.equal(report.write.applied, false);
  assert.equal(report.postcheck.repairArtifacts, null);
  assert.equal(report.postcheck.repairPlan, null);
});

test("wecom-quickstart supports account-scoped agent callback starter config", async () => {
  const result = await runQuickstart([
    "--mode",
    "agent_callback",
    "--account",
    "sales",
    "--dm-mode",
    "allowlist",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode.id, "agent_callback");
  assert.equal(report.accountId, "sales");
  assert.equal(report.starterConfig.channels.wecom.defaultAccount, "sales");
  assert.equal(report.starterConfig.channels.wecom.accounts.sales.dm.mode, "allowlist");
  assert.equal(report.starterConfig.channels.wecom.accounts.sales.webhookPath, "/wecom/callback");
});

test("wecom-quickstart applies allowlist group profile template", async () => {
  const result = await runQuickstart([
    "--mode",
    "hybrid",
    "--group-profile",
    "allowlist_template",
    "--group-chat-id",
    "wr-ops-room",
    "--group-allow",
    "ops_lead,oncall_user",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.groupProfile.id, "allowlist_template");
  assert.deepEqual(report.groupAllow, ["ops_lead", "oncall_user"]);
  assert.equal(report.starterConfig.channels.wecom.groupPolicy, "allowlist");
  assert.deepEqual(report.starterConfig.channels.wecom.groupAllowFrom, ["ops_lead", "oncall_user"]);
  assert.deepEqual(report.starterConfig.channels.wecom.groups["wr-ops-room"].allowFrom, ["ops_lead", "oncall_user"]);
  assert.equal(report.starterConfig.channels.wecom.groups["wr-ops-room"].policy, "allowlist");
  assert.equal(report.placeholders.some((item) => item.path === "channels.wecom.bot.longConnection.botId"), true);
  assert.equal(report.setupChecklist.some((item) => item.id === "group-allowlist"), true);
  assert.deepEqual(report.warnings, []);
});

test("wecom-quickstart warns when allowlist template still uses default group placeholders", async () => {
  const result = await runQuickstart([
    "--group-profile",
    "allowlist_template",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.warnings.some((item) => /默认 chatId/.test(item)), true);
  assert.equal(report.warnings.some((item) => /示例成员/.test(item)), true);
  assert.equal(report.setupChecklist.some((item) => item.id === "group-allowlist"), true);
});

test("wecom-quickstart detects legacy migration state from existing config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-legacy-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const legacyConfig = {
    channels: {
      wecom: {
        agent: {
          corpId: "ww-legacy",
          corpSecret: "legacy-secret",
          agentId: 1000002,
          token: "legacy-token",
          encodingAesKey: "legacy-aes-key",
          webhookPath: "/legacy/callback",
        },
        sales: {
          corpId: "ww-sales",
          corpSecret: "sales-secret",
          agentId: 1000003,
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8");

  const result = await runQuickstart(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.installState, "legacy_config");
  assert.equal(report.migrationState, "legacy_config");
  assert.equal(report.migrationSource, "legacy-openclaw-wechat");
  assert.equal(report.migration.source, "legacy-openclaw-wechat");
  assert.equal(report.sourcePlaybook.source, "legacy-openclaw-wechat");
  assert.equal(report.sourcePlaybook.repairDefaults.doctorFixMode, "auto");
  assert.equal(report.sourcePlaybook.checkOrder.some((item) => item.id === "agent_selfcheck"), true);
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_agent_block"), true);
  assert.equal(report.detectedLegacyFields.some((item) => item.kind === "legacy_inline_account"), true);
  assert.equal(report.migrationSourceSignals.some((item) => item.source === "legacy-openclaw-wechat"), true);
  assert.equal(report.actions.some((item) => item.command === "npm run wecom:migrate -- --json"), true);
  assert.equal(report.actions.some((item) => item.id === "review-source-playbook"), true);
  assert.ok(report.migration.configPatch?.channels?.wecom?.accounts?.default);
});

test("wecom-quickstart exposes confirm-first repair defaults for sunnoy source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-sunnoy-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const compatConfig = {
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
  await writeFile(configPath, `${JSON.stringify(compatConfig, null, 2)}\n`, "utf8");

  const result = await runQuickstart(["--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.migrationSource, "sunnoy-wecom");
  assert.equal(report.sourcePlaybook.source, "sunnoy-wecom");
  assert.equal(report.sourcePlaybook.repairDefaults.doctorFixMode, "confirm");
  assert.equal(report.sourcePlaybook.checkOrder.some((item) => item.id === "doctor_online"), true);
  assert.equal(report.warnings.some((item) => /默认只给修复建议/.test(item)), true);
  assert.equal(report.actions.some((item) => item.id === "review-source-playbook"), true);
});

test("wecom-quickstart merges starter config into target file and creates backup", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    plugins: {
      allow: ["openclaw-wechat"],
    },
    channels: {
      telegram: {
        enabled: true,
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runQuickstart([
    "--mode",
    "hybrid",
    "--config",
    configPath,
    "--write",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.write.applied, true);
  assert.equal(typeof report.write.backupPath, "string");

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.telegram.enabled, true);
  assert.equal(merged.channels.wecom.bot.enabled, true);
  assert.equal(merged.channels.wecom.bot.longConnection.enabled, true);
  assert.equal(merged.channels.wecom.corpId, "ww-your-corp-id");
  assert.equal(merged.channels.wecom.groupPolicy, undefined);

  const backup = JSON.parse(await readFile(report.write.backupPath, "utf8"));
  assert.deepEqual(backup, initialConfig);
});

test("wecom-quickstart wizard can accept defaults and keep report machine-readable", async () => {
  const result = await runQuickstart(["--wizard", "--json"], {
    input: "\n\n\n\nn\n",
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.wizard.used, true);
  assert.equal(report.wizard.command, "npm run wecom:quickstart -- --wizard");
  assert.equal(report.mode.id, "bot_long_connection");
  assert.equal(report.dmMode, "pairing");
  assert.equal(report.groupProfile.id, "inherit");
  assert.equal(report.write.applied, false);
  assert.equal(report.postcheck.requested, false);
  assert.deepEqual(report.postcheck.remediation, []);
  assert.equal(report.postcheck.repairArtifacts, null);
  assert.match(result.stderr, /WeCom quickstart wizard/);
});

test("wecom-quickstart wizard can collect allowlist answers and write config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-wizard-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runQuickstart(["--wizard", "--json"], {
    input: [
      "3",
      "ops",
      "2",
      "4",
      "wr-ops-room",
      "ops_lead,oncall_user",
      "y",
      configPath,
      "",
    ].join("\n"),
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.wizard.used, true);
  assert.equal(report.mode.id, "hybrid");
  assert.equal(report.accountId, "ops");
  assert.equal(report.dmMode, "open");
  assert.equal(report.groupProfile.id, "allowlist_template");
  assert.deepEqual(report.groupAllow, ["ops_lead", "oncall_user"]);
  assert.equal(report.write.applied, true);
  assert.equal(report.postcheck.requested, false);
  assert.deepEqual(report.postcheck.remediation, []);
  assert.equal(report.postcheck.repairArtifacts, null);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.wecom.defaultAccount, "ops");
  assert.equal(merged.channels.wecom.accounts.ops.groupPolicy, "allowlist");
  assert.deepEqual(merged.channels.wecom.accounts.ops.groups["wr-ops-room"].allowFrom, ["ops_lead", "oncall_user"]);
});

test("wecom-quickstart blocks run-checks when placeholders remain", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-blocked-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runQuickstart(["--run-checks", "--config", configPath, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.postcheck.requested, true);
  assert.equal(report.postcheck.blockedByPlaceholders, true);
  assert.equal(report.postcheck.executed, 0);
  assert.equal(report.postcheck.skipped, report.checkCommands.length);
  assert.equal(report.postcheck.remediation.some((item) => item.id === "fill-placeholders"), true);
  assert.deepEqual(report.postcheck.repairArtifacts.groups, ["botLongConnection"]);
  assert.equal(report.postcheck.repairArtifacts.configPath, "channels.wecom");
  assert.equal(report.postcheck.repairArtifacts.accountPatch.bot.longConnection.botId, "your-bot-id");
  assert.equal(
    report.postcheck.repairArtifacts.envTemplate.lines.includes("WECOM_BOT_LONG_CONNECTION_BOT_ID=your-bot-id"),
    true,
  );
  assert.equal(report.postcheck.repairPlan.requiresConfirmation, true);
  assert.equal(report.postcheck.repairPlan.changes.some((item) => item.path === "channels.wecom.bot.longConnection.botId"), true);
});

test("wecom-quickstart can force run stubbed checks and capture summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-stubbed-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runQuickstart(["--run-checks", "--force-checks", "--config", configPath, "--json"], {
    env: {
      WECOM_QUICKSTART_CHECKS_STUB_JSON: JSON.stringify({
        checks: [
          {
            command: "npm run wecom:selfcheck -- --json",
            ok: true,
            exitCode: 0,
            timedOut: false,
            summary: "2/2 passed",
          },
          {
            command: "npm run wecom:bot:selfcheck -- --json",
            ok: false,
            exitCode: 1,
            timedOut: false,
            summary: "1/2 passed",
            failedChecks: [
              {
                name: "config.bot.encodingAesKey",
                detail: "missing",
              },
              {
                name: "e2e.url.verify",
                detail: "request failed: timeout",
              },
            ],
          },
        ],
      }),
    },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.postcheck.requested, true);
  assert.equal(report.postcheck.forced, true);
  assert.equal(report.postcheck.blockedByPlaceholders, false);
  assert.equal(report.postcheck.summary.passed, 1);
  assert.equal(report.postcheck.summary.failed, 1);
  assert.equal(report.postcheck.checks.length, 2);
  assert.equal(report.postcheck.remediation.some((item) => item.id === "callback-secrets"), true);
  assert.equal(report.postcheck.remediation.some((item) => item.id === "url-verify"), true);
  assert.equal(report.postcheck.repairArtifacts.groups.includes("botWebhook"), true);
  assert.equal(report.postcheck.repairArtifacts.groups.includes("botLongConnection"), true);
  assert.equal(report.postcheck.repairArtifacts.configPath, "channels.wecom");
  assert.equal(report.postcheck.repairArtifacts.accountPatch.bot.enabled, true);
  assert.equal(
    report.postcheck.repairArtifacts.envTemplate.lines.includes("WECOM_BOT_TOKEN=your-bot-token"),
    true,
  );
});

test("wecom-quickstart can write repair artifact files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-repair-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const repairDir = path.join(tempDir, "repair");
  const result = await runQuickstart(["--run-checks", "--config", configPath, "--repair-dir", repairDir, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.postcheck.blockedByPlaceholders, true);
  assert.equal(report.postcheck.repairArtifacts.files.directory, repairDir);
  assert.equal(
    report.postcheck.repairArtifacts.files.configPatchFile,
    path.join(repairDir, "wecom.config-patch.json"),
  );
  assert.equal(
    report.postcheck.repairArtifacts.files.envTemplateFile,
    path.join(repairDir, "wecom.env.template"),
  );
  assert.equal(
    report.postcheck.repairPlan.fileWrites.some((item) => item.path === path.join(repairDir, "wecom.config-patch.json")),
    true,
  );

  const configPatch = JSON.parse(
    await readFile(report.postcheck.repairArtifacts.files.configPatchFile, "utf8"),
  );
  const accountPatch = JSON.parse(
    await readFile(report.postcheck.repairArtifacts.files.accountPatchFile, "utf8"),
  );
  const envTemplate = await readFile(report.postcheck.repairArtifacts.files.envTemplateFile, "utf8");
  const notes = await readFile(report.postcheck.repairArtifacts.files.notesFile, "utf8");

  assert.equal(configPatch.channels.wecom.bot.longConnection.botId, "your-bot-id");
  assert.equal(accountPatch.bot.longConnection.secret, "your-bot-secret");
  assert.match(envTemplate, /WECOM_BOT_LONG_CONNECTION_SECRET=your-bot-secret/);
  assert.match(notes, /wecom\.config-patch\.json/);
});

test("wecom-quickstart can auto-apply repair patch while preserving existing config values", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-apply-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      telegram: {
        enabled: true,
      },
      wecom: {
        bot: {
          longConnection: {
            botId: "real-bot-id",
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runQuickstart([
    "--run-checks",
    "--apply-repair",
    "--config",
    configPath,
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runChecks.applyRepair, true);
  assert.equal(report.runChecks.confirmRepair, false);
  assert.equal(report.repairApply.requested, true);
  assert.equal(report.repairApply.prompted, false);
  assert.equal(report.repairApply.confirmed, true);
  assert.equal(report.repairApply.applied, true);
  assert.equal(report.repairApply.configPath, configPath);
  assert.equal(typeof report.repairApply.backupPath, "string");
  assert.equal(report.repairApply.changedPaths.includes("channels.wecom.enabled"), true);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.channels.telegram.enabled, true);
  assert.equal(merged.channels.wecom.enabled, true);
  assert.equal(merged.channels.wecom.bot.enabled, true);
  assert.equal(merged.channels.wecom.bot.longConnection.enabled, true);
  assert.equal(merged.channels.wecom.bot.longConnection.botId, "real-bot-id");
  assert.equal(merged.channels.wecom.bot.longConnection.secret, "your-bot-secret");
});

test("wecom-quickstart can preview and skip repair patch when confirmation is declined", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-confirm-decline-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const initialConfig = {
    channels: {
      wecom: {
        bot: {
          longConnection: {
            botId: "existing-bot-id",
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  const result = await runQuickstart(["--run-checks", "--confirm-repair", "--config", configPath, "--json"], {
    input: "n\n",
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runChecks.applyRepair, true);
  assert.equal(report.runChecks.confirmRepair, true);
  assert.equal(report.repairApply.requested, true);
  assert.equal(report.repairApply.prompted, true);
  assert.equal(report.repairApply.confirmed, false);
  assert.equal(report.repairApply.applied, false);
  assert.equal(report.repairApply.reason, "user declined repair patch");
  assert.deepEqual(report.repairApply.changedPaths, []);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(merged, initialConfig);
  assert.match(result.stderr, /Repair preview/);
  assert.match(result.stderr, /channels\.wecom\.bot\.longConnection\.botId/);
});

test("wecom-quickstart text output includes repair artifacts for failed checks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-quickstart-text-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const result = await runQuickstart(["--run-checks", "--force-checks", "--config", configPath], {
    env: {
      WECOM_QUICKSTART_CHECKS_STUB_JSON: JSON.stringify({
        checks: [
          {
            command: "npm run wecom:bot:selfcheck -- --json",
            ok: false,
            exitCode: 1,
            timedOut: false,
            summary: "0/2 passed",
            failedChecks: [
              {
                name: "config.bot.token",
                detail: "missing",
              },
            ],
          },
        ],
      }),
    },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /- repairArtifacts:/);
  assert.match(result.stdout, /- repairPlan:/);
  assert.match(result.stdout, /configPath: channels\.wecom/);
  assert.match(result.stdout, /WECOM_BOT_TOKEN=your-bot-token/);
});
