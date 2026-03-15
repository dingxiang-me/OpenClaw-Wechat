import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "./account-config-core.js";
import { collectWecomMigrationDiagnostics } from "./migration-diagnostics.js";
import {
  buildWecomQuickstartSetupPlan,
  WECOM_DOCTOR_COMMAND,
  WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  WECOM_QUICKSTART_MIGRATION_COMMAND,
  WECOM_QUICKSTART_RECOMMENDED_MODE,
  WECOM_QUICKSTART_SETUP_COMMAND,
  WECOM_QUICKSTART_WIZARD_COMMAND,
} from "./quickstart-metadata.js";

export const WECOM_PLUGIN_ENTRY_ID = "openclaw-wechat";
export const WECOM_PLUGIN_NPM_SPEC = "@dingxiang-me/openclaw-wechat";
export const WECOM_INSTALLER_NPM_SPEC = "@dingxiang-me/openclaw-wecom-cli";
export const WECOM_INSTALLER_COMMAND = "npx -y @dingxiang-me/openclaw-wecom-cli install";
export const WECOM_INSTALLER_SOURCE_OPTIONS = Object.freeze([
  "auto",
  "official-wecom",
  "sunnoy-wecom",
  "legacy-openclaw-wechat",
]);

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function uniquePaths(values = []) {
  return uniqueStrings(values);
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function dedupeActions(actions = []) {
  const seen = new Set();
  const out = [];
  for (const action of actions) {
    const id = String(action?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(action);
  }
  return out;
}

function dedupeCheckItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function detectInstallerAccountCapabilities(config = {}, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(config?.channels?.wecom);
  const configuredDefaultAccountId = normalizeAccountId(channelConfig?.defaultAccount ?? "default");
  const accountConfig =
    normalizedAccountId === "default"
      ? mergeDeep(channelConfig, asObject(channelConfig?.accounts?.[configuredDefaultAccountId]))
      : asObject(channelConfig?.accounts?.[normalizedAccountId] ?? channelConfig?.[normalizedAccountId]);
  const legacyAgent = asObject(accountConfig?.agent);
  const bot = asObject(accountConfig?.bot);
  const longConnection = asObject(bot?.longConnection);
  const hasAgent =
    Boolean(pickFirstNonEmptyString(accountConfig?.corpId, legacyAgent?.corpId)) &&
    Boolean(pickFirstNonEmptyString(accountConfig?.corpSecret, legacyAgent?.corpSecret)) &&
    Number.isFinite(Number(accountConfig?.agentId ?? legacyAgent?.agentId));
  const hasBotLongConnection =
    Boolean(pickFirstNonEmptyString(longConnection?.botId, longConnection?.botid, accountConfig?.botId, accountConfig?.botid)) &&
    Boolean(pickFirstNonEmptyString(longConnection?.secret, accountConfig?.secret));
  const hasBotWebhook =
    Boolean(pickFirstNonEmptyString(bot?.token, bot?.callbackToken, accountConfig?.token)) &&
    Boolean(pickFirstNonEmptyString(bot?.encodingAesKey, bot?.callbackAesKey, accountConfig?.encodingAesKey));
  const hasGroupAllowlist =
    String(accountConfig?.groupPolicy ?? accountConfig?.groupChat?.policy ?? "").trim().toLowerCase() === "allowlist" ||
    (Array.isArray(accountConfig?.groupAllowFrom) && accountConfig.groupAllowFrom.length > 0);
  return {
    hasAgent,
    hasBotLongConnection,
    hasBotWebhook,
    hasBot: hasBotLongConnection || hasBotWebhook,
    hasGroupAllowlist,
  };
}

function buildInstallerSourceCheckOrder({ source = "fresh", capabilities = {}, selectedMode = "bot_long_connection" } = {}) {
  const checks = [];
  const pushCheck = (id, title, detail) => {
    checks.push({
      id,
      title,
      detail,
    });
  };

  pushCheck(
    "doctor_offline",
    "先跑离线 doctor",
    "先验证安装结构、迁移结果和本地插件布局，不依赖公网回调或网络出口。",
  );

  if (source === "official-wecom") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "优先确认扁平 Bot 配置已迁到当前结构。");
    }
    if (capabilities.hasBotLongConnection || selectedMode !== "agent_callback") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "在真正收发消息前，先验证长连接握手和代理链路。");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "如果来源里同时带了 Agent 能力，再确认 corpId/corpSecret/agentId。");
      pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认 WeCom 总体 readiness 和当前账号摘要。");
    }
    return dedupeCheckItems(checks);
  }

  if (source === "sunnoy-wecom") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "先确认 Bot 兼容字段已迁到当前结构。");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "确认 Agent 兼容字段和主动发送能力都已保留。");
    }
    if (capabilities.hasBotLongConnection || selectedMode !== "agent_callback") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "sunnoy 来源常带代理/出网配置，优先验证长连接网络。");
    }
    pushCheck("doctor_online", "最后跑联网 doctor", "把代理、apiBaseUrl、公网回调和真实网络探测一起验证。");
    return dedupeCheckItems(checks);
  }

  if (source === "legacy-openclaw-wechat") {
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "legacy 来源常含 agent.* 兼容块，先确认 Agent 已迁正。");
    }
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "确认旧版 Bot 字段已并到当前 bot.longConnection / bot.* 结构。");
    }
    if (capabilities.hasBotLongConnection || selectedMode === "bot_long_connection" || selectedMode === "hybrid") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "如果保留了 Bot 长连接，再额外验证 websocket 侧是否正常。");
    }
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认当前账号在迁移后仍能收、回、发。");
    return dedupeCheckItems(checks);
  }

  if (source === "mixed-source") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "混合来源先分别确认 Bot 侧字段是否已经收口。");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "混合来源还要单独确认 Agent 兼容字段没有漏迁。");
    }
    pushCheck("channel_selfcheck", "检查综合回包能力", "在继续落盘或上线前，先跑一次综合自检确认总体状态。");
    return dedupeCheckItems(checks);
  }

  if (selectedMode === "agent_callback") {
    pushCheck("agent_selfcheck", "检查 Agent 配置", "确认 callback、Agent API 和当前账号配置都完整。");
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认当前账号 readiness。");
    return dedupeCheckItems(checks);
  }

  if (selectedMode === "hybrid") {
    pushCheck("agent_selfcheck", "检查 Agent 配置", "先确认 Agent 主动发送和 callback 路径。");
    pushCheck("bot_selfcheck", "检查 Bot 基础配置", "再确认 Bot 对话入口和 webhook/长连接结构。");
    pushCheck("bot_longconn_probe", "探测 Bot 长连接", "如果启用了长连接，最后做一次 websocket 握手验证。");
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认双通道综合状态。");
    return dedupeCheckItems(checks);
  }

  pushCheck("bot_selfcheck", "检查 Bot 基础配置", "确认 Bot 长连接必填项、webhook 配置和当前账号摘要。");
  pushCheck("bot_longconn_probe", "探测 Bot 长连接", "在真正发消息前先验证 websocket 握手。");
  return dedupeCheckItems(checks);
}

