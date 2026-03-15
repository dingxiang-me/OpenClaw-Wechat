import { wecomChannelConfigSchema, wecomChannelConfigUiHints } from "./channel-config-schema.js";
import { normalizeAccountId } from "./account-config-core.js";
import {
  getWecomChannelInboundActivity,
  getWecomInboundActivity,
} from "./channel-status-state.js";
import { normalizeWecomAllowFromEntry } from "../core.js";
import { WECOM_INSTALLER_COMMAND, WECOM_INSTALLER_NPM_SPEC } from "./installer-api.js";
import {
  buildWecomQuickstartSetupPlan,
  buildWecomQuickstartConfig,
  WECOM_QUICKSTART_APPLY_REPAIR_COMMAND,
  WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND,
  WECOM_DOCTOR_COMMAND,
  listWecomQuickstartGroupProfiles,
  WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
  WECOM_QUICKSTART_MIGRATION_COMMAND,
  listWecomQuickstartModes,
  WECOM_QUICKSTART_RECOMMENDED_MODE,
  WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
  WECOM_QUICKSTART_SETUP_COMMAND,
  WECOM_QUICKSTART_WIZARD_COMMAND,
  WECOM_QUICKSTART_WRITE_COMMAND,
} from "./quickstart-metadata.js";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomChannelPlugin: ${name} is required`);
  }
}

function readString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function readNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== "object") return patch;
  const out = { ...asObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeDeep(asObject(base?.[key]), value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function ensureArrayIncludes(values, item) {
  const out = Array.isArray(values) ? values.slice() : [];
  if (!out.includes(item)) out.push(item);
  return out;
}

function buildPluginEnablePatch() {
  return {
    plugins: {
      enabled: true,
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": {
          enabled: true,
        },
      },
    },
  };
}

function normalizeTimestampMs(value) {
  if (value == null || value === "") return null;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return direct < 1e12 ? Math.floor(direct * 1000) : Math.floor(direct);
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return null;
}

function resolveBotCallbackConfig(cfg, accountId = "default") {
  const normalizedAccountId = readString(accountId).toLowerCase() || "default";
  const channelConfig = cfg?.channels?.wecom;
  const accountConfig = channelConfig?.accounts?.[normalizedAccountId];
  const accountBot = accountConfig?.bot;
  const channelBot = channelConfig?.bot;

  const compatBotId = readString(accountConfig?.botId ?? accountConfig?.botid ?? channelConfig?.botId ?? channelConfig?.botid);
  const compatSecret = readString(accountConfig?.secret ?? channelConfig?.secret);
  const token = readString(
    accountBot?.token ??
      accountBot?.callbackToken ??
      channelBot?.token ??
      channelBot?.callbackToken ??
      channelConfig?.token ??
      channelConfig?.callbackToken,
  );
  const aesKey = readString(
    accountBot?.encodingAesKey ??
      accountBot?.callbackAesKey ??
      channelBot?.encodingAesKey ??
      channelBot?.callbackAesKey ??
      channelConfig?.encodingAesKey ??
      channelConfig?.callbackAesKey,
  );
  const webhookPath = readString(
    accountBot?.webhookPath ?? channelBot?.webhookPath,
  );
  const longConnection =
    accountBot?.longConnection && typeof accountBot.longConnection === "object"
      ? accountBot.longConnection
      : channelBot?.longConnection && typeof channelBot.longConnection === "object"
        ? channelBot.longConnection
        : {};
  const longConnectionBotId = readString(longConnection?.botId ?? longConnection?.botid) || compatBotId;
  const longConnectionSecret = readString(longConnection?.secret ?? accountConfig?.secret ?? channelConfig?.secret);
  const longConnectionEnabled = longConnection?.enabled === true || (Boolean(longConnectionBotId) && Boolean(longConnectionSecret));
  const enabled =
    accountBot?.enabled ??
    channelBot?.enabled ??
    longConnectionEnabled;

  return {
    enabled: enabled === true,
    token,
    aesKey,
    webhookPath,
    longConnectionEnabled,
    longConnectionBotId,
    longConnectionSecret,
  };
}

function hasConfiguredBotCallback(cfg, accountId = "default") {
  const bot = resolveBotCallbackConfig(cfg, accountId);
  return (
    bot.enabled &&
    ((Boolean(bot.token) && Boolean(bot.aesKey)) ||
      (bot.longConnectionEnabled && Boolean(bot.longConnectionBotId) && Boolean(bot.longConnectionSecret)))
  );
}

function hasConfiguredAgentCredentials(account) {
  return Boolean(
    readString(account?.corpId) &&
      readString(account?.corpSecret) &&
      readNumber(account?.agentId),
  );
}

function resolveSetupChannelConfig(cfg) {
  if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
  if (!cfg.channels.wecom || typeof cfg.channels.wecom !== "object") cfg.channels.wecom = {};
  return cfg.channels.wecom;
}

function resolveSetupAccountConfig(cfg, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = resolveSetupChannelConfig(cfg);
  if (normalizedAccountId === "default") return channelConfig;
  if (!channelConfig.accounts || typeof channelConfig.accounts !== "object") {
    channelConfig.accounts = {};
  }
  if (!channelConfig.accounts[normalizedAccountId] || typeof channelConfig.accounts[normalizedAccountId] !== "object") {
    channelConfig.accounts[normalizedAccountId] = {};
  }
  return channelConfig.accounts[normalizedAccountId];
}

function buildScopedEnvReader(accountId = "default", processEnv = process.env) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountPrefix = normalizedAccountId === "default" ? "WECOM_" : `WECOM_${normalizedAccountId.toUpperCase()}_`;
  return function readScopedEnv(suffix) {
    const scopedKey = `${accountPrefix}${suffix}`;
    const scopedValue = processEnv?.[scopedKey];
    if (scopedValue != null && scopedValue !== "") return scopedValue;
    if (normalizedAccountId === "default") return processEnv?.[`WECOM_${suffix}`];
    return processEnv?.[`WECOM_${suffix}`];
  };
}

function readWecomSetupValues(accountId = "default", processEnv = process.env) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const readScopedEnv = buildScopedEnvReader(normalizedAccountId, processEnv);
  const botReadScopedEnv = (suffix) => {
    const scopedKey =
      normalizedAccountId === "default" ? `WECOM_BOT_${suffix}` : `WECOM_${normalizedAccountId.toUpperCase()}_BOT_${suffix}`;
    const scopedValue = processEnv?.[scopedKey];
    if (scopedValue != null && scopedValue !== "") return scopedValue;
    return processEnv?.[`WECOM_BOT_${suffix}`];
  };

  const corpId = readString(readScopedEnv("CORP_ID"));
  const corpSecret = readString(readScopedEnv("CORP_SECRET"));
  const agentId = readNumber(readScopedEnv("AGENT_ID"));
  const callbackToken = readString(readScopedEnv("CALLBACK_TOKEN") ?? readScopedEnv("TOKEN"));
  const callbackAesKey = readString(readScopedEnv("CALLBACK_AES_KEY") ?? readScopedEnv("ENCODING_AES_KEY"));
  const webhookPath = readString(readScopedEnv("WEBHOOK_PATH"));
  const apiBaseUrl = readString(readScopedEnv("API_BASE_URL"));
  const outboundProxy = readString(
    readScopedEnv("EGRESS_PROXY_URL") ??
      readScopedEnv("PROXY") ??
      (normalizedAccountId === "default" ? processEnv?.HTTPS_PROXY : processEnv?.WECOM_PROXY ?? processEnv?.HTTPS_PROXY),
  );

  const botId = readString(botReadScopedEnv("LONG_CONNECTION_BOT_ID"));
  const botSecret = readString(botReadScopedEnv("LONG_CONNECTION_SECRET"));
  const botWebhookToken = readString(botReadScopedEnv("TOKEN"));
  const botEncodingAesKey = readString(botReadScopedEnv("ENCODING_AES_KEY"));
  const botWebhookPath = readString(botReadScopedEnv("WEBHOOK_PATH"));

  return {
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    webhookPath,
    apiBaseUrl,
    outboundProxy,
    botId,
    botSecret,
    botWebhookToken,
    botEncodingAesKey,
    botWebhookPath,
    hasAgent: Boolean(corpId && corpSecret && agentId),
    hasBotLongConnection: Boolean(botId && botSecret),
    hasBotWebhook: Boolean(botWebhookToken && botEncodingAesKey),
  };
}

function readWecomSetupValuesFromInput(input = {}, accountId = "default", processEnv = process.env) {
  const envValues = input?.useEnv === true ? readWecomSetupValues(accountId, processEnv) : {};
  const directValues = {
    corpId: readString(input?.corpId),
    corpSecret: readString(input?.corpSecret),
    agentId: readNumber(input?.agentId),
    callbackToken: readString(input?.callbackToken),
    callbackAesKey: readString(input?.callbackAesKey),
    webhookPath: readString(input?.webhookPath),
    apiBaseUrl: readString(input?.apiBaseUrl),
    outboundProxy: readString(input?.outboundProxy),
    botId: readString(input?.botId),
    botSecret: readString(input?.botSecret),
    botWebhookToken: readString(input?.botWebhookToken),
    botEncodingAesKey: readString(input?.botEncodingAesKey),
    botWebhookPath: readString(input?.botWebhookPath),
  };
  const merged = {
    ...envValues,
    ...Object.fromEntries(Object.entries(directValues).filter(([, value]) => value !== "" && value !== null)),
  };
  merged.hasAgent = Boolean(merged.corpId && merged.corpSecret && merged.agentId);
  merged.hasBotLongConnection = Boolean(merged.botId && merged.botSecret);
  merged.hasBotWebhook = Boolean(merged.botWebhookToken && merged.botEncodingAesKey);
  return merged;
}

function hasConfiguredWecomAccount(cfg = {}, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(cfg?.channels?.wecom);
  const accountConfig =
    normalizedAccountId === "default"
      ? mergeDeep(channelConfig, asObject(channelConfig?.accounts?.default))
      : asObject(channelConfig?.accounts?.[normalizedAccountId]);
  const agentConfigured = hasConfiguredAgentCredentials(accountConfig);
  const botConfigured = hasConfiguredBotCallback(cfg, normalizedAccountId);
  return agentConfigured || botConfigured;
}

function applyWecomSetupValues(cfg = {}, accountId = "default", values = {}) {
  const nextConfig = mergeDeep(cfg, buildPluginEnablePatch());
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = resolveSetupChannelConfig(nextConfig);
  const targetAccountConfig = resolveSetupAccountConfig(nextConfig, normalizedAccountId);

  if (!channelConfig.defaultAccount && normalizedAccountId) {
    channelConfig.defaultAccount = normalizedAccountId;
  }

  if (values.corpId) targetAccountConfig.corpId = values.corpId;
  if (values.corpSecret) targetAccountConfig.corpSecret = values.corpSecret;
  if (values.agentId != null) targetAccountConfig.agentId = values.agentId;
  if (values.callbackToken) targetAccountConfig.callbackToken = values.callbackToken;
  if (values.callbackAesKey) targetAccountConfig.callbackAesKey = values.callbackAesKey;
  if (values.webhookPath) targetAccountConfig.webhookPath = values.webhookPath;
  if (values.apiBaseUrl) targetAccountConfig.apiBaseUrl = values.apiBaseUrl;
  if (values.outboundProxy) targetAccountConfig.outboundProxy = values.outboundProxy;

  if (values.botId || values.botSecret) {
    targetAccountConfig.bot = asObject(targetAccountConfig.bot);
    targetAccountConfig.bot.enabled = true;
    targetAccountConfig.bot.longConnection = asObject(targetAccountConfig.bot.longConnection);
    targetAccountConfig.bot.longConnection.enabled = true;
    if (values.botId) targetAccountConfig.bot.longConnection.botId = values.botId;
    if (values.botSecret) targetAccountConfig.bot.longConnection.secret = values.botSecret;
  }

  if (values.botWebhookToken || values.botEncodingAesKey || values.botWebhookPath) {
    targetAccountConfig.bot = asObject(targetAccountConfig.bot);
    targetAccountConfig.bot.enabled = true;
    if (values.botWebhookToken) targetAccountConfig.bot.token = values.botWebhookToken;
    if (values.botEncodingAesKey) targetAccountConfig.bot.encodingAesKey = values.botEncodingAesKey;
    if (values.botWebhookPath) targetAccountConfig.bot.webhookPath = values.botWebhookPath;
  }

  channelConfig.defaultAccount = channelConfig.defaultAccount || normalizedAccountId;
  channelConfig.defaultAccount = normalizeAccountId(channelConfig.defaultAccount);
  channelConfig.enabled = channelConfig.enabled !== false;
  nextConfig.plugins.allow = ensureArrayIncludes(nextConfig.plugins?.allow, "openclaw-wechat");

  return nextConfig;
}

function applyWecomSetupAccountName(cfg = {}, accountId = "default", name = "") {
  const trimmedName = readString(name);
  if (!trimmedName) return cfg;
  const nextConfig = mergeDeep(cfg, buildPluginEnablePatch());
  const targetAccountConfig = resolveSetupAccountConfig(nextConfig, accountId);
  targetAccountConfig.name = trimmedName;
  return nextConfig;
}

function validateWecomSetupInput({ cfg = {}, accountId = "default", input = {}, processEnv = process.env } = {}) {
  if (hasConfiguredWecomAccount(cfg, accountId)) return "";
  const values = readWecomSetupValuesFromInput(input, accountId, processEnv);
  if (values.hasAgent || values.hasBotLongConnection || values.hasBotWebhook) return "";
  if (input?.useEnv !== true) {
    return [
      "WeCom channels add 需要显式传入 WeCom 专有参数，或者使用 env-backed 初始化。",
      "可以直接传 `--corp-id/--corp-secret/--agent-id` 或 `--bot-id/--bot-secret`，",
      "也可以先设置 WECOM_* / WECOM_BOT_* 环境变量后，再执行 `openclaw channels add --channel wecom --use-env`，",
      `或者直接用 \`${WECOM_INSTALLER_COMMAND}\`。`,
    ].join("");
  }
  return [
    "未检测到可用的 WeCom 环境变量。",
    "至少需要一组 Agent 凭据（WECOM_CORP_ID / WECOM_CORP_SECRET / WECOM_AGENT_ID）",
    "或一组 Bot 长连接凭据（WECOM_BOT_LONG_CONNECTION_BOT_ID / WECOM_BOT_LONG_CONNECTION_SECRET），",
    `也可以改用 \`${WECOM_INSTALLER_COMMAND}\`。`,
  ].join("");
}

