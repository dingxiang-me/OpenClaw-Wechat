import assert from "node:assert/strict";
import test from "node:test";

import { createWecomChannelPlugin } from "../src/wecom/channel-plugin.js";
import {
  __resetWecomInboundActivityForTests,
  markWecomInboundActivity,
} from "../src/wecom/channel-status-state.js";

function createPluginHarness(overrides = {}) {
  const calls = {
    sendText: [],
    webhookText: [],
    webhookMedia: [],
    outboundMedia: [],
  };
  const logger = { info() {}, warn() {}, error() {} };
  const directConfig = {
    corpId: "ww1",
    corpSecret: "sec",
    agentId: "1001",
    callbackToken: "token",
    callbackAesKey: "aes",
    webhookPath: "/wecom/callback",
    outboundProxy: "",
    webhooks: { ops: { url: "https://example.com", key: "k1" } },
  };
  const runtime = { config: { channels: { wecom: {} } }, logger };

  const plugin = createWecomChannelPlugin({
    listWecomAccountIds: () => ["default"],
    getWecomConfig: () => directConfig,
    getGatewayRuntime: () => runtime,
    normalizeWecomResolvedTarget: (to) => {
      if (to === "webhook") return { webhook: "ops" };
      if (to === "direct") return { toUser: "alice" };
      return null;
    },
    formatWecomTargetForLog: (target) => JSON.stringify(target),
    sendWecomWebhookText: async (payload) => {
      calls.webhookText.push(payload);
    },
    sendWecomWebhookMediaBatch: async (payload) => {
      calls.webhookMedia.push(payload);
      return { total: 1, sentCount: 1, failed: [] };
    },
    sendWecomOutboundMediaBatch: async (payload) => {
      calls.outboundMedia.push(payload);
      return { total: 1, sentCount: 1, failed: [] };
    },
    sendWecomText: async (payload) => {
      calls.sendText.push(payload);
    },
    ...overrides,
  });

  return { plugin, calls };
}