function buildInstallerSourceRepairDefaults({ source = "fresh" } = {}) {
  if (source === "official-wecom") {
    return {
      doctorFixMode: "auto",
      preserveNetworkCompatibility: false,
      removeLegacyFieldAliases: true,
      preferOfflineDoctor: true,
    };
  }
  if (source === "sunnoy-wecom") {
    return {
      doctorFixMode: "confirm",
      preserveNetworkCompatibility: true,
      removeLegacyFieldAliases: true,
      preferOfflineDoctor: false,
    };
  }
  if (source === "legacy-openclaw-wechat") {
    return {
      doctorFixMode: "auto",
      preserveNetworkCompatibility: true,
      removeLegacyFieldAliases: true,
      preferOfflineDoctor: true,
    };
  }
  if (source === "mixed-source") {
    return {
      doctorFixMode: "confirm",
      preserveNetworkCompatibility: true,
      removeLegacyFieldAliases: false,
      preferOfflineDoctor: true,
    };
  }
  return {
    doctorFixMode: "off",
    preserveNetworkCompatibility: true,
    removeLegacyFieldAliases: false,
    preferOfflineDoctor: true,
  };
}

function resolveInstallerSourceProfile({
  requestedSource = "auto",
  detectedSource = "fresh",
  requestedMode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  requestedGroupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  requestedDmMode = "pairing",
  modeExplicit = false,
  groupProfileExplicit = false,
  dmModeExplicit = false,
  config = {},
  accountId = "default",
} = {}) {
  const source = String(requestedSource === "auto" ? detectedSource : requestedSource || detectedSource || "fresh");
  const capabilities = detectInstallerAccountCapabilities(config, accountId);
  const recommendedMode = capabilities.hasAgent && capabilities.hasBot
    ? "hybrid"
    : capabilities.hasAgent
      ? "agent_callback"
      : "bot_long_connection";
  const selectedMode = modeExplicit ? requestedMode : recommendedMode;
  const recommendedGroupProfile = capabilities.hasGroupAllowlist ? "allowlist_template" : WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE;
  const selectedGroupProfile = groupProfileExplicit ? requestedGroupProfile : recommendedGroupProfile;
  const selectedDmMode = dmModeExplicit ? requestedDmMode : "pairing";
  const checkOrder = buildInstallerSourceCheckOrder({
    source,
    capabilities,
    selectedMode,
  });
  const repairDefaults = buildInstallerSourceRepairDefaults({ source });
  const notes = [];
  if (!modeExplicit && selectedMode !== requestedMode) {
    notes.push(`未显式指定 mode，安装器按 ${source} 来源和现有能力选择了 ${selectedMode}。`);
  }
  if (!groupProfileExplicit && selectedGroupProfile !== requestedGroupProfile) {
    notes.push(`检测到群白名单相关配置，默认切换到 ${selectedGroupProfile} 模板。`);
  }
  if (source === "official-wecom") {
    notes.push("官方插件来源默认优先保留 Bot 长连接接入路径。");
  } else if (source === "sunnoy-wecom") {
    notes.push("sunnoy 来源会优先保留现有网络兼容字段和双通道能力。");
  } else if (source === "legacy-openclaw-wechat") {
    notes.push("legacy 来源会优先匹配旧版 agent/bot 组合能力，再决定安装模式。");
  }
  if (repairDefaults.doctorFixMode === "auto") {
    notes.push("该来源默认允许 installer/doctor 自动应用本地迁移 patch。");
  } else if (repairDefaults.doctorFixMode === "confirm") {
    notes.push("该来源默认先保守输出迁移建议，不会直接附带 doctor --fix。");
  }
  return {
    source,
    capabilities,
    requestedMode,
    requestedGroupProfile,
    requestedDmMode,
    recommendedMode,
    recommendedGroupProfile,
    recommendedDmMode: "pairing",
    selectedMode,
    selectedGroupProfile,
    selectedDmMode,
    checkOrder,
    checkOrderSummary: checkOrder.map((item) => item.title).join(" -> "),
    repairDefaults,
    modeDerived: modeExplicit !== true,
    groupProfileDerived: groupProfileExplicit !== true,
    dmModeDerived: dmModeExplicit !== true,
    notes,
  };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectChangedPaths(baseValue, patchValue, prefix = "", out = []) {
  if (Array.isArray(patchValue)) {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  if (!patchValue || typeof patchValue !== "object") {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(patchValue)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const nextBase = baseValue && typeof baseValue === "object" ? baseValue[key] : undefined;
    collectChangedPaths(nextBase, value, nextPrefix, out);
  }
  return out;
}

function deleteNestedPath(target, dottedPath = "") {
  const parts = String(dottedPath ?? "").split(".").filter(Boolean);
  if (parts.length === 0) return;
  const stack = [];
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return;
    stack.push([cursor, part]);
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return;
  delete cursor[parts.at(-1)];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const [parent, key] = stack[index];
    const child = parent?.[key];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    }
  }
}