function buildWecomAccountSnapshot(account, cfg, runtime = {}) {
  const accountId = readString(account?.accountId).toLowerCase() || "default";
  const agentConfigured = hasConfiguredAgentCredentials(account);
  const botConfig = resolveBotCallbackConfig(cfg, accountId);
  const botConfigured = hasConfiguredBotCallback(cfg, accountId);
  const configured = agentConfigured || botConfigured;
  const enabled = account?.enabled !== false;
  const inboundActivity = getWecomInboundActivity(accountId);
  const mode = agentConfigured && botConfigured ? "agent+bot" : botConfigured ? "bot" : "agent";
  const running = runtime?.running ?? (enabled && configured);
  const connected =
    runtime?.connected ??
    inboundActivity?.connected ??
    (running && configured);
  const lastInboundAt =
    normalizeTimestampMs(runtime?.lastInboundAt ?? runtime?.lastInbound) ??
    normalizeTimestampMs(inboundActivity?.lastInboundAtMs ?? inboundActivity?.lastInbound) ??
    null;
  const localizedName = accountId === "default" ? "默认账号" : accountId;
  return {
    ...runtime,
    accountId,
    name: readString(account?.name) || localizedName,
    displayName: readString(account?.name) || localizedName,
    enabled,
    configured,
    running,
    connected,
    lastInboundAt,
    mode,
    webhookPath: readString(account?.webhookPath) || botConfig.webhookPath || runtime?.webhookPath || undefined,
  };
}

