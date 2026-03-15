import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

test("openclaw.plugin.json allows bot-only accounts (no required agent creds)", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const accountSchema = manifest?.configSchema?.properties?.accounts?.additionalProperties;
  assert.ok(accountSchema && typeof accountSchema === "object");
  assert.equal(Array.isArray(accountSchema.required), false);
});

test("openclaw.plugin.json exposes wecom doc tool config", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest?.configSchema?.properties?.tools?.properties?.doc?.default, true);
  assert.equal(
    manifest?.configSchema?.properties?.tools?.properties?.docAutoGrantRequesterCollaborator?.default,
    true,
  );
  assert.equal(
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.tools?.properties?.doc?.default,
    true,
  );
  assert.equal(
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.tools?.properties
      ?.docAutoGrantRequesterCollaborator?.default,
    true,
  );
});

test("openclaw.plugin.json supports dm pairing mode", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const topLevelModes = manifest?.configSchema?.properties?.dm?.properties?.mode?.enum ?? [];
  const accountModes =
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.dm?.properties?.mode?.enum ?? [];
  assert.equal(topLevelModes.includes("pairing"), true);
  assert.equal(accountModes.includes("pairing"), true);
});

test("openclaw.plugin.json exposes group policy fields", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const topLevelModes = manifest?.configSchema?.properties?.groupPolicy?.enum ?? [];
  const groupChatModes = manifest?.configSchema?.properties?.groupChat?.properties?.policy?.enum ?? [];
  const perGroupModes = manifest?.configSchema?.properties?.groups?.additionalProperties?.properties?.policy?.enum ?? [];
  const accountModes =
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.groupPolicy?.enum ?? [];
  assert.equal(topLevelModes.includes("allowlist"), true);
  assert.equal(groupChatModes.includes("deny"), true);
  assert.equal(perGroupModes.includes("open"), true);
  assert.equal(accountModes.includes("disabled"), true);
});

test("openclaw.plugin.json exposes quickstart onboarding metadata", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest?.channel?.detailLabel, "企业微信自建应用 / Bot");
  assert.equal(manifest?.channel?.systemImage, "building.2.crop.circle");
  assert.equal(manifest?.channel?.quickstartAllowFrom, true);
  assert.equal(manifest?.channel?.quickstart?.recommendedMode, "bot_long_connection");
  assert.equal(manifest?.channel?.quickstart?.defaultGroupProfile, "inherit");
  assert.equal(manifest?.channel?.quickstart?.supportsSetupPlan, true);
  assert.equal(manifest?.channel?.quickstart?.supportsWizard, true);
  assert.equal(manifest?.channel?.quickstart?.supportsRunChecks, true);
  assert.equal(manifest?.channel?.quickstart?.supportsActions, true);
  assert.equal(manifest?.channel?.quickstart?.supportsMigration, true);
  assert.equal(manifest?.channel?.quickstart?.supportsRepairPlan, true);
  assert.equal(manifest?.channel?.quickstart?.supportsConfirmRepair, true);
  assert.equal(manifest?.channel?.quickstart?.supportsDoctor, true);
  assert.equal(manifest?.channel?.quickstart?.supportsExternalInstaller, true);
  assert.equal(manifest?.channel?.quickstart?.installerSpec, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(manifest?.channel?.quickstart?.installerCommand, "npx -y @dingxiang-me/openclaw-wecom-cli install");
  assert.equal(
    manifest?.channel?.quickstart?.applyRepairCommand,
    "npm run wecom:quickstart -- --run-checks --apply-repair",
  );
  assert.equal(
    manifest?.channel?.quickstart?.confirmRepairCommand,
    "npm run wecom:quickstart -- --run-checks --confirm-repair",
  );
  assert.equal(manifest?.channel?.quickstart?.doctorCommand, "npm run wecom:doctor -- --json");
  assert.equal(manifest?.channel?.quickstart?.migrationCommand, "npm run wecom:migrate -- --json");
  assert.equal(manifest?.channel?.quickstart?.runChecksCommand, "npm run wecom:quickstart -- --run-checks");
  assert.equal(
    manifest?.channel?.quickstart?.forceChecksCommand,
    "npm run wecom:quickstart -- --run-checks --force-checks",
  );
  assert.equal(manifest?.channel?.quickstart?.setupCommand, "npm run wecom:quickstart -- --json");
  assert.equal(manifest?.channel?.quickstart?.wizardCommand, "npm run wecom:quickstart -- --wizard");
  assert.equal(manifest?.channel?.quickstart?.writeCommand, "npm run wecom:quickstart -- --write");
  assert.equal(Array.isArray(manifest?.channel?.quickstart?.modes), true);
  assert.equal(manifest?.channel?.quickstart?.modes?.some((item) => item?.id === "hybrid"), true);
  assert.equal(
    manifest?.channel?.quickstart?.modes?.every((item) => typeof item?.firstRunGoal === "string"),
    true,
  );
  assert.equal(
    manifest?.channel?.quickstart?.modes?.every((item) => Array.isArray(item?.requiredAdminSteps)),
    true,
  );
  assert.equal(
    manifest?.channel?.quickstart?.modes?.every((item) => Array.isArray(item?.successChecks)),
    true,
  );
  assert.equal(Array.isArray(manifest?.channel?.quickstart?.groupProfiles), true);
  assert.equal(
    manifest?.channel?.quickstart?.groupProfiles?.some((item) => item?.id === "allowlist_template"),
    true,
  );
});

test("openclaw.plugin.json exposes compatibility fields for official and sunnoy layouts", () => {
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest?.configSchema?.properties?.botId?.type, "string");
  assert.equal(manifest?.configSchema?.properties?.secret?.["x-sensitive"], true);
  assert.equal(manifest?.configSchema?.properties?.network?.properties?.egressProxyUrl?.type, "string");
  assert.equal(manifest?.configSchema?.properties?.network?.properties?.apiBaseUrl?.type, "string");
  assert.equal(
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.botId?.type,
    "string",
  );
  assert.equal(
    manifest?.configSchema?.properties?.accounts?.additionalProperties?.properties?.network?.properties?.apiBaseUrl?.type,
    "string",
  );
});
