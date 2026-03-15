import { normalizeWecomWebhookTargetMap } from "../core.js";
import { normalizeAccountConfig, normalizeAccountId } from "./account-config-core.js";
import { listLegacyInlineAccountEntries } from "./account-config.js";
import { PLUGIN_VERSION } from "./plugin-constants.js";

export const WECOM_INSTALL_STATES = Object.freeze([
  "fresh",
  "legacy_config",
  "stale_package",
  "mixed_layout",
  "ready",
]);

export const WECOM_MIGRATION_STATES = Object.freeze([
  "fresh",
  "legacy_config",
  "stale_package",
  "mixed_layout",
  "ready",
]);

export const WECOM_MIGRATION_SOURCES = Object.freeze([
  "fresh",
  "native-openclaw-wechat",
  "official-wecom",
  "sunnoy-wecom",
  "legacy-openclaw-wechat",
  "mixed-source",
  "unknown",
]);

export const WECOM_MIGRATION_COMMAND = "npm run wecom:migrate -- --json";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
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

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function parseSemverLike(version) {
  const normalized = String(version ?? "").trim();
  if (!normalized) return null;
  const matched = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!matched) return null;
  return matched.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareSemverLike(left, right) {
  const a = parseSemverLike(left);
  const b = parseSemverLike(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] === b[index]) continue;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function addLegacyField(out, { id, kind, path, title, detail, accountId = "default" }) {
  out.push({
    id,
    kind,
    path,
    title,
    detail,
    accountId: normalizeAccountId(accountId),
  });
}