export function createWecomChannelPlugin({
  listWecomAccountIds,
  getWecomConfig,
  getGatewayRuntime,
  normalizeWecomResolvedTarget,
  formatWecomTargetForLog,
  sendWecomWebhookText,
  sendWecomWebhookMediaBatch,
  sendWecomOutboundMediaBatch,
  sendWecomText,
  processEnv = process.env,
} = {}) {
  assertFunction("listWecomAccountIds", listWecomAccountIds);
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("getGatewayRuntime", getGatewayRuntime);
  assertFunction("normalizeWecomResolvedTarget", normalizeWecomResolvedTarget);
  assertFunction("formatWecomTargetForLog", formatWecomTargetForLog);
  assertFunction("sendWecomWebhookText", sendWecomWebhookText);
  assertFunction("sendWecomWebhookMediaBatch", sendWecomWebhookMediaBatch);
  assertFunction("sendWecomOutboundMediaBatch", sendWecomOutboundMediaBatch);
  assertFunction("sendWecomText", sendWecomText);

  return {
    id: "wecom",
    meta: {
      id: "wecom",
      label: "企业微信 WeCom",
      selectionLabel: "企业微信 WeCom（自建应用/Bot）",
      detailLabel: "企业微信自建应用 / Bot",
      docsPath: "/channels/wecom",
      blurb: "企业微信消息通道（自建应用回调 + Bot 回调 + 发送 API）。",
      aliases: ["wework", "qiwei", "wxwork"],
      systemImage: "building.2.crop.circle",
      quickstartAllowFrom: true,
      quickstart: {
        recommendedMode: WECOM_QUICKSTART_RECOMMENDED_MODE,
        modes: listWecomQuickstartModes(),
        groupProfiles: listWecomQuickstartGroupProfiles(),
        defaultGroupProfile: WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
        supportsSetupPlan: true,
        supportsWizard: true,
        supportsRunChecks: true,
        supportsActions: true,
        supportsMigration: true,
        supportsRepairPlan: true,
        supportsConfirmRepair: true,
        supportsDoctor: true,
        supportsExternalInstaller: true,
        installerSpec: WECOM_INSTALLER_NPM_SPEC,
        installerCommand: WECOM_INSTALLER_COMMAND,
        applyRepairCommand: WECOM_QUICKSTART_APPLY_REPAIR_COMMAND,
        confirmRepairCommand: WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND,
        doctorCommand: WECOM_DOCTOR_COMMAND,
        migrationCommand: WECOM_QUICKSTART_MIGRATION_COMMAND,
        runChecksCommand: WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
        forceChecksCommand: WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
        setupCommand: WECOM_QUICKSTART_SETUP_COMMAND,
        wizardCommand: WECOM_QUICKSTART_WIZARD_COMMAND,
        writeCommand: WECOM_QUICKSTART_WRITE_COMMAND,
      },
    },
    quickstart: {
      recommendedMode: WECOM_QUICKSTART_RECOMMENDED_MODE,
      defaultGroupProfile: WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
      supportsSetupPlan: true,
      supportsWizard: true,
      supportsRunChecks: true,
      supportsActions: true,
      supportsMigration: true,
      supportsRepairPlan: true,
      supportsConfirmRepair: true,
      supportsDoctor: true,
      supportsExternalInstaller: true,
      installerSpec: WECOM_INSTALLER_NPM_SPEC,
      installerCommand: WECOM_INSTALLER_COMMAND,
      applyRepairCommand: WECOM_QUICKSTART_APPLY_REPAIR_COMMAND,
      confirmRepairCommand: WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND,
      doctorCommand: WECOM_DOCTOR_COMMAND,
      migrationCommand: WECOM_QUICKSTART_MIGRATION_COMMAND,
      runChecksCommand: WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
      forceChecksCommand: WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
      setupCommand: WECOM_QUICKSTART_SETUP_COMMAND,
      wizardCommand: WECOM_QUICKSTART_WIZARD_COMMAND,
      writeCommand: WECOM_QUICKSTART_WRITE_COMMAND,
      listModes: () => listWecomQuickstartModes(),
      listGroupProfiles: () => listWecomQuickstartGroupProfiles(),
      buildSetupPlan: ({
        mode,
        accountId = "default",
        dmMode = "pairing",
        groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
        groupChatId = "",
        groupAllow = [],
        currentConfig = {},
      } = {}) =>
        buildWecomQuickstartSetupPlan({ mode, accountId, dmMode, groupProfile, groupChatId, groupAllow, currentConfig }),
      buildStarterConfig: ({
        mode,
        accountId = "default",
        dmMode = "pairing",
        groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
        groupChatId = "",
        groupAllow = [],
      } = {}) =>
        buildWecomQuickstartConfig({ mode, accountId, dmMode, groupProfile, groupChatId, groupAllow }),
    },
    pairing: {
      idLabel: "wecomUserId",
      normalizeAllowEntry: (entry) => normalizeWecomAllowFromEntry(entry),
      notifyApproval: async ({ cfg, id }) => {
        const normalizedUserId = normalizeWecomAllowFromEntry(id);
        if (!normalizedUserId) return;
        const config = getWecomConfig({ config: cfg }, "default");
        if (!config?.corpId || !config?.corpSecret || !config?.agentId) return;
        await sendWecomText({
          corpId: config.corpId,
          corpSecret: config.corpSecret,
          agentId: config.agentId,
          toUser: normalizedUserId,
          text: "OpenClaw: your access has been approved.",
          proxyUrl: config.outboundProxy,
          apiBaseUrl: config.apiBaseUrl,
        });
      },
    },
    configSchema: {
      schema: wecomChannelConfigSchema,
      uiHints: wecomChannelConfigUiHints,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: {
        inbound: true,
        outbound: true,
      },
      markdown: true,
    },
    config: {
      listAccountIds: (cfg) => {
        const accountIds = listWecomAccountIds({ config: cfg });
        if (accountIds.length > 0) return accountIds;
        return hasConfiguredBotCallback(cfg, "default") ? ["default"] : [];
      },
      resolveAccount: (cfg, accountId) =>
        (getWecomConfig({ config: cfg }, accountId ?? "default") ?? {
          accountId: accountId ?? "default",
        }),
      isConfigured: (account, cfg) =>
        hasConfiguredAgentCredentials(account) || hasConfiguredBotCallback(cfg, account?.accountId ?? "default"),
      describeAccount: (account, cfg) => buildWecomAccountSnapshot(account, cfg),
    },
    setup: {
      resolveAccountId: ({ accountId } = {}) => normalizeAccountId(accountId),
      validateInput: ({ cfg, accountId, input } = {}) =>
        validateWecomSetupInput({ cfg, accountId, input, processEnv }) || undefined,
      applyAccountName: ({ cfg, accountId, name } = {}) =>
        applyWecomSetupAccountName(cfg, accountId, name),
      applyAccountConfig: ({ cfg, accountId, input } = {}) => {
        const values = readWecomSetupValuesFromInput(input, accountId, processEnv);
        return applyWecomSetupValues(cfg, accountId, values);
      },
    },
    status: {
      buildAccountSnapshot: ({ account, cfg, runtime }) =>
        buildWecomAccountSnapshot(account, cfg, runtime),
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot?.configured ?? false,
        running: snapshot?.running ?? false,
        connected:
          snapshot?.connected ??
          (snapshot?.running && snapshot?.configured) ??
          null,
        lastInbound:
          normalizeTimestampMs(snapshot?.lastInboundAt ?? snapshot?.lastInbound) ??
          normalizeTimestampMs(
            getWecomChannelInboundActivity([snapshot?.accountId]).lastInboundAtMs,
          ) ??
          null,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) => {
        const target = normalizeWecomResolvedTarget(to);
        if (!target) return { ok: false, error: new Error("WeCom requires --to <target>") };
        return { ok: true, to: target };
      },
      sendText: async ({ to, text, accountId }) => {
        const runtime = getGatewayRuntime();
        const target = normalizeWecomResolvedTarget(to);
        if (!target) {
          return { ok: false, error: new Error("WeCom target invalid") };
        }
        const config = getWecomConfig({ config: runtime?.config }, accountId);
        if (target.webhook) {
          await sendWecomWebhookText({
            webhook: target.webhook,
            webhookTargets: config?.webhooks,
            text,
            logger: runtime?.logger,
            proxyUrl: config?.outboundProxy,
          });
          runtime?.logger?.info?.(`wecom: outbound sendText target=${formatWecomTargetForLog(target)}`);
          return { ok: true, provider: "wecom-webhook" };
        }
        if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
          return { ok: false, error: new Error("WeCom not configured (check channels.wecom in openclaw.json)") };
        }
        await sendWecomText({
          corpId: config.corpId,
          corpSecret: config.corpSecret,
          agentId: config.agentId,
          toUser: target.toUser,
          toParty: target.toParty,
          toTag: target.toTag,
          chatId: target.chatId,
          text,
          logger: runtime?.logger,
          proxyUrl: config.outboundProxy,
          apiBaseUrl: config.apiBaseUrl,
        });
        runtime?.logger?.info?.(`wecom: outbound sendText target=${formatWecomTargetForLog(target)}`);
        return { ok: true, provider: "wecom" };
      },
    },
    inbound: {
      deliverReply: async ({ to, text, accountId, mediaUrl, mediaUrls, mediaType }) => {
        const runtime = getGatewayRuntime();
        const target = normalizeWecomResolvedTarget(to);
        if (!target) {
          throw new Error("WeCom deliverReply target invalid");
        }
        const config = getWecomConfig({ config: runtime?.config }, accountId);
        const proxyUrl = config?.outboundProxy;
        if (target.webhook) {
          const webhookMediaResult = await sendWecomWebhookMediaBatch({
            webhook: target.webhook,
            webhookTargets: config?.webhooks,
            mediaUrl,
            mediaUrls,
            mediaType,
            logger: runtime?.logger,
            proxyUrl,
          });
          if (webhookMediaResult.failed.length > 0) {
            runtime?.logger?.warn?.(
              `wecom: webhook target failed to send ${webhookMediaResult.failed.length} media item(s)`,
            );
          }
          if (text) {
            await sendWecomWebhookText({
              webhook: target.webhook,
              webhookTargets: config?.webhooks,
              text,
              logger: runtime?.logger,
              proxyUrl,
            });
          }
          if (!text && webhookMediaResult.total > 0 && webhookMediaResult.sentCount === 0) {
            throw new Error("WeCom webhook media send failed");
          }
          return { ok: true };
        }
        if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
          throw new Error("WeCom not configured (check channels.wecom in openclaw.json)");
        }
        const mediaResult = await sendWecomOutboundMediaBatch({
          corpId: config.corpId,
          corpSecret: config.corpSecret,
          agentId: config.agentId,
          toUser: target.toUser,
          toParty: target.toParty,
          toTag: target.toTag,
          chatId: target.chatId,
          mediaUrl,
          mediaUrls,
          mediaType,
          logger: runtime?.logger,
          proxyUrl,
          apiBaseUrl: config?.apiBaseUrl,
        });
        if (mediaResult.failed.length > 0) {
          runtime?.logger?.warn?.(`wecom: failed to send ${mediaResult.failed.length} outbound media item(s)`);
        }
        if (text) {
          await sendWecomText({
            corpId: config.corpId,
            corpSecret: config.corpSecret,
            agentId: config.agentId,
            toUser: target.toUser,
            toParty: target.toParty,
            toTag: target.toTag,
            chatId: target.chatId,
            text,
            logger: runtime?.logger,
            proxyUrl,
            apiBaseUrl: config.apiBaseUrl,
          });
        }
        return { ok: true };
      },
    },
  };
}