test("channel plugin outbound.sendText supports webhook target", async () => {
  const { plugin, calls } = createPluginHarness();
  const result = await plugin.outbound.sendText({ to: "webhook", text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "wecom-webhook");
  assert.equal(calls.webhookText.length, 1);
  assert.equal(calls.sendText.length, 0);
});

test("channel plugin inbound.deliverReply sends media + text for direct target", async () => {
  const { plugin, calls } = createPluginHarness();
  const result = await plugin.inbound.deliverReply({
    to: "direct",
    text: "done",
    mediaUrl: "https://example.com/a.png",
    mediaType: "image",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.outboundMedia.length, 1);
  assert.equal(calls.sendText.length, 1);
});

test("channel plugin resolveTarget validates target", () => {
  const { plugin } = createPluginHarness();
  const fail = plugin.outbound.resolveTarget({ to: "" });
  assert.equal(fail.ok, false);
});

test("channel plugin status localizes default account name and computes connected", () => {
  __resetWecomInboundActivityForTests();
  const { plugin } = createPluginHarness();
  const account = plugin.config.resolveAccount({}, "default");
  const snapshot = plugin.status.buildAccountSnapshot({
    account,
    cfg: { channels: { wecom: {} } },
    runtime: {},
  });
  assert.equal(snapshot.accountId, "default");
  assert.equal(snapshot.name, "默认账号");
  assert.equal(snapshot.connected, true);

  const summary = plugin.status.buildChannelSummary({ snapshot });
  assert.equal(summary.connected, true);
});

test("channel plugin exposes pairing metadata and quickstart hints", async () => {
  const { plugin, calls } = createPluginHarness();
  assert.equal(plugin.meta.quickstartAllowFrom, true);
  assert.equal(plugin.meta.quickstart?.recommendedMode, "bot_long_connection");
  assert.equal(plugin.meta.quickstart?.defaultGroupProfile, "inherit");
  assert.equal(plugin.meta.quickstart?.supportsSetupPlan, true);
  assert.equal(plugin.meta.quickstart?.supportsWizard, true);
  assert.equal(plugin.meta.quickstart?.supportsRunChecks, true);
  assert.equal(plugin.meta.quickstart?.supportsActions, true);
  assert.equal(plugin.meta.quickstart?.supportsMigration, true);
  assert.equal(plugin.meta.quickstart?.supportsRepairPlan, true);
  assert.equal(plugin.meta.quickstart?.supportsConfirmRepair, true);
  assert.equal(plugin.meta.quickstart?.supportsDoctor, true);
  assert.equal(plugin.meta.quickstart?.supportsExternalInstaller, true);
  assert.equal(plugin.meta.quickstart?.installerSpec, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(plugin.meta.quickstart?.installerCommand, "npx -y @dingxiang-me/openclaw-wecom-cli install");
  assert.equal(
    plugin.meta.quickstart?.applyRepairCommand,
    "npm run wecom:quickstart -- --run-checks --apply-repair",
  );
  assert.equal(
    plugin.meta.quickstart?.confirmRepairCommand,
    "npm run wecom:quickstart -- --run-checks --confirm-repair",
  );
  assert.equal(plugin.meta.quickstart?.doctorCommand, "npm run wecom:doctor -- --json");
  assert.equal(
    plugin.meta.quickstart?.migrationCommand,
    "npm run wecom:migrate -- --json",
  );
  assert.equal(plugin.meta.quickstart?.runChecksCommand, "npm run wecom:quickstart -- --run-checks");
  assert.equal(
    plugin.meta.quickstart?.forceChecksCommand,
    "npm run wecom:quickstart -- --run-checks --force-checks",
  );
  assert.equal(plugin.meta.quickstart?.setupCommand, "npm run wecom:quickstart -- --json");
  assert.equal(plugin.meta.quickstart?.wizardCommand, "npm run wecom:quickstart -- --wizard");
  assert.equal(plugin.meta.quickstart?.writeCommand, "npm run wecom:quickstart -- --write");
  assert.equal(Array.isArray(plugin.meta.quickstart?.modes), true);
  assert.equal(Array.isArray(plugin.meta.quickstart?.groupProfiles), true);
  assert.equal(plugin.meta.quickstart.groupProfiles.some((item) => item.id === "allowlist_template"), true);
  assert.equal(plugin.meta.quickstart.modes.some((item) => item.id === "bot_long_connection"), true);
  assert.equal(plugin.pairing.idLabel, "wecomUserId");
  assert.equal(plugin.pairing.normalizeAllowEntry("wecom:Alice"), "alice");

  const starter = plugin.quickstart.buildStarterConfig();
  assert.equal(starter.channels.wecom.bot.enabled, true);
  assert.equal(starter.channels.wecom.bot.longConnection.enabled, true);
  assert.equal(starter.channels.wecom.dm.mode, "pairing");

  const salesStarter = plugin.quickstart.buildStarterConfig({
    mode: "agent_callback",
    accountId: "sales",
    dmMode: "allowlist",
  });
  assert.equal(salesStarter.channels.wecom.defaultAccount, "sales");
  assert.equal(salesStarter.channels.wecom.accounts.sales.corpId, "ww-your-corp-id");
  assert.equal(salesStarter.channels.wecom.accounts.sales.dm.mode, "allowlist");

  const groupStarter = plugin.quickstart.buildStarterConfig({
    groupProfile: "allowlist_template",
    groupChatId: "wr-ops-room",
    groupAllow: ["ops_lead"],
  });
  const setupPlan = plugin.quickstart.buildSetupPlan({
    mode: "agent_callback",
    groupProfile: "allowlist_template",
  });
  assert.equal(plugin.quickstart.defaultGroupProfile, "inherit");
  assert.equal(plugin.quickstart.supportsSetupPlan, true);
  assert.equal(plugin.quickstart.supportsWizard, true);
  assert.equal(plugin.quickstart.supportsRunChecks, true);
  assert.equal(plugin.quickstart.supportsActions, true);
  assert.equal(plugin.quickstart.supportsMigration, true);
  assert.equal(plugin.quickstart.supportsRepairPlan, true);
  assert.equal(plugin.quickstart.supportsConfirmRepair, true);
  assert.equal(plugin.quickstart.supportsDoctor, true);
  assert.equal(plugin.quickstart.supportsExternalInstaller, true);
  assert.equal(plugin.quickstart.installerSpec, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(plugin.quickstart.installerCommand, "npx -y @dingxiang-me/openclaw-wecom-cli install");
  assert.equal(plugin.quickstart.applyRepairCommand, "npm run wecom:quickstart -- --run-checks --apply-repair");
  assert.equal(plugin.quickstart.confirmRepairCommand, "npm run wecom:quickstart -- --run-checks --confirm-repair");
  assert.equal(plugin.quickstart.doctorCommand, "npm run wecom:doctor -- --json");
  assert.equal(plugin.quickstart.migrationCommand, "npm run wecom:migrate -- --json");
  assert.equal(plugin.quickstart.runChecksCommand, "npm run wecom:quickstart -- --run-checks");
  assert.equal(plugin.quickstart.forceChecksCommand, "npm run wecom:quickstart -- --run-checks --force-checks");
  assert.equal(plugin.quickstart.setupCommand, "npm run wecom:quickstart -- --json");
  assert.equal(plugin.quickstart.wizardCommand, "npm run wecom:quickstart -- --wizard");
  assert.equal(plugin.quickstart.writeCommand, "npm run wecom:quickstart -- --write");
  assert.equal(Array.isArray(plugin.quickstart.listGroupProfiles()), true);
  assert.equal(groupStarter.channels.wecom.groupPolicy, "allowlist");
  assert.deepEqual(groupStarter.channels.wecom.groups["wr-ops-room"].allowFrom, ["ops_lead"]);
  assert.equal(Array.isArray(setupPlan.placeholders), true);
  assert.equal(setupPlan.commands.preview, "npm run wecom:quickstart -- --json");
  assert.equal(setupPlan.commands.runChecks, "npm run wecom:quickstart -- --run-checks");
  assert.equal(setupPlan.commands.forceChecks, "npm run wecom:quickstart -- --run-checks --force-checks");
  assert.equal(setupPlan.commands.applyRepair, "npm run wecom:quickstart -- --run-checks --apply-repair");
  assert.equal(setupPlan.commands.confirmRepair, "npm run wecom:quickstart -- --run-checks --confirm-repair");
  assert.equal(setupPlan.commands.migrate, "npm run wecom:migrate -- --json");
  assert.equal(setupPlan.installState, "fresh");
  assert.equal(Array.isArray(setupPlan.actions), true);
  assert.equal(setupPlan.actions.some((item) => item.kind === "apply_patch"), true);
  assert.equal(setupPlan.commands.wizard, "npm run wecom:quickstart -- --wizard");
  assert.equal(setupPlan.placeholders.some((item) => item.path === "channels.wecom.corpId"), true);
  assert.equal(setupPlan.checklist.some((item) => item.id === "public-webhook"), true);
  assert.equal(setupPlan.warnings.some((item) => /默认 chatId/.test(item)), true);

  await plugin.pairing.notifyApproval({
    cfg: { channels: { wecom: {} } },
    id: "wecom:Alice",
  });
  assert.equal(calls.sendText.length, 1);
  assert.equal(calls.sendText[0].toUser, "alice");
});

test("channel plugin status exposes last inbound timestamp from webhook activity", () => {
  __resetWecomInboundActivityForTests();
  markWecomInboundActivity({ accountId: "default", timestamp: 1700000000 });
  const { plugin } = createPluginHarness();
  const account = plugin.config.resolveAccount({}, "default");
  const snapshot = plugin.status.buildAccountSnapshot({
    account,
    cfg: { channels: { wecom: {} } },
    runtime: {},
  });
  assert.ok(Number.isFinite(snapshot.lastInboundAt));

  const summary = plugin.status.buildChannelSummary({ snapshot });
  assert.equal(summary.lastInbound, snapshot.lastInboundAt);
  assert.equal(summary.lastInbound, 1700000000 * 1000);
});

test("channel plugin setup validates missing env-backed input for new account", () => {
  const { plugin } = createPluginHarness();
  const error = plugin.setup.validateInput({
    cfg: {},
    accountId: "default",
    input: { useEnv: false },
  });
  assert.match(String(error || ""), /use-env|installer/i);
});

test("channel plugin setup can apply env-backed default bot config", () => {
  const { plugin } = createPluginHarness({
    processEnv: {
      WECOM_BOT_LONG_CONNECTION_BOT_ID: "bot-env-id",
      WECOM_BOT_LONG_CONNECTION_SECRET: "bot-env-secret",
    },
  });
  const nextConfig = plugin.setup.applyAccountConfig({
    cfg: {},
    accountId: "default",
    input: { useEnv: true },
  });
  assert.equal(nextConfig.plugins.enabled, true);
  assert.deepEqual(nextConfig.plugins.allow, ["openclaw-wechat"]);
  assert.equal(nextConfig.plugins.entries["openclaw-wechat"].enabled, true);
  assert.equal(nextConfig.channels.wecom.defaultAccount, "default");
  assert.equal(nextConfig.channels.wecom.bot.enabled, true);
  assert.equal(nextConfig.channels.wecom.bot.longConnection.enabled, true);
  assert.equal(nextConfig.channels.wecom.bot.longConnection.botId, "bot-env-id");
  assert.equal(nextConfig.channels.wecom.bot.longConnection.secret, "bot-env-secret");
});

test("channel plugin setup can apply env-backed non-default hybrid account", () => {
  const { plugin } = createPluginHarness({
    processEnv: {
      WECOM_SALES_CORP_ID: "ww-sales",
      WECOM_SALES_CORP_SECRET: "sales-secret",
      WECOM_SALES_AGENT_ID: "1000012",
      WECOM_SALES_CALLBACK_TOKEN: "sales-token",
      WECOM_SALES_CALLBACK_AES_KEY: "sales-aes",
      WECOM_SALES_WEBHOOK_PATH: "/wecom/sales/callback",
      WECOM_SALES_API_BASE_URL: "https://wecom.internal",
      WECOM_SALES_BOT_LONG_CONNECTION_BOT_ID: "sales-bot-id",
      WECOM_SALES_BOT_LONG_CONNECTION_SECRET: "sales-bot-secret",
    },
  });
  const nextConfig = plugin.setup.applyAccountConfig({
    cfg: {},
    accountId: "sales",
    input: { useEnv: true },
  });
  assert.equal(nextConfig.channels.wecom.defaultAccount, "sales");
  assert.equal(nextConfig.channels.wecom.accounts.sales.corpId, "ww-sales");
  assert.equal(nextConfig.channels.wecom.accounts.sales.corpSecret, "sales-secret");
  assert.equal(nextConfig.channels.wecom.accounts.sales.agentId, 1000012);
  assert.equal(nextConfig.channels.wecom.accounts.sales.callbackToken, "sales-token");
  assert.equal(nextConfig.channels.wecom.accounts.sales.callbackAesKey, "sales-aes");
  assert.equal(nextConfig.channels.wecom.accounts.sales.webhookPath, "/wecom/sales/callback");
  assert.equal(nextConfig.channels.wecom.accounts.sales.apiBaseUrl, "https://wecom.internal");
  assert.equal(nextConfig.channels.wecom.accounts.sales.bot.longConnection.botId, "sales-bot-id");
  assert.equal(nextConfig.channels.wecom.accounts.sales.bot.longConnection.secret, "sales-bot-secret");
});

test("channel plugin setup applyAccountName writes normalized account name", () => {
  const { plugin } = createPluginHarness();
  const nextConfig = plugin.setup.applyAccountName({
    cfg: {},
    accountId: "sales",
    name: "销售值班",
  });
  assert.equal(nextConfig.plugins.enabled, true);
  assert.equal(nextConfig.channels.wecom.accounts.sales.name, "销售值班");
});

test("channel plugin setup can apply direct wecom flags without env", () => {
  const { plugin } = createPluginHarness();
  const nextConfig = plugin.setup.applyAccountConfig({
    cfg: {},
    accountId: "ops",
    input: {
      corpId: "ww-ops",
      corpSecret: "ops-secret",
      agentId: "1000088",
      callbackToken: "ops-token",
      callbackAesKey: "ops-aes",
      webhookPath: "/wecom/ops/callback",
      apiBaseUrl: "https://ops.example.internal",
      outboundProxy: "http://127.0.0.1:7890",
      botId: "ops-bot-id",
      botSecret: "ops-bot-secret",
      botWebhookToken: "ops-webhook-token",
      botEncodingAesKey: "ops-encoding-aes",
      botWebhookPath: "/wecom/ops/bot/callback",
    },
  });
  assert.equal(nextConfig.channels.wecom.defaultAccount, "ops");
  assert.equal(nextConfig.channels.wecom.accounts.ops.corpId, "ww-ops");
  assert.equal(nextConfig.channels.wecom.accounts.ops.agentId, 1000088);
  assert.equal(nextConfig.channels.wecom.accounts.ops.apiBaseUrl, "https://ops.example.internal");
  assert.equal(nextConfig.channels.wecom.accounts.ops.outboundProxy, "http://127.0.0.1:7890");
  assert.equal(nextConfig.channels.wecom.accounts.ops.bot.longConnection.botId, "ops-bot-id");
  assert.equal(nextConfig.channels.wecom.accounts.ops.bot.longConnection.secret, "ops-bot-secret");
  assert.equal(nextConfig.channels.wecom.accounts.ops.bot.token, "ops-webhook-token");
  assert.equal(nextConfig.channels.wecom.accounts.ops.bot.encodingAesKey, "ops-encoding-aes");
  assert.equal(nextConfig.channels.wecom.accounts.ops.bot.webhookPath, "/wecom/ops/bot/callback");
});
