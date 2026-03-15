import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_VERSION } from "../src/wecom/plugin-constants.js";

test("package.json declares openclaw install metadata", () => {
  const packagePath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(pkg?.openclaw?.install?.defaultChoice, "npm");
  assert.equal(pkg?.openclaw?.install?.npmSpec, "@dingxiang-me/openclaw-wechat");
  assert.equal(pkg?.openclaw?.channel?.quickstartAllowFrom, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.recommendedMode, "bot_long_connection");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.defaultGroupProfile, "inherit");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsSetupPlan, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsWizard, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsRunChecks, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsActions, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsMigration, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsRepairPlan, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsConfirmRepair, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsDoctor, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.supportsExternalInstaller, true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.installerSpec, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.installerCommand, "npx -y @dingxiang-me/openclaw-wecom-cli install");
  assert.equal(
    pkg?.openclaw?.channel?.quickstart?.applyRepairCommand,
    "npm run wecom:quickstart -- --run-checks --apply-repair",
  );
  assert.equal(
    pkg?.openclaw?.channel?.quickstart?.confirmRepairCommand,
    "npm run wecom:quickstart -- --run-checks --confirm-repair",
  );
  assert.equal(pkg?.openclaw?.channel?.quickstart?.doctorCommand, "npm run wecom:doctor -- --json");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.migrationCommand, "npm run wecom:migrate -- --json");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.runChecksCommand, "npm run wecom:quickstart -- --run-checks");
  assert.equal(
    pkg?.openclaw?.channel?.quickstart?.forceChecksCommand,
    "npm run wecom:quickstart -- --run-checks --force-checks",
  );
  assert.equal(pkg?.openclaw?.channel?.quickstart?.setupCommand, "npm run wecom:quickstart -- --json");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.wizardCommand, "npm run wecom:quickstart -- --wizard");
  assert.equal(pkg?.openclaw?.channel?.quickstart?.writeCommand, "npm run wecom:quickstart -- --write");
  assert.equal(Array.isArray(pkg?.openclaw?.channel?.quickstart?.modes), true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.modes?.length, 3);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.modes?.every((item) => typeof item?.firstRunGoal === "string"), true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.modes?.every((item) => Array.isArray(item?.requiredAdminSteps)), true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.modes?.every((item) => Array.isArray(item?.successChecks)), true);
  assert.equal(Array.isArray(pkg?.openclaw?.channel?.quickstart?.groupProfiles), true);
  assert.equal(pkg?.openclaw?.channel?.quickstart?.groupProfiles?.length, 5);
  assert.equal(pkg?.openclaw?.install?.installerSpec, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(pkg?.openclaw?.install?.installerCommand, "npx -y @dingxiang-me/openclaw-wecom-cli install");
  assert.equal(pkg?.scripts?.["wecom:doctor"], "node ./scripts/wecom-doctor.mjs");
  assert.equal(pkg?.scripts?.["wecom:migrate"], "node ./scripts/wecom-migrate.mjs");
});

test("package metadata, plugin manifest, and runtime constant stay version-synced", () => {
  const packagePath = path.resolve(process.cwd(), "package.json");
  const cliPackagePath = path.resolve(process.cwd(), "packages/openclaw-wecom-cli/package.json");
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const cliPkg = JSON.parse(fs.readFileSync(cliPackagePath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.equal(cliPkg.version, pkg.version);
  assert.equal(cliPkg.dependencies["@dingxiang-me/openclaw-wechat"], `^${pkg.version}`);
  assert.equal(pkg?.openclaw?.channel?.id, "wecom");
  assert.deepEqual(manifest?.channels, ["wecom"]);
});