function buildMigratedConfig(baseConfig = {}, patch = {}, legacyFields = []) {
  const merged = mergeDeep(baseConfig, patch);
  for (const field of Array.isArray(legacyFields) ? legacyFields : []) {
    deleteNestedPath(merged, field?.path);
  }
  return merged;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildBackupPath(configPath) {
  return `${configPath}.bak-${Date.now()}`;
}

function splitPathSegments(input) {
  return String(input ?? "")
    .split(".")
    .flatMap((segment) => {
      const parts = [];
      const re = /([^[\]]+)|\[(\d+)\]/g;
      let matched = null;
      while ((matched = re.exec(segment))) {
        if (matched[1]) parts.push(matched[1]);
        else if (matched[2]) parts.push(Number.parseInt(matched[2], 10));
      }
      return parts;
    });
}

function getAtPath(value, pathText) {
  let current = value;
  for (const segment of splitPathSegments(pathText)) {
    if (current == null) return undefined;
    current = current?.[segment];
  }
  return current;
}

function setAtPath(target, pathText, nextValue) {
  const segments = splitPathSegments(pathText);
  if (segments.length === 0) return;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const existing = current?.[segment];
    if (existing == null || typeof existing !== "object") {
      current[segment] = typeof nextSegment === "number" ? [] : {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = nextValue;
}

function normalizeGroupAllow(groupAllow) {
  if (Array.isArray(groupAllow)) {
    return groupAllow.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  return String(groupAllow ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveStarterAccountConfig(starterConfig, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(starterConfig?.channels?.wecom);
  if (normalizedAccountId === "default") return channelConfig;
  if (!channelConfig.accounts || typeof channelConfig.accounts !== "object") {
    channelConfig.accounts = {};
  }
  if (!channelConfig.accounts[normalizedAccountId] || typeof channelConfig.accounts[normalizedAccountId] !== "object") {
    channelConfig.accounts[normalizedAccountId] = {};
  }
  return channelConfig.accounts[normalizedAccountId];
}

function resolveMigrationAccountPatch(configPatch = {}, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelPatch = asObject(configPatch?.channels?.wecom);
  const accountPatches = asObject(channelPatch?.accounts);
  return asObject(accountPatches?.[normalizedAccountId]);
}

function mergeAccountPatchIntoStarterConfig(starterConfig, accountId = "default", accountPatch = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(starterConfig?.channels?.wecom);
  if (normalizedAccountId === "default") {
    starterConfig.channels.wecom = mergeDeep(channelConfig, accountPatch);
    return starterConfig;
  }
  const targetAccountConfig = resolveStarterAccountConfig(starterConfig, normalizedAccountId);
  channelConfig.accounts[normalizedAccountId] = mergeDeep(targetAccountConfig, accountPatch);
  return starterConfig;
}

function buildPluginEnablePatch() {
  return {
    plugins: {
      enabled: true,
      allow: [WECOM_PLUGIN_ENTRY_ID],
      entries: {
        [WECOM_PLUGIN_ENTRY_ID]: {
          enabled: true,
        },
      },
    },
  };
}

function applyInstallerValuesToStarterConfig(starterConfig, accountId = "default", values = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(starterConfig?.channels?.wecom);
  const targetAccountConfig = resolveStarterAccountConfig(starterConfig, normalizedAccountId);

  if (values.corpId) targetAccountConfig.corpId = String(values.corpId).trim();
  if (values.corpSecret) targetAccountConfig.corpSecret = String(values.corpSecret).trim();
  if (values.agentId != null && values.agentId !== "") targetAccountConfig.agentId = Number(values.agentId);
  if (values.callbackToken) targetAccountConfig.callbackToken = String(values.callbackToken).trim();
  if (values.callbackAesKey) targetAccountConfig.callbackAesKey = String(values.callbackAesKey).trim();
  if (values.webhookPath) targetAccountConfig.webhookPath = String(values.webhookPath).trim();
  if (values.apiBaseUrl) targetAccountConfig.apiBaseUrl = String(values.apiBaseUrl).trim();
  if (values.outboundProxy) targetAccountConfig.outboundProxy = String(values.outboundProxy).trim();

  if (values.botId || values.botSecret) {
    channelConfig.bot = asObject(channelConfig.bot);
    channelConfig.bot.enabled = true;
    channelConfig.bot.longConnection = asObject(channelConfig.bot.longConnection);
    channelConfig.bot.longConnection.enabled = true;
    if (values.botId) channelConfig.bot.longConnection.botId = String(values.botId).trim();
    if (values.botSecret) channelConfig.bot.longConnection.secret = String(values.botSecret).trim();
  }

  if (normalizedAccountId !== "default") {
    targetAccountConfig.bot = asObject(targetAccountConfig.bot);
    targetAccountConfig.bot.longConnection = asObject(targetAccountConfig.bot.longConnection);
    if (values.botId) {
      targetAccountConfig.bot.enabled = true;
      targetAccountConfig.bot.longConnection.enabled = true;
      targetAccountConfig.bot.longConnection.botId = String(values.botId).trim();
    }
    if (values.botSecret) {
      targetAccountConfig.bot.enabled = true;
      targetAccountConfig.bot.longConnection.enabled = true;
      targetAccountConfig.bot.longConnection.secret = String(values.botSecret).trim();
    }
    if (values.botWebhookToken) {
      targetAccountConfig.bot.token = String(values.botWebhookToken).trim();
    }
    if (values.botEncodingAesKey) {
      targetAccountConfig.bot.encodingAesKey = String(values.botEncodingAesKey).trim();
    }
    if (values.botWebhookPath) {
      targetAccountConfig.bot.webhookPath = String(values.botWebhookPath).trim();
    }
  } else {
    if (values.botWebhookToken) {
      channelConfig.bot = asObject(channelConfig.bot);
      channelConfig.bot.enabled = true;
      channelConfig.bot.token = String(values.botWebhookToken).trim();
    }
    if (values.botEncodingAesKey) {
      channelConfig.bot = asObject(channelConfig.bot);
      channelConfig.bot.enabled = true;
      channelConfig.bot.encodingAesKey = String(values.botEncodingAesKey).trim();
    }
    if (values.botWebhookPath) {
      channelConfig.bot = asObject(channelConfig.bot);
      channelConfig.bot.enabled = true;
      channelConfig.bot.webhookPath = String(values.botWebhookPath).trim();
    }
  }

  return starterConfig;
}

function resolveRemainingPlaceholders(placeholders = [], starterConfig = {}) {
  return placeholders.filter((item) => valuesEqual(getAtPath(starterConfig, item.path), item.currentValue));
}

function buildWecomInstallerMigrationGuide({
  requestedSource = "auto",
  detectedSource = "unknown",
  effectiveSource = "unknown",
  sourceSummary = "",
  sourceSignals = [],
  sourceMismatch = false,
} = {}) {
  const source = String(detectedSource || effectiveSource || "unknown");
  const title =
    source === "official-wecom"
      ? "官方 WeCom 插件迁移"
      : source === "sunnoy-wecom"
        ? "sunnoy WeCom 插件迁移"
        : source === "legacy-openclaw-wechat"
          ? "旧版 OpenClaw-Wechat 迁移"
          : source === "mixed-source"
            ? "混合来源 WeCom 迁移"
            : source === "native-openclaw-wechat"
              ? "当前已是原生 OpenClaw-Wechat 布局"
              : source === "fresh"
                ? "首次安装"
                : "WeCom 配置迁移";
  const notes = [];
  if (source === "official-wecom") {
    notes.push("已识别官方插件常见的扁平 Bot 配置写法，安装器会归一化到当前 bot/accounts 结构。");
  } else if (source === "sunnoy-wecom") {
    notes.push("已识别 sunnoy 风格兼容字段，安装器会保留网络与 Bot 能力并归一化到当前结构。");
  } else if (source === "legacy-openclaw-wechat") {
    notes.push("已识别旧版 OpenClaw-Wechat 兼容字段，安装器会迁移 legacy agent/dynamic/layout 配置。");
  } else if (source === "mixed-source") {
    notes.push("当前配置混合了多种来源的兼容字段，建议优先审阅迁移 patch 再继续落盘。");
  } else if (source === "native-openclaw-wechat") {
    notes.push("当前配置已经是原生布局，安装器主要补插件启用与 starter config。");
  } else if (source === "fresh") {
    notes.push("当前未发现需要迁移的旧配置，将直接按 quickstart 生成 starter config。");
  }
  if (sourceMismatch) {
    notes.push(`你指定了 ${requestedSource}，但实际检测更接近 ${detectedSource}，请在落盘前确认来源判断。`);
  }
  if (String(sourceSummary).trim()) {
    notes.push(String(sourceSummary).trim());
  }
  const legacyFieldPaths = uniqueStrings(sourceSignals.map((item) => item?.path));
  const signalKinds = uniqueStrings(sourceSignals.map((item) => item?.kind));
  return {
    source,
    requestedSource,
    effectiveSource,
    title,
    summary: String(sourceSummary || "").trim() || title,
    notes,
    legacyFieldPaths,
    signalKinds,
    recommendedCommand: WECOM_QUICKSTART_MIGRATION_COMMAND,
    doctorFixCommand: `${WECOM_DOCTOR_COMMAND} --fix`,
  };
}

function buildWecomInstallerActions({
  setupPlan,
  diagnostics,
  guide,
  sourceProfile,
  configPatch,
  canAutoFix = false,
} = {}) {
  const actions = [];
  const migrationSource = String(diagnostics?.migrationSource ?? guide?.source ?? "unknown");
  const migrationState = String(diagnostics?.migrationState ?? "");

  if (guide?.title) {
    actions.push({
      id: "review-installer-migration-source",
      kind: "review_migration",
      title: guide.title,
      detail: guide.summary || guide.title,
      paths: uniquePaths(guide.legacyFieldPaths ?? []),
      command: WECOM_QUICKSTART_MIGRATION_COMMAND,
      recommended: migrationSource !== "fresh" && migrationSource !== "native-openclaw-wechat",
      blocking: migrationState === "mixed_layout",
    });
  }

  if (sourceProfile?.modeDerived && sourceProfile?.selectedMode) {
    actions.push({
      id: "review-installer-selected-mode",
      kind: "review_setup_profile",
      title: "确认安装器自动选择的接入模式",
      detail: `当前将按 ${sourceProfile.selectedMode} 生成 starter config。${sourceProfile.notes?.join(" ") || ""}`.trim(),
      paths: [],
      command: WECOM_INSTALLER_COMMAND,
      recommended: true,
      blocking: false,
    });
  }

  if (Array.isArray(sourceProfile?.checkOrder) && sourceProfile.checkOrder.length > 0) {
    actions.push({
      id: "review-installer-check-order",
      kind: "review_checks",
      title: "确认来源专属检查顺序",
      detail: sourceProfile.checkOrderSummary || "请按安装器给出的检查顺序继续验证。",
      paths: [],
      command: WECOM_INSTALLER_COMMAND,
      recommended: true,
      blocking: false,
    });
  }

  if (guide?.requestedSource && guide?.requestedSource !== "auto" && guide?.requestedSource !== guide?.source) {
    actions.push({
      id: "review-installer-source-mismatch",
      kind: "review_migration",
      title: "确认迁移来源判断",
      detail: `当前检测到 ${guide.source}，但安装参数指定了 ${guide.requestedSource}。`,
      paths: uniquePaths(guide.legacyFieldPaths ?? []),
      command: WECOM_QUICKSTART_MIGRATION_COMMAND,
      recommended: true,
      blocking: true,
    });
  }

  if (Array.isArray(diagnostics?.recommendedActions)) {
    for (const action of diagnostics.recommendedActions) {
      actions.push({
        ...action,
        id: `migration:${action.id}`,
      });
    }
  }

  if (canAutoFix) {
    actions.push({
      id: "installer-run-doctor-fix",
      kind: "apply_patch",
      title: `对${guide?.title || "当前 WeCom 配置"}执行 doctor --fix`,
      detail: "在 starter config 写入后，继续应用本地 migration/plugin patch 并重跑 doctor。",
      paths: uniquePaths([
        ...(guide?.legacyFieldPaths ?? []),
        ...Object.keys(asObject(configPatch?.channels?.wecom)).map((key) => `channels.wecom.${key}`),
      ]),
      command: `${WECOM_DOCTOR_COMMAND} --fix`,
      recommended: true,
      blocking: false,
    });
  }

  if (Array.isArray(setupPlan?.actions)) {
    for (const action of setupPlan.actions) {
      actions.push({
        ...action,
        id: `setup:${action.id}`,
      });
    }
  }

  return dedupeActions(actions);
}

export function buildWecomPluginInstallCommand({ openclawBin = "openclaw", npmSpec = WECOM_PLUGIN_NPM_SPEC } = {}) {
  return {
    bin: String(openclawBin || "openclaw").trim() || "openclaw",
    args: ["plugins", "install", String(npmSpec || WECOM_PLUGIN_NPM_SPEC).trim() || WECOM_PLUGIN_NPM_SPEC],
  };
}

export function buildWecomInstallerPlan({
  mode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  accountId = "default",
  from = "auto",
  dmMode = "pairing",
  modeExplicit = false,
  dmModeExplicit = false,
  groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  groupProfileExplicit = false,
  groupChatId = "",
  groupAllow = [],
  currentConfig = {},
  values = {},
} = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedGroupAllow = normalizeGroupAllow(groupAllow);
  const requestedSource = String(from ?? "auto").trim().toLowerCase() || "auto";
  if (!WECOM_INSTALLER_SOURCE_OPTIONS.includes(requestedSource)) {
    throw new Error(
      `Unsupported installer source: ${requestedSource}. Expected one of ${WECOM_INSTALLER_SOURCE_OPTIONS.join(", ")}`,
    );
  }
  const diagnostics = collectWecomMigrationDiagnostics({
    config: currentConfig,
    accountId: normalizedAccountId,
  });
  const detectedSource = String(diagnostics?.migrationSource ?? "fresh");
  const effectiveSource = requestedSource === "auto" ? detectedSource : requestedSource;
  const migratedConfigForSelection = buildMigratedConfig(
    currentConfig,
    diagnostics?.configPatch ?? {},
    diagnostics?.detectedLegacyFields ?? [],
  );
  const sourceProfile = resolveInstallerSourceProfile({
    requestedSource,
    detectedSource,
    requestedMode: mode,
    requestedGroupProfile: groupProfile,
    requestedDmMode: dmMode,
    modeExplicit,
    groupProfileExplicit,
    dmModeExplicit,
    config: migratedConfigForSelection,
    accountId: normalizedAccountId,
  });
  const setupPlan = buildWecomQuickstartSetupPlan({
    mode: sourceProfile.selectedMode,
    accountId: normalizedAccountId,
    dmMode: sourceProfile.selectedDmMode,
    groupProfile: sourceProfile.selectedGroupProfile,
    groupChatId,
    groupAllow: normalizedGroupAllow,
    currentConfig,
  });
  const sourceMismatch =
    requestedSource !== "auto" &&
    !["fresh", "unknown", "mixed-source", requestedSource].includes(detectedSource);
  const starterConfig = deepClone(setupPlan.starterConfig);
  const migrationAccountPatch = resolveMigrationAccountPatch(diagnostics?.configPatch, normalizedAccountId);
  if (Object.keys(migrationAccountPatch).length > 0) {
    mergeAccountPatchIntoStarterConfig(starterConfig, normalizedAccountId, migrationAccountPatch);
  }
  const migratedDefaultAccount =
    normalizedAccountId !== "default"
      ? String(diagnostics?.configPatch?.channels?.wecom?.defaultAccount ?? "").trim()
      : "";
  if (migratedDefaultAccount) {
    starterConfig.channels.wecom.defaultAccount = migratedDefaultAccount;
  }
  applyInstallerValuesToStarterConfig(starterConfig, normalizedAccountId, values);
  const remainingPlaceholders = resolveRemainingPlaceholders(setupPlan.placeholders, starterConfig);
  const configPatch = mergeDeep(
    buildPluginEnablePatch(),
    mergeDeep(diagnostics?.configPatch ?? {}, starterConfig),
  );
  const canAutoFix =
    Boolean(diagnostics?.configPatch) &&
    !["fresh", "native-openclaw-wechat", "unknown"].includes(effectiveSource);
  const migrationGuide = buildWecomInstallerMigrationGuide({
    requestedSource,
    detectedSource,
    effectiveSource,
    sourceSummary: diagnostics?.migrationSourceSummary ?? "",
    sourceSignals: diagnostics?.migrationSourceSignals ?? [],
    sourceMismatch,
  });
  const actions = buildWecomInstallerActions({
    setupPlan,
    diagnostics,
    guide: migrationGuide,
    sourceProfile,
    configPatch,
    canAutoFix,
  });
  return {
    ...setupPlan,
    accountId: normalizedAccountId,
    source: requestedSource,
    groupAllow: normalizedGroupAllow,
    requestedMode: mode,
    requestedGroupProfile: groupProfile,
    requestedDmMode: dmMode,
    placeholdersBefore: setupPlan.placeholders,
    placeholders: remainingPlaceholders,
    starterConfig,
    configPatch,
    sourceProfile,
    migration: {
      requestedSource,
      detectedSource,
      effectiveSource,
      sourceSummary: diagnostics?.migrationSourceSummary ?? "",
      sourceSignals: diagnostics?.migrationSourceSignals ?? [],
      sourceMismatch,
      canAutoFix,
      legacyFields: diagnostics?.detectedLegacyFields ?? [],
      guide: migrationGuide,
      diagnostics,
    },
    actions,
    installer: {
      pluginEntryId: WECOM_PLUGIN_ENTRY_ID,
      pluginNpmSpec: WECOM_PLUGIN_NPM_SPEC,
      installerNpmSpec: WECOM_INSTALLER_NPM_SPEC,
      installerCommand: WECOM_INSTALLER_COMMAND,
      quickstartCommand: WECOM_QUICKSTART_SETUP_COMMAND,
      migrateCommand: WECOM_QUICKSTART_MIGRATION_COMMAND,
      doctorCommand: WECOM_DOCTOR_COMMAND,
      wizardCommand: WECOM_QUICKSTART_WIZARD_COMMAND,
    },
  };
}

export async function loadWecomInstallerConfig(configPath) {
  const resolvedPath = path.resolve(expandHome(configPath));
  try {
    const raw = await readFile(resolvedPath, "utf8");
    return {
      exists: true,
      configPath: resolvedPath,
      config: JSON.parse(raw),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        exists: false,
        configPath: resolvedPath,
        config: {},
      };
    }
    throw err;
  }
}

export async function applyWecomInstallerConfigPatch(configPath, patch, legacyFields = []) {
  const loaded = await loadWecomInstallerConfig(configPath);
  const merged = buildMigratedConfig(loaded.config, patch, legacyFields);
  const changedPaths = collectChangedPaths(loaded.config, merged);
  const backupPath = loaded.exists ? buildBackupPath(loaded.configPath) : null;
  await mkdir(path.dirname(loaded.configPath), { recursive: true });
  if (loaded.exists) {
    await writeFile(backupPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  }
  await writeFile(loaded.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    applied: true,
    existed: loaded.exists,
    configPath: loaded.configPath,
    backupPath,
    changedPaths,
    merged,
  };
}

export function previewWecomInstallerChangedPaths(currentConfig = {}, patch = {}, legacyFields = []) {
  return collectChangedPaths(asObject(currentConfig), buildMigratedConfig(asObject(currentConfig), patch, legacyFields));
}

export function applyWecomInstallerValuesForPreview(starterConfig = {}, accountId = "default", values = {}) {
  const copy = deepClone(starterConfig);
  applyInstallerValuesToStarterConfig(copy, accountId, values);
  return copy;
}

export function setWecomInstallerValueAtPath(target, pathText, value) {
  setAtPath(target, pathText, value);
  return target;
}