function collectLegacyFieldsForAccount(rawConfig, { accountId = "default", pathPrefix = "channels.wecom" } = {}) {
  const source = asObject(rawConfig);
  const legacyFields = [];
  const legacyAgent = asObject(source.agent);
  const botConfig = asObject(source.bot);
  const longConnectionConfig = asObject(botConfig.longConnection);
  const networkConfig = asObject(source.network);

  if (Object.keys(legacyAgent).length > 0) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-agent-block`,
      kind: "legacy_agent_block",
      path: `${pathPrefix}.agent`,
      title: "legacy agent block",
      detail: "仍在使用 agent.* 兼容写法，建议迁移到账户根字段。",
      accountId,
    });
  }

  if (
    (hasOwn(source, "botId") || hasOwn(source, "botid")) &&
    !pickFirstNonEmptyString(longConnectionConfig.botId, longConnectionConfig.botid)
  ) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-flat-bot-id`,
      kind: "legacy_flat_bot_id",
      path: `${pathPrefix}.botId`,
      title: "legacy flat botId",
      detail: "仍在使用顶层 botId 兼容字段，建议迁移到 bot.longConnection.botId。",
      accountId,
    });
  }

  if (hasOwn(source, "secret") && !pickFirstNonEmptyString(longConnectionConfig.secret)) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-flat-secret`,
      kind: "legacy_flat_secret",
      path: `${pathPrefix}.secret`,
      title: "legacy flat secret",
      detail: "仍在使用顶层 secret 兼容字段，建议迁移到 bot.longConnection.secret。",
      accountId,
    });
  }

  if (
    (hasOwn(networkConfig, "egressProxyUrl") || hasOwn(networkConfig, "proxyUrl") || hasOwn(networkConfig, "proxy")) &&
    !pickFirstNonEmptyString(source.outboundProxy, source.proxyUrl, source.proxy)
  ) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-network-egress-proxy`,
      kind: "legacy_network_egress_proxy",
      path: `${pathPrefix}.network.egressProxyUrl`,
      title: "legacy network.egressProxyUrl",
      detail: "仍在使用 network.egressProxyUrl / proxyUrl 兼容字段，建议迁移到 outboundProxy。",
      accountId,
    });
  }

  if (hasOwn(networkConfig, "apiBaseUrl") && !hasOwn(source, "apiBaseUrl")) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-network-api-base`,
      kind: "legacy_network_api_base_url",
      path: `${pathPrefix}.network.apiBaseUrl`,
      title: "legacy network.apiBaseUrl",
      detail: "仍在使用 network.apiBaseUrl 兼容字段，建议迁移到 apiBaseUrl。",
      accountId,
    });
  }

  if (hasOwn(source, "dynamicAgents")) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-dynamicAgents`,
      kind: "legacy_dynamic_agents",
      path: `${pathPrefix}.dynamicAgents`,
      title: "legacy dynamicAgents",
      detail: "仍在使用 dynamicAgents 兼容字段，建议迁移到 dynamicAgent。",
      accountId,
    });
  }

  if (source?.dm && typeof source.dm === "object" && hasOwn(source.dm, "allowFrom")) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-dm-allowFrom`,
      kind: "legacy_dm_allow_from",
      path: `${pathPrefix}.dm.allowFrom`,
      title: "legacy dm.allowFrom",
      detail: "仍在使用 dm.allowFrom 兼容字段，建议迁移到账户根 allowFrom。",
      accountId,
    });
  }

  if (hasOwn(source, "token") && !hasOwn(botConfig, "token") && !hasOwn(botConfig, "callbackToken")) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-bot-token`,
      kind: "legacy_bot_token",
      path: `${pathPrefix}.token`,
      title: "legacy top-level bot token",
      detail: "仍在使用顶层 token 兼容字段，建议迁移到 bot.token。",
      accountId,
    });
  }

  if (
    hasOwn(source, "encodingAesKey") &&
    !hasOwn(botConfig, "encodingAesKey") &&
    !hasOwn(botConfig, "callbackAesKey")
  ) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-bot-aes`,
      kind: "legacy_bot_aes",
      path: `${pathPrefix}.encodingAesKey`,
      title: "legacy top-level bot aes key",
      detail: "仍在使用顶层 encodingAesKey 兼容字段，建议迁移到 bot.encodingAesKey。",
      accountId,
    });
  }

  if (
    hasOwn(source, "rejectUnauthorizedMessage") &&
    !hasOwn(source, "allowFromRejectMessage")
  ) {
    addLegacyField(legacyFields, {
      id: `${normalizeAccountId(accountId)}:legacy-rejectUnauthorizedMessage`,
      kind: "legacy_reject_message",
      path: `${pathPrefix}.rejectUnauthorizedMessage`,
      title: "legacy rejectUnauthorizedMessage",
      detail: "仍在使用 rejectUnauthorizedMessage 兼容字段，建议迁移到 allowFromRejectMessage。",
      accountId,
    });
  }

  return legacyFields;
}

function copyIfPresent(target, source, key) {
  if (!hasOwn(source, key)) return;
  const value = source[key];
  if (value === undefined) return;
  target[key] = deepClone(value);
}

function buildBotMigrationPatch(rawConfig) {
  const source = asObject(rawConfig);
  const legacyAgent = asObject(source.agent);
  const botPatch = deepClone(asObject(source.bot));
  const legacyToken = pickFirstNonEmptyString(source.token);
  const legacyAesKey = pickFirstNonEmptyString(source.encodingAesKey);
  const compatBotId = pickFirstNonEmptyString(source.botId, source.botid);
  const compatSecret = pickFirstNonEmptyString(source.secret);
  const shouldUseRootWebhookPath =
    Boolean(source.webhookPath) &&
    (!hasOwn(botPatch, "webhookPath") ||
      String(botPatch.webhookPath ?? "").trim() === "") &&
    (legacyToken || legacyAesKey || Object.keys(legacyAgent).length > 0 || Object.keys(botPatch).length > 0);

  if (legacyToken && !pickFirstNonEmptyString(botPatch.token, botPatch.callbackToken)) {
    botPatch.token = legacyToken;
  }
  if (legacyAesKey && !pickFirstNonEmptyString(botPatch.encodingAesKey, botPatch.callbackAesKey)) {
    botPatch.encodingAesKey = legacyAesKey;
  }
  if (shouldUseRootWebhookPath) {
    botPatch.webhookPath = String(source.webhookPath ?? "").trim();
  }
  if (compatBotId || compatSecret) {
    const longConnectionPatch = deepClone(asObject(botPatch.longConnection));
    if (compatBotId && !pickFirstNonEmptyString(longConnectionPatch.botId, longConnectionPatch.botid)) {
      longConnectionPatch.botId = compatBotId;
    }
    if (compatSecret && !pickFirstNonEmptyString(longConnectionPatch.secret)) {
      longConnectionPatch.secret = compatSecret;
    }
    if ((compatBotId || compatSecret) && !hasOwn(longConnectionPatch, "enabled")) {
      longConnectionPatch.enabled = true;
    }
    if (Object.keys(longConnectionPatch).length > 0) {
      botPatch.longConnection = longConnectionPatch;
    }
  }
  return Object.keys(botPatch).length > 0 ? botPatch : null;
}

function buildAccountMigrationPatch(rawConfig, accountId = "default") {
  const source = asObject(rawConfig);
  if (Object.keys(source).length === 0) return null;

  const patch = {};
  const legacyAgent = asObject(source.agent);
  const normalizedAgent = normalizeAccountConfig({
    raw: source,
    accountId,
    normalizeWecomWebhookTargetMap,
  });

  const passthroughKeys = [
    "name",
    "enabled",
    "apiBaseUrl",
    "outboundProxy",
    "webhooks",
    "allowFrom",
    "allowFromRejectMessage",
    "groupPolicy",
    "groupAllowFrom",
    "groupAllowFromRejectMessage",
    "adminUsers",
    "commandAllowlist",
    "commandBlockMessage",
    "commands",
    "workspaceTemplate",
    "groupChat",
    "groups",
    "dynamicAgent",
    "dm",
    "debounce",
    "streaming",
    "delivery",
    "webhookBot",
    "stream",
    "observability",
    "voiceTranscription",
    "tools",
  ];

  for (const key of passthroughKeys) {
    copyIfPresent(patch, source, key);
  }

  if (!hasOwn(patch, "dynamicAgent") && hasOwn(source, "dynamicAgents")) {
    patch.dynamicAgent = deepClone(source.dynamicAgents);
  }
  if (!hasOwn(patch, "allowFrom") && source?.dm && hasOwn(source.dm, "allowFrom")) {
    patch.allowFrom = deepClone(source.dm.allowFrom);
  }
  if (!hasOwn(patch, "allowFromRejectMessage") && hasOwn(source, "rejectUnauthorizedMessage")) {
    patch.allowFromRejectMessage = deepClone(source.rejectUnauthorizedMessage);
  }
  if (!hasOwn(patch, "outboundProxy")) {
    const compatProxy = pickFirstNonEmptyString(
      source?.network?.egressProxyUrl,
      source?.network?.proxyUrl,
      source?.network?.proxy,
    );
    if (compatProxy) patch.outboundProxy = compatProxy;
  }
  if (!hasOwn(patch, "apiBaseUrl")) {
    const compatApiBaseUrl = pickFirstNonEmptyString(source?.network?.apiBaseUrl);
    if (compatApiBaseUrl) patch.apiBaseUrl = compatApiBaseUrl;
  }

  if (normalizedAgent) {
    patch.corpId = normalizedAgent.corpId;
    patch.corpSecret = normalizedAgent.corpSecret;
    patch.agentId = normalizedAgent.agentId;
    if (normalizedAgent.callbackToken) patch.callbackToken = normalizedAgent.callbackToken;
    if (normalizedAgent.callbackAesKey) patch.callbackAesKey = normalizedAgent.callbackAesKey;
    if (normalizedAgent.webhookPath) patch.webhookPath = normalizedAgent.webhookPath;
  } else {
    const corpId = pickFirstNonEmptyString(source.corpId, legacyAgent.corpId);
    const corpSecret = pickFirstNonEmptyString(source.corpSecret, legacyAgent.corpSecret);
    const callbackToken = pickFirstNonEmptyString(
      source.callbackToken,
      legacyAgent.callbackToken,
      legacyAgent.token,
    );
    const callbackAesKey = pickFirstNonEmptyString(
      source.callbackAesKey,
      legacyAgent.callbackAesKey,
      legacyAgent.encodingAesKey,
    );
    if (corpId) patch.corpId = corpId;
    if (corpSecret) patch.corpSecret = corpSecret;
    if (Number.isFinite(Number(source.agentId ?? legacyAgent.agentId))) {
      patch.agentId = Number(source.agentId ?? legacyAgent.agentId);
    }
    if (callbackToken) patch.callbackToken = callbackToken;
    if (callbackAesKey) patch.callbackAesKey = callbackAesKey;
    if (legacyAgent.webhookPath) {
      patch.webhookPath = String(legacyAgent.webhookPath).trim();
    } else if (Object.keys(legacyAgent).length === 0 && source.webhookPath) {
      patch.webhookPath = String(source.webhookPath).trim();
    }
  }

  const botPatch = buildBotMigrationPatch(source);
  if (botPatch) {
    patch.bot = botPatch;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function collectModernAccountIds(channelConfig) {
  const modernAccounts = asObject(channelConfig?.accounts);
  return Object.keys(modernAccounts).map((key) => normalizeAccountId(key));
}

function buildMigrationConfigPatch(config) {
  const channelConfig = asObject(config?.channels?.wecom);
  const modernAccounts = asObject(channelConfig.accounts);
  const accountPatches = {};

  const defaultLegacyFields = collectLegacyFieldsForAccount(channelConfig, {
    accountId: "default",
    pathPrefix: "channels.wecom",
  });
  if (defaultLegacyFields.length > 0) {
    const patch = buildAccountMigrationPatch(channelConfig, "default");
    if (patch) accountPatches.default = mergeDeep(asObject(modernAccounts.default), patch);
  }

  for (const [accountId, accountConfig] of Object.entries(modernAccounts)) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const legacyFields = collectLegacyFieldsForAccount(accountConfig, {
      accountId: normalizedAccountId,
      pathPrefix: `channels.wecom.accounts.${normalizedAccountId}`,
    });
    if (legacyFields.length === 0) continue;
    const patch = buildAccountMigrationPatch(accountConfig, normalizedAccountId);
    if (patch) {
      accountPatches[normalizedAccountId] = mergeDeep(asObject(modernAccounts[normalizedAccountId]), patch);
    }
  }

  for (const [accountId, accountConfig] of listLegacyInlineAccountEntries(channelConfig)) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const patch = buildAccountMigrationPatch(accountConfig, normalizedAccountId);
    if (patch) {
      accountPatches[normalizedAccountId] = mergeDeep(asObject(modernAccounts[normalizedAccountId]), patch);
    }
  }

  if (Object.keys(accountPatches).length === 0) return null;

  const channelPatch = {
    accounts: accountPatches,
  };
  const defaultAccount = pickFirstNonEmptyString(channelConfig.defaultAccount);
  if (defaultAccount) {
    channelPatch.defaultAccount = normalizeAccountId(defaultAccount);
  } else if (accountPatches.default) {
    channelPatch.defaultAccount = "default";
  }

  return {
    channels: {
      wecom: channelPatch,
    },
  };
}

function buildAccountEnvTemplate(accountId, accountConfig = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const prefix = normalizedAccountId === "default" ? "WECOM" : `WECOM_${normalizedAccountId.toUpperCase()}`;
  const lines = [];
  if (accountConfig.corpId || accountConfig.corpSecret || accountConfig.agentId || accountConfig.callbackToken) {
    lines.push(`${prefix}_ENABLED=${accountConfig.enabled === false ? "false" : "true"}`);
    if (accountConfig.corpId) lines.push(`${prefix}_CORP_ID=${String(accountConfig.corpId)}`);
    if (accountConfig.corpSecret) lines.push(`${prefix}_CORP_SECRET=${String(accountConfig.corpSecret)}`);
    if (accountConfig.agentId != null) lines.push(`${prefix}_AGENT_ID=${String(accountConfig.agentId)}`);
    if (accountConfig.callbackToken) lines.push(`${prefix}_CALLBACK_TOKEN=${String(accountConfig.callbackToken)}`);
    if (accountConfig.callbackAesKey) lines.push(`${prefix}_CALLBACK_AES_KEY=${String(accountConfig.callbackAesKey)}`);
    if (accountConfig.webhookPath) lines.push(`${prefix}_WEBHOOK_PATH=${String(accountConfig.webhookPath)}`);
  }
  if (accountConfig.outboundProxy) lines.push(`${prefix}_EGRESS_PROXY_URL=${String(accountConfig.outboundProxy)}`);
  if (accountConfig.apiBaseUrl) lines.push(`${prefix}_API_BASE_URL=${String(accountConfig.apiBaseUrl)}`);

  const botConfig = asObject(accountConfig.bot);
  if (Object.keys(botConfig).length > 0) {
    const botPrefix = normalizedAccountId === "default" ? "WECOM_BOT" : `WECOM_${normalizedAccountId.toUpperCase()}_BOT`;
    lines.push(`${botPrefix}_ENABLED=${botConfig.enabled === false ? "false" : "true"}`);
    if (botConfig.token) lines.push(`${botPrefix}_TOKEN=${String(botConfig.token)}`);
    if (botConfig.encodingAesKey) lines.push(`${botPrefix}_ENCODING_AES_KEY=${String(botConfig.encodingAesKey)}`);
    if (botConfig.webhookPath) lines.push(`${botPrefix}_WEBHOOK_PATH=${String(botConfig.webhookPath)}`);
    const longConnection = asObject(botConfig.longConnection);
    if (Object.keys(longConnection).length > 0) {
      if (longConnection.botId) lines.push(`${botPrefix}_LONG_CONNECTION_BOT_ID=${String(longConnection.botId)}`);
      if (longConnection.secret) lines.push(`${botPrefix}_LONG_CONNECTION_SECRET=${String(longConnection.secret)}`);
      if (longConnection.url) lines.push(`${botPrefix}_LONG_CONNECTION_URL=${String(longConnection.url)}`);
      if (hasOwn(longConnection, "enabled")) {
        lines.push(`${botPrefix}_LONG_CONNECTION_ENABLED=${longConnection.enabled === false ? "false" : "true"}`);
      }
    }
  }

  return lines;
}

function buildMigrationEnvTemplate(configPatch) {
  const accountEntries = asObject(configPatch?.channels?.wecom?.accounts);
  const lines = [];
  for (const [accountId, accountConfig] of Object.entries(accountEntries)) {
    lines.push(...buildAccountEnvTemplate(accountId, accountConfig));
  }
  return {
    format: "dotenv",
    lines: Array.from(new Set(lines)),
  };
}

function summarizeInstallState(installState) {
  switch (installState) {
    case "fresh":
      return "尚未检测到 WeCom 安装或配置。";
    case "stale_package":
      return "检测到旧版 npm 安装元数据，建议先升级插件包。";
    case "mixed_layout":
      return "检测到新旧布局混用，建议先统一迁移。";
    case "legacy_config":
      return "检测到 legacy 兼容字段，建议生成迁移 patch。";
    default:
      return "安装元数据和配置布局看起来已就绪。";
  }
}

function summarizeMigrationState(migrationState) {
  switch (migrationState) {
    case "fresh":
      return "当前配置还没有进入迁移阶段。";
    case "stale_package":
      return "建议先升级插件版本，再继续迁移配置。";
    case "mixed_layout":
      return "建议先统一账户布局，再清理 legacy 字段。";
    case "legacy_config":
      return "建议运行迁移命令生成现代化 patch。";
    default:
      return "没有发现必须处理的 legacy 迁移项。";
  }
}

function summarizeMigrationSource(source) {
  switch (source) {
    case "fresh":
      return "当前还没有可识别的 WeCom 配置来源。";
    case "native-openclaw-wechat":
      return "当前配置已经是 OpenClaw-Wechat 原生 accounts 布局。";
    case "official-wecom":
      return "检测到更接近官方 WeCom 插件的扁平配置写法。";
    case "sunnoy-wecom":
      return "检测到更接近 sunnoy/openclaw-plugin-wecom 的兼容网络配置写法。";
    case "legacy-openclaw-wechat":
      return "检测到历史 OpenClaw-Wechat legacy 布局。";
    case "mixed-source":
      return "检测到多种来源的兼容字段混用，建议先审阅 patch 再迁移。";
    default:
      return "来源无法可靠判断，建议先审阅迁移 patch。";
  }
}

function buildMigrationSourceDiagnostics({ hasWecomConfig = false, detectedLegacyFields = [] } = {}) {
  const sourceSignals = [];
  const officialKinds = new Set(["legacy_flat_bot_id", "legacy_flat_secret"]);
  const sunnoyKinds = new Set(["legacy_network_egress_proxy", "legacy_network_api_base_url"]);
  const legacyKinds = new Set([
    "legacy_agent_block",
    "legacy_dynamic_agents",
    "legacy_dm_allow_from",
    "legacy_bot_token",
    "legacy_bot_aes",
    "legacy_reject_message",
    "legacy_inline_account",
  ]);

  for (const item of detectedLegacyFields) {
    let source = "";
    if (officialKinds.has(item.kind)) {
      source = "official-wecom";
    } else if (sunnoyKinds.has(item.kind)) {
      source = "sunnoy-wecom";
    } else if (legacyKinds.has(item.kind)) {
      source = "legacy-openclaw-wechat";
    }
    if (!source) continue;
    sourceSignals.push({
      source,
      kind: item.kind,
      path: item.path,
      detail: item.detail,
      accountId: item.accountId,
    });
  }

  const signalSources = new Set(sourceSignals.map((item) => item.source));
  const hasLegacyOpenclawSignals = signalSources.has("legacy-openclaw-wechat");
  const hasOfficialSignals = signalSources.has("official-wecom");
  const hasSunnoySignals = signalSources.has("sunnoy-wecom");

  let source = "unknown";
  if (!hasWecomConfig) {
    source = "fresh";
  } else if (hasLegacyOpenclawSignals && (hasOfficialSignals || hasSunnoySignals)) {
    source = "mixed-source";
  } else if (hasSunnoySignals) {
    source = "sunnoy-wecom";
  } else if (hasOfficialSignals) {
    source = "official-wecom";
  } else if (hasLegacyOpenclawSignals) {
    source = "legacy-openclaw-wechat";
  } else if (hasWecomConfig) {
    source = "native-openclaw-wechat";
  }

  return {
    source,
    sourceSummary: summarizeMigrationSource(source),
    sourceSignals,
  };
}

function buildSourceAwareMigrationTitle(source = "") {
  switch (source) {
    case "official-wecom":
      return "迁移官方 WeCom 插件配置";
    case "sunnoy-wecom":
      return "迁移 sunnoy WeCom 插件配置";
    case "legacy-openclaw-wechat":
      return "迁移 legacy OpenClaw-Wechat 配置";
    case "mixed-source":
      return "审阅 mixed-source WeCom 配置并迁移";
    default:
      return "迁移 legacy WeCom 配置";
  }
}

function buildSourceAwareMigrationDetail(source = "", migrationState = "") {
  switch (source) {
    case "official-wecom":
      return "检测到官方插件风格的扁平字段，建议归一化到当前 accounts 结构。";
    case "sunnoy-wecom":
      return "检测到 sunnoy 风格的兼容网络字段，建议归一化到当前标准结构。";
    case "legacy-openclaw-wechat":
      return "检测到历史 OpenClaw-Wechat 布局，建议迁移到账户化结构。";
    case "mixed-source":
      return "当前同时混用了多种来源的兼容字段，建议先审阅 patch 再写回配置。";
    default:
      return migrationState === "mixed_layout"
        ? "当前同时存在现代 accounts 布局和 legacy 兼容字段，建议先生成统一 patch。"
        : "当前仍包含 legacy 兼容字段，建议生成现代化 accounts patch。";
  }
}

function buildMigrationActions({
  installState,
  migrationState,
  migrationSource,
  migrationSourceSummary,
  detectedLegacyFields,
  installedVersion,
  configPatch,
  envTemplate,
} = {}) {
  const actions = [];

  if (installState === "stale_package") {
    actions.push({
      id: "upgrade-plugin-package",
      kind: "upgrade_package",
      title: "升级 npm 插件版本",
      detail: `当前 install metadata=${installedVersion || "unknown"}，建议至少升级到 ${PLUGIN_VERSION}。`,
      paths: ["plugins.installs.openclaw-wechat.version"],
      command: "npm install @dingxiang-me/openclaw-wechat@latest",
      recommended: true,
      blocking: false,
    });
  }

  if (migrationState === "legacy_config" || migrationState === "mixed_layout") {
    actions.push({
      id: "migrate-legacy-wecom-config",
      kind: "apply_patch",
      title: buildSourceAwareMigrationTitle(migrationSource),
      detail: buildSourceAwareMigrationDetail(migrationSource, migrationState),
      paths: detectedLegacyFields.map((item) => item.path),
      command: WECOM_MIGRATION_COMMAND,
      recommended: true,
      blocking: migrationState === "mixed_layout",
    });
  }

  if (configPatch) {
    actions.push({
      id: "write-migration-patch",
      kind: "write_patch",
      title: "导出迁移 patch",
      detail:
        migrationSource && !["fresh", "native-openclaw-wechat", "unknown"].includes(migrationSource)
          ? `${migrationSourceSummary} 先导出 configPatch / envTemplate，再决定是否落盘。`
          : "将 configPatch / envTemplate 导出为可审阅文件，再决定是否落盘。",
      paths: ["channels.wecom.accounts"],
      command: "npm run wecom:migrate -- --json",
      recommended: true,
      blocking: false,
    });
  }

  if (Array.isArray(envTemplate?.lines) && envTemplate.lines.length > 0) {
    actions.push({
      id: "set-wecom-env-template",
      kind: "set_env",
      title: "整理 WeCom 环境变量模板",
      detail: "把敏感字段整理进 env.vars 或系统环境变量，减少 openclaw.json 内联 Secret。",
      paths: [],
      command: "npm run wecom:migrate -- --json",
      recommended: false,
      blocking: false,
    });
  }

  return actions;
}

export function collectWecomMigrationDiagnostics({ config = {}, accountId = "default" } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(config?.channels?.wecom);
  const modernAccountIds = collectModernAccountIds(channelConfig);
  const inlineAccounts = listLegacyInlineAccountEntries(channelConfig).map(([legacyAccountId]) =>
    normalizeAccountId(legacyAccountId),
  );
  const modernAccounts = asObject(channelConfig.accounts);
  const installMeta = asObject(config?.plugins?.installs?.["openclaw-wechat"]);
  const installedVersion = pickFirstNonEmptyString(installMeta.resolvedVersion, installMeta.version);
  const versionCompare = installedVersion ? compareSemverLike(installedVersion, PLUGIN_VERSION) : null;
  const stalePackage = Boolean(installedVersion) && versionCompare != null && versionCompare < 0;

  const detectedLegacyFields = [
    ...collectLegacyFieldsForAccount(channelConfig, {
      accountId: "default",
      pathPrefix: "channels.wecom",
    }),
  ];

  for (const [accountIdKey, accountConfig] of Object.entries(modernAccounts)) {
    detectedLegacyFields.push(
      ...collectLegacyFieldsForAccount(accountConfig, {
        accountId: normalizeAccountId(accountIdKey),
        pathPrefix: `channels.wecom.accounts.${normalizeAccountId(accountIdKey)}`,
      }),
    );
  }

  for (const [legacyAccountId] of listLegacyInlineAccountEntries(channelConfig)) {
    addLegacyField(detectedLegacyFields, {
      id: `${normalizeAccountId(legacyAccountId)}:legacy-inline-account`,
      kind: "legacy_inline_account",
      path: `channels.wecom.${normalizeAccountId(legacyAccountId)}`,
      title: "legacy inline account",
      detail: "仍在使用 channels.wecom.<accountId> 内联账户布局，建议迁移到 channels.wecom.accounts.<accountId>。",
      accountId: legacyAccountId,
    });
  }

  const hasWecomConfig = Object.keys(channelConfig).length > 0;
  const hasLegacy = detectedLegacyFields.length > 0;
  const hasMixedLayout =
    modernAccountIds.length > 0 &&
    (inlineAccounts.length > 0 ||
      detectedLegacyFields.some((item) => item.accountId === "default" || item.kind === "legacy_inline_account"));

  const installState = stalePackage
    ? "stale_package"
    : hasMixedLayout
      ? "mixed_layout"
      : hasLegacy
        ? "legacy_config"
        : hasWecomConfig
          ? "ready"
          : "fresh";

  const migrationState = hasMixedLayout
    ? "mixed_layout"
    : hasLegacy
      ? "legacy_config"
      : stalePackage
        ? "stale_package"
        : hasWecomConfig
          ? "ready"
          : "fresh";
  const sourceDiagnostics = buildMigrationSourceDiagnostics({
    hasWecomConfig,
    detectedLegacyFields,
  });

  const configPatch = buildMigrationConfigPatch(config);
  const envTemplate = configPatch ? buildMigrationEnvTemplate(configPatch) : { format: "dotenv", lines: [] };
  const recommendedActions = buildMigrationActions({
    installState,
    migrationState,
    migrationSource: sourceDiagnostics.source,
    migrationSourceSummary: sourceDiagnostics.sourceSummary,
    detectedLegacyFields,
    installedVersion,
    configPatch,
    envTemplate,
  });

  return {
    accountId: normalizedAccountId,
    installState,
    installStateSummary: summarizeInstallState(installState),
    migrationState,
    migrationStateSummary: summarizeMigrationState(migrationState),
    migrationSource: sourceDiagnostics.source,
    migrationSourceSummary: sourceDiagnostics.sourceSummary,
    migrationSourceSignals: sourceDiagnostics.sourceSignals,
    installedVersion: installedVersion || null,
    expectedVersion: PLUGIN_VERSION,
    stalePackage,
    hasWecomConfig,
    modernAccountIds,
    inlineAccountIds: inlineAccounts,
    detectedLegacyFields,
    recommendedActions,
    configPatch,
    envTemplate,
    migrationCommand: WECOM_MIGRATION_COMMAND,
  };
}
