import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWecomInstallerConfigPatch,
  buildWecomInstallerPlan,
  buildWecomPluginInstallCommand,
  WECOM_INSTALLER_COMMAND,
  WECOM_INSTALLER_NPM_SPEC,
  WECOM_PLUGIN_ENTRY_ID,
  WECOM_PLUGIN_NPM_SPEC,
} from "../src/wecom/installer-api.js";

test("installer plan fills supplied bot credentials and enables plugin entry", () => {
  const plan = buildWecomInstallerPlan({
    mode: "bot_long_connection",
    values: {
      botId: "bot-123",
      botSecret: "secret-123",
    },
  });

  assert.equal(plan.accountId, "default");
  assert.equal(plan.placeholders.length, 0);
  assert.equal(plan.configPatch.plugins.enabled, true);
  assert.deepEqual(plan.configPatch.plugins.allow, [WECOM_PLUGIN_ENTRY_ID]);
  assert.equal(plan.configPatch.plugins.entries[WECOM_PLUGIN_ENTRY_ID].enabled, true);
  assert.equal(plan.starterConfig.channels.wecom.bot.longConnection.botId, "bot-123");
  assert.equal(plan.starterConfig.channels.wecom.bot.longConnection.secret, "secret-123");
  assert.equal(plan.installer.installerNpmSpec, WECOM_INSTALLER_NPM_SPEC);
  assert.equal(plan.installer.installerCommand, WECOM_INSTALLER_COMMAND);
});

test("installer plan fills account-scoped hybrid credentials", () => {
  const plan = buildWecomInstallerPlan({
    mode: "hybrid",
    accountId: "sales",
    values: {
      corpId: "ww-sales",
      corpSecret: "sales-secret",
      agentId: 1000011,
      callbackToken: "cb-token",
      callbackAesKey: "cb-aes",
      botId: "sales-bot",
      botSecret: "sales-bot-secret",
    },
  });

  assert.equal(plan.accountId, "sales");
  assert.equal(plan.placeholders.length, 0);
  assert.equal(plan.starterConfig.channels.wecom.defaultAccount, "sales");
  assert.equal(plan.starterConfig.channels.wecom.accounts.sales.corpId, "ww-sales");
  assert.equal(plan.starterConfig.channels.wecom.accounts.sales.bot.longConnection.botId, "sales-bot");
  assert.equal(plan.starterConfig.channels.wecom.accounts.sales.bot.longConnection.secret, "sales-bot-secret");
});

test("applyWecomInstallerConfigPatch writes merged config and backup", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-installer-api-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const plan = buildWecomInstallerPlan({
    mode: "bot_long_connection",
    values: {
      botId: "bot-999",
      botSecret: "secret-999",
    },
  });

  const applied = await applyWecomInstallerConfigPatch(configPath, plan.configPatch);
  assert.equal(applied.applied, true);
  assert.equal(applied.existed, false);
  assert.equal(applied.changedPaths.includes("channels.wecom.bot.longConnection.botId"), true);
  assert.equal(applied.backupPath, null);

  const merged = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(merged.plugins.enabled, true);
  assert.equal(merged.channels.wecom.bot.longConnection.botId, "bot-999");
});

test("installer plan hydrates starter config from official-style legacy layout", () => {
  const currentConfig = {
    channels: {
      wecom: {
        botId: "legacy-bot-id",
        secret: "legacy-secret",
      },
    },
  };
  const plan = buildWecomInstallerPlan({
    mode: "bot_long_connection",
    from: "official-wecom",
    currentConfig,
  });

  assert.equal(plan.source, "official-wecom");
  assert.equal(plan.migration.requestedSource, "official-wecom");
  assert.equal(plan.migration.detectedSource, "official-wecom");
  assert.equal(plan.migration.effectiveSource, "official-wecom");
  assert.equal(plan.placeholders.some((item) => item.path === "channels.wecom.bot.longConnection.botId"), false);
  assert.equal(plan.starterConfig.channels.wecom.bot.longConnection.botId, "legacy-bot-id");
  assert.equal(plan.starterConfig.channels.wecom.bot.longConnection.secret, "legacy-secret");
  assert.equal(plan.migration.canAutoFix, true);
  assert.equal(plan.migration.guide.source, "official-wecom");
  assert.equal(plan.sourceProfile.repairDefaults.doctorFixMode, "auto");
  assert.equal(plan.sourceProfile.checkOrder[0].id, "doctor_offline");
  assert.equal(plan.sourceProfile.checkOrder.some((item) => item.id === "bot_longconn_probe"), true);
  assert.equal(Array.isArray(plan.actions), true);
  assert.equal(plan.actions.some((item) => item.id === "review-installer-migration-source"), true);
  assert.equal(plan.actions.some((item) => item.id === "installer-run-doctor-fix"), true);
  assert.equal(plan.actions.some((item) => item.id === "review-installer-check-order"), true);
  assert.equal(plan.actions.some((item) => item.id === "setup:write-starter-config"), true);
});

test("installer plan auto-selects agent_callback for legacy agent-only source when mode is omitted", () => {
  const currentConfig = {
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
  const plan = buildWecomInstallerPlan({
    from: "legacy-openclaw-wechat",
    currentConfig,
  });

  assert.equal(plan.mode.id, "agent_callback");
  assert.equal(plan.sourceProfile.source, "legacy-openclaw-wechat");
  assert.equal(plan.sourceProfile.selectedMode, "agent_callback");
  assert.equal(plan.sourceProfile.modeDerived, true);
  assert.equal(plan.sourceProfile.repairDefaults.doctorFixMode, "auto");
  assert.equal(plan.sourceProfile.checkOrder.some((item) => item.id === "agent_selfcheck"), true);
  assert.equal(plan.sourceProfile.checkOrder.some((item) => item.id === "channel_selfcheck"), true);
  assert.equal(plan.actions.some((item) => item.id === "review-installer-selected-mode"), true);
});

test("installer plan keeps sunnoy migrations on confirm-first repair defaults", () => {
  const currentConfig = {
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
  const plan = buildWecomInstallerPlan({
    from: "sunnoy-wecom",
    currentConfig,
  });

  assert.equal(plan.sourceProfile.source, "sunnoy-wecom");
  assert.equal(plan.sourceProfile.selectedMode, "bot_long_connection");
  assert.equal(plan.sourceProfile.repairDefaults.doctorFixMode, "confirm");
  assert.equal(plan.sourceProfile.repairDefaults.preserveNetworkCompatibility, true);
  assert.equal(plan.sourceProfile.checkOrder.some((item) => item.id === "doctor_online"), true);
  assert.equal(plan.sourceProfile.checkOrder.some((item) => item.id === "bot_longconn_probe"), true);
  assert.equal(plan.actions.some((item) => item.id === "review-installer-check-order"), true);
});

test("buildWecomPluginInstallCommand returns openclaw plugin install invocation", () => {
  const command = buildWecomPluginInstallCommand({ openclawBin: "/usr/local/bin/openclaw" });
  assert.equal(command.bin, "/usr/local/bin/openclaw");
  assert.deepEqual(command.args, ["plugins", "install", WECOM_PLUGIN_NPM_SPEC]);
});
