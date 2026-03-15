import { collectWecomMigrationDiagnostics, WECOM_MIGRATION_COMMAND } from "./migration-diagnostics.js";

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
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

function normalizeAccountId(accountId = "default") {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function normalizeAllowList(values = []) {
  const out = [];
  const seen = new Set();
  const sourceValues = Array.isArray(values)
    ? values
    : String(values ?? "")
        .split(/[,\n]/)
        .map((item) => item.trim());
  for (const rawValue of sourceValues) {
    const normalized = String(rawValue ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function buildAccountContainer(accountId, config) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (normalizedAccountId === "default") return config;
  return {
    defaultAccount: normalizedAccountId,
    accounts: {
      [normalizedAccountId]: config,
    },
  };
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

function withDmMode(baseConfig, dmMode = "pairing") {
  return {
    ...baseConfig,
    dm: {
      mode: String(dmMode ?? "pairing").trim().toLowerCase() || "pairing",
    },
  };
}

function resolveStarterAccountConfig(starterConfig, accountId = "default") {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = asObject(starterConfig?.channels?.wecom);
  if (normalizedAccountId === "default") return channelConfig;
  return asObject(channelConfig?.accounts?.[normalizedAccountId]);
}

function detectWecomAccountCapabilities(config = {}, accountId = "default") {
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

const DEFAULT_ALLOWLIST_GROUP_CHAT_ID = "wr-your-chat-id";
const DEFAULT_ALLOWLIST_MEMBERS = Object.freeze(["ops_lead", "oncall_user"]);

const QUICKSTART_GROUP_PROFILE_DEFINITIONS = {
  inherit: {
    id: "inherit",
    label: "保持默认",
    summary: "不额外写入群聊策略，保留当前默认行为。",
    recommendedForModes: ["bot_long_connection", "agent_callback", "hybrid"],
    notes: [
      "适合先把私聊或 Bot 对话跑通，再按实际群场景补群策略。",
    ],
    buildPatch() {
      return {};
    },
  },
  mention_only: {
    id: "mention_only",
    label: "仅 @ 触发",
    summary: "群里保持开放，但只在 @ 机器人时触发。",
    recommendedForModes: ["bot_long_connection", "hybrid"],
    notes: [
      "Bot 模式通常最适合这类配置，能显著降低群噪音。",
    ],
    buildPatch() {
      return {
        groupPolicy: "open",
        groupChat: {
          enabled: true,
          triggerMode: "mention",
        },
      };
    },
  },
  open_direct: {
    id: "open_direct",
    label: "群聊直出",
    summary: "群里所有成员都可直接触发，无需 @。",
    recommendedForModes: ["agent_callback"],
    notes: [
      "更适合自建应用群回调场景；企业微信 Bot 平台通常仍只会按 mention 回调。",
    ],
    buildPatch() {
      return {
        groupPolicy: "open",
        groupChat: {
          enabled: true,
          triggerMode: "direct",
        },
      };
    },
  },
  allowlist_template: {
    id: "allowlist_template",
    label: "群白名单模板",
    summary: "预置 allowlist、按群覆盖和拒绝文案，适合值班群/运营群。",
    recommendedForModes: ["agent_callback", "hybrid", "bot_long_connection"],
    notes: [
      "可配合 --group-chat-id 和 --group-allow 直接生成一份可落地模板。",
    ],
    buildPatch({ groupChatId = "", groupAllow = [] } = {}) {
      const normalizedAllow = normalizeAllowList(groupAllow);
      const allowList = normalizedAllow.length > 0 ? normalizedAllow : [...DEFAULT_ALLOWLIST_MEMBERS];
      const targetChatId = String(groupChatId ?? "").trim() || DEFAULT_ALLOWLIST_GROUP_CHAT_ID;
      return {
        groupPolicy: "allowlist",
        groupChat: {
          enabled: true,
          triggerMode: "mention",
        },
        groupAllowFrom: allowList,
        groups: {
          [targetChatId]: {
            policy: "allowlist",
            triggerMode: "mention",
            allowFrom: allowList,
            rejectMessage: "当前群仅限值班同学触发。",
          },
        },
      };
    },
  },
  deny: {
    id: "deny",
    label: "关闭群聊",
    summary: "显式关闭群聊处理，只保留私聊/点对点路径。",
    recommendedForModes: ["bot_long_connection", "agent_callback", "hybrid"],
    notes: [
      "适合先只开放私聊，再逐步灰度群能力。",
    ],
    buildPatch() {
      return {
        groupPolicy: "deny",
        groupChat: {
          enabled: false,
        },
      };
    },
  },
};

const QUICKSTART_PLACEHOLDER_RULES = Object.freeze([
  {
    id: "corpId",
    match: ({ path, value }) => path.endsWith(".corpId") && value === "ww-your-corp-id",
    label: "CorpId",
    category: "agent",
    action: "替换成企业微信 CorpId",
  },
  {
    id: "corpSecret",
    match: ({ path, value }) => path.endsWith(".corpSecret") && value === "your-app-secret",
    label: "CorpSecret",
    category: "agent",
    action: "替换成自建应用 Secret",
  },
  {
    id: "agentId",
    match: ({ path, value }) => path.endsWith(".agentId") && Number(value) === 1000002,
    label: "AgentId",
    category: "agent",
    action: "确认并替换成真实 AgentId",
  },
  {
    id: "callbackToken",
    match: ({ path, value }) => path.endsWith(".callbackToken") && value === "your-callback-token",
    label: "Callback Token",
    category: "agent",
    action: "替换成企业微信回调 Token",
  },
  {
    id: "callbackAesKey",
    match: ({ path, value }) => path.endsWith(".callbackAesKey") && value === "your-callback-aes-key",
    label: "Callback AES Key",
    category: "agent",
    action: "替换成企业微信回调 EncodingAESKey",
  },
  {
    id: "botId",
    match: ({ path, value }) => path.endsWith(".botId") && value === "your-bot-id",
    label: "BotID",
    category: "bot",
    action: "替换成 Bot 长连接 BotID",
  },
  {
    id: "botSecret",
    match: ({ path, value }) => path.endsWith(".secret") && value === "your-bot-secret",
    label: "Bot Secret",
    category: "bot",
    action: "替换成 Bot 长连接 Secret",
  },
  {
    id: "groupChatId",
    match: ({ path, value }) => path.includes(".groups.") && value === "wr-your-chat-id",
    label: "群 ChatId",
    category: "group",
    action: "替换成真实群 ChatId",
  },
]);

const QUICKSTART_MODE_DEFINITIONS = {
  bot_long_connection: {
    id: "bot_long_connection",
    label: "Bot 长连接",
    recommended: true,
    requiresPublicWebhook: false,
    supportsPairing: true,
    docsAnchor: "#bot-long-connection",
    summary: "最快跑通对话；无需公网 callback，优先推荐。",
    requiredConfigPaths: [
      "channels.wecom.bot.enabled",
      "channels.wecom.bot.longConnection.enabled",
      "channels.wecom.bot.longConnection.botId",
      "channels.wecom.bot.longConnection.secret",
    ],
    checks: [
      "npm run wecom:bot:selfcheck -- --account default",
      "npm run wecom:bot:longconn:probe -- --json",
    ],
    notes: [
      "适合先验证收消息、回消息和 Bot PDF/语音链路。",
      "如需跨会话主动发送，建议后续再补 Agent 模式。",
    ],
    buildConfig({ accountId = "default", dmMode = "pairing" } = {}) {
      return {
        channels: {
          wecom: {
            enabled: true,
            ...buildAccountContainer(
              accountId,
              withDmMode(
                {
                  bot: {
                    enabled: true,
                    longConnection: {
                      enabled: true,
                      botId: "your-bot-id",
                      secret: "your-bot-secret",
                    },
                  },
                },
                dmMode,
              ),
            ),
          },
        },
      };
    },
  },
  agent_callback: {
    id: "agent_callback",
    label: "自建应用回调",
    recommended: false,
    requiresPublicWebhook: true,
    supportsPairing: true,
    docsAnchor: "#callback-url",
    summary: "适合需要主动发送、自建应用菜单和 Agent API 的场景。",
    requiredConfigPaths: [
      "channels.wecom.corpId",
      "channels.wecom.corpSecret",
      "channels.wecom.agentId",
      "channels.wecom.callbackToken",
      "channels.wecom.callbackAesKey",
      "channels.wecom.webhookPath",
    ],
    checks: [
      "npm run wecom:agent:selfcheck -- --account default",
      "npm run wecom:selfcheck -- --account default",
    ],
    notes: [
      "需要稳定公网域名，不建议正式环境依赖临时隧道。",
      "适合要发图片、文件、群主动通知和 wecom_doc 的团队。",
    ],
    buildConfig({ accountId = "default", dmMode = "pairing" } = {}) {
      return {
        channels: {
          wecom: {
            enabled: true,
            ...buildAccountContainer(
              accountId,
              withDmMode(
                {
                  corpId: "ww-your-corp-id",
                  corpSecret: "your-app-secret",
                  agentId: 1000002,
                  callbackToken: "your-callback-token",
                  callbackAesKey: "your-callback-aes-key",
                  webhookPath: "/wecom/callback",
                },
                dmMode,
              ),
            ),
          },
        },
      };
    },
  },
  hybrid: {
    id: "hybrid",
    label: "Bot + Agent 双通道",
    recommended: false,
    requiresPublicWebhook: true,
    supportsPairing: true,
    docsAnchor: "#callback-url",
    summary: "同时保留 Bot 长连接的接入顺滑和 Agent 的主动发送能力。",
    requiredConfigPaths: [
      "channels.wecom.corpId",
      "channels.wecom.corpSecret",
      "channels.wecom.agentId",
      "channels.wecom.callbackToken",
      "channels.wecom.callbackAesKey",
      "channels.wecom.bot.enabled",
      "channels.wecom.bot.longConnection.enabled",
      "channels.wecom.bot.longConnection.botId",
      "channels.wecom.bot.longConnection.secret",
    ],
    checks: [
      "npm run wecom:agent:selfcheck -- --account default",
      "npm run wecom:bot:selfcheck -- --account default",
    ],
    notes: [
      "推荐给既要在 Bot 场景里对话，又要保留 Agent 主动发送/文档工具的部署。",
      "可先按 Bot 长连接上线，再补 Agent 公网 callback。",
    ],
    buildConfig({ accountId = "default", dmMode = "pairing" } = {}) {
      return {
        channels: {
          wecom: {
            enabled: true,
            ...buildAccountContainer(
              accountId,
              withDmMode(
                {
                  corpId: "ww-your-corp-id",
                  corpSecret: "your-app-secret",
                  agentId: 1000002,
                  callbackToken: "your-callback-token",
                  callbackAesKey: "your-callback-aes-key",
                  webhookPath: "/wecom/callback",
                  bot: {
                    enabled: true,
                    longConnection: {
                      enabled: true,
                      botId: "your-bot-id",
                      secret: "your-bot-secret",
                    },
                  },
                },
                dmMode,
              ),
            ),
          },
        },
      };
    },
  },
};

export const WECOM_QUICKSTART_RECOMMENDED_MODE = "bot_long_connection";
export const WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE = "inherit";
export const WECOM_QUICKSTART_SETUP_COMMAND = "npm run wecom:quickstart -- --json";
export const WECOM_QUICKSTART_WRITE_COMMAND = "npm run wecom:quickstart -- --write";
export const WECOM_QUICKSTART_WIZARD_COMMAND = "npm run wecom:quickstart -- --wizard";
export const WECOM_QUICKSTART_RUN_CHECKS_COMMAND = "npm run wecom:quickstart -- --run-checks";
export const WECOM_QUICKSTART_FORCE_CHECKS_COMMAND = "npm run wecom:quickstart -- --run-checks --force-checks";
export const WECOM_QUICKSTART_APPLY_REPAIR_COMMAND = "npm run wecom:quickstart -- --run-checks --apply-repair";
export const WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND = "npm run wecom:quickstart -- --run-checks --confirm-repair";
export const WECOM_QUICKSTART_MIGRATION_COMMAND = WECOM_MIGRATION_COMMAND;
export const WECOM_DOCTOR_COMMAND = "npm run wecom:doctor -- --json";

export function buildWecomSourceCheckOrder({
  source = "fresh",
  capabilities = {},
  selectedMode = WECOM_QUICKSTART_RECOMMENDED_MODE,
} = {}) {
  const checks = [];
  const pushCheck = (id, title, detail, command) => {
    checks.push({
      id,
      title,
      detail,
      command,
    });
  };

  pushCheck(
    "doctor_offline",
    "先跑离线 doctor",
    "先验证安装结构、迁移结果和本地插件布局，不依赖公网回调或网络出口。",
    "npm run wecom:doctor -- --skip-network --skip-local-webhook --json",
  );

  if (source === "official-wecom") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "优先确认扁平 Bot 配置已迁到当前结构。", "npm run wecom:bot:selfcheck -- --account default");
    }
    if (capabilities.hasBotLongConnection || selectedMode !== "agent_callback") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "在真正收发消息前，先验证长连接握手和代理链路。", "npm run wecom:bot:longconn:probe -- --json");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "如果来源里同时带了 Agent 能力，再确认 corpId/corpSecret/agentId。", "npm run wecom:agent:selfcheck -- --account default");
      pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认 WeCom 总体 readiness 和当前账号摘要。", "npm run wecom:selfcheck -- --account default");
    }
    return dedupeCheckItems(checks);
  }

  if (source === "sunnoy-wecom") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "先确认 Bot 兼容字段已迁到当前结构。", "npm run wecom:bot:selfcheck -- --account default");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "确认 Agent 兼容字段和主动发送能力都已保留。", "npm run wecom:agent:selfcheck -- --account default");
    }
    if (capabilities.hasBotLongConnection || selectedMode !== "agent_callback") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "sunnoy 来源常带代理/出网配置，优先验证长连接网络。", "npm run wecom:bot:longconn:probe -- --json");
    }
    pushCheck("doctor_online", "最后跑联网 doctor", "把代理、apiBaseUrl、公网回调和真实网络探测一起验证。", "npm run wecom:doctor -- --json");
    return dedupeCheckItems(checks);
  }

  if (source === "legacy-openclaw-wechat") {
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "legacy 来源常含 agent.* 兼容块，先确认 Agent 已迁正。", "npm run wecom:agent:selfcheck -- --account default");
    }
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "确认旧版 Bot 字段已并到当前 bot.longConnection / bot.* 结构。", "npm run wecom:bot:selfcheck -- --account default");
    }
    if (capabilities.hasBotLongConnection || selectedMode === "bot_long_connection" || selectedMode === "hybrid") {
      pushCheck("bot_longconn_probe", "探测 Bot 长连接", "如果保留了 Bot 长连接，再额外验证 websocket 侧是否正常。", "npm run wecom:bot:longconn:probe -- --json");
    }
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认当前账号在迁移后仍能收、回、发。", "npm run wecom:selfcheck -- --account default");
    return dedupeCheckItems(checks);
  }

  if (source === "mixed-source") {
    if (capabilities.hasBot || selectedMode !== "agent_callback") {
      pushCheck("bot_selfcheck", "检查 Bot 基础配置", "混合来源先分别确认 Bot 侧字段是否已经收口。", "npm run wecom:bot:selfcheck -- --account default");
    }
    if (capabilities.hasAgent || selectedMode !== "bot_long_connection") {
      pushCheck("agent_selfcheck", "检查 Agent 配置", "混合来源还要单独确认 Agent 兼容字段没有漏迁。", "npm run wecom:agent:selfcheck -- --account default");
    }
    pushCheck("channel_selfcheck", "检查综合回包能力", "在继续落盘或上线前，先跑一次综合自检确认总体状态。", "npm run wecom:selfcheck -- --account default");
    return dedupeCheckItems(checks);
  }

  if (selectedMode === "agent_callback") {
    pushCheck("agent_selfcheck", "检查 Agent 配置", "确认 callback、Agent API 和当前账号配置都完整。", "npm run wecom:agent:selfcheck -- --account default");
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认当前账号 readiness。", "npm run wecom:selfcheck -- --account default");
    return dedupeCheckItems(checks);
  }

  if (selectedMode === "hybrid") {
    pushCheck("agent_selfcheck", "检查 Agent 配置", "先确认 Agent 主动发送和 callback 路径。", "npm run wecom:agent:selfcheck -- --account default");
    pushCheck("bot_selfcheck", "检查 Bot 基础配置", "再确认 Bot 对话入口和 webhook/长连接结构。", "npm run wecom:bot:selfcheck -- --account default");
    pushCheck("bot_longconn_probe", "探测 Bot 长连接", "如果启用了长连接，最后做一次 websocket 握手验证。", "npm run wecom:bot:longconn:probe -- --json");
    pushCheck("channel_selfcheck", "检查综合回包能力", "最后确认双通道综合状态。", "npm run wecom:selfcheck -- --account default");
    return dedupeCheckItems(checks);
  }

  pushCheck("bot_selfcheck", "检查 Bot 基础配置", "确认 Bot 长连接必填项、webhook 配置和当前账号摘要。", "npm run wecom:bot:selfcheck -- --account default");
  pushCheck("bot_longconn_probe", "探测 Bot 长连接", "在真正发消息前先验证 websocket 握手。", "npm run wecom:bot:longconn:probe -- --json");
  return dedupeCheckItems(checks);
}

export function buildWecomSourceRepairDefaults({ source = "fresh" } = {}) {
  if (source === "official-wecom") {
    return { doctorFixMode: "auto", preserveNetworkCompatibility: false, removeLegacyFieldAliases: true, preferOfflineDoctor: true };
  }
  if (source === "sunnoy-wecom") {
    return { doctorFixMode: "confirm", preserveNetworkCompatibility: true, removeLegacyFieldAliases: true, preferOfflineDoctor: false };
  }
  if (source === "legacy-openclaw-wechat") {
    return { doctorFixMode: "auto", preserveNetworkCompatibility: true, removeLegacyFieldAliases: true, preferOfflineDoctor: true };
  }
  if (source === "mixed-source") {
    return { doctorFixMode: "confirm", preserveNetworkCompatibility: true, removeLegacyFieldAliases: false, preferOfflineDoctor: true };
  }
  return { doctorFixMode: "off", preserveNetworkCompatibility: true, removeLegacyFieldAliases: false, preferOfflineDoctor: true };
}

function buildWecomSourcePlaceholderHint({ source = "fresh", selectedMode = WECOM_QUICKSTART_RECOMMENDED_MODE } = {}) {
  if (source === "official-wecom") {
    return {
      title: "替换官方来源占位项",
      detail: "先确认官方插件风格的扁平 Bot 配置已经归一化，再补齐 starter config 里的真实 BotID / Secret。",
    };
  }
  if (source === "sunnoy-wecom") {
    return {
      title: "替换 sunnoy 来源占位项",
      detail: "先确认 `network.egressProxyUrl / apiBaseUrl` 等兼容字段保留正确，再补齐 starter config 中的真实凭据。",
    };
  }
  if (source === "legacy-openclaw-wechat") {
    return {
      title: "替换 legacy 来源占位项",
      detail: "先审阅 legacy agent/bot 兼容块，再把 starter config 里的 CorpId / Secret / Token / AES Key 替换成真实值。",
    };
  }
  if (source === "mixed-source") {
    return {
      title: "替换 mixed-source 占位项",
      detail: "当前配置混合了多种来源字段，建议先跑 migrate/doctor 审阅 patch，再决定是否一次性替换所有占位项。",
    };
  }
  if (selectedMode === "agent_callback") {
    return {
      title: "替换 Agent 占位项",
      detail: "优先补齐 CorpId / Secret / AgentId / callback Token / AES Key，再做公网回调验证。",
    };
  }
  if (selectedMode === "hybrid") {
    return {
      title: "替换双通道占位项",
      detail: "优先补齐 Agent callback 和 Bot 长连接两套凭据，避免只配一半导致 hybrid 自检误报。",
    };
  }
  return {
    title: "替换 Bot 占位项",
    detail: "先补齐 Bot 长连接的 BotID / Secret，再继续运行 Bot 自检和长连接探针。",
  };
}

export function buildWecomSourcePlaybook({
  source = "fresh",
  selectedMode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  config = {},
  accountId = "default",
} = {}) {
  const capabilities = detectWecomAccountCapabilities(config, accountId);
  const checkOrder = buildWecomSourceCheckOrder({ source, capabilities, selectedMode });
  const repairDefaults = buildWecomSourceRepairDefaults({ source });
  const placeholderHint = buildWecomSourcePlaceholderHint({ source, selectedMode });
  const notes = [];
  if (source === "official-wecom") {
    notes.push("当前来源更接近官方插件，优先保留 Bot 长连接入口和扁平 Bot 兼容字段的迁移语义。");
  } else if (source === "sunnoy-wecom") {
    notes.push("当前来源更接近 sunnoy 配置，优先保留网络兼容字段和双通道能力，再决定是否自动修复。");
  } else if (source === "legacy-openclaw-wechat") {
    notes.push("当前来源更接近旧版 OpenClaw-Wechat，建议先审阅 legacy agent/bot 兼容块。");
  } else if (source === "mixed-source") {
    notes.push("当前配置混合了多种来源字段，建议优先审阅 migration patch，而不是直接覆盖配置。");
  }
  if (repairDefaults.doctorFixMode === "confirm") {
    notes.push("当前来源默认只给修复建议；若需要自动应用本地 patch，请显式确认 doctor --fix。");
  } else if (repairDefaults.doctorFixMode === "auto") {
    notes.push("当前来源默认允许自动附带 doctor --fix。");
  }
  return {
    source,
    capabilities,
    checkOrder,
    checkOrderSummary: checkOrder.map((item) => item.title).join(" -> "),
    repairDefaults,
    placeholderHint,
    notes,
  };
}

function resolveQuickstartSelection({
  mode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
} = {}) {
  const normalizedMode = String(mode ?? "").trim().toLowerCase();
  const normalizedGroupProfile =
    String(groupProfile ?? "").trim().toLowerCase() || WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE;
  const modeDefinition =
    QUICKSTART_MODE_DEFINITIONS[normalizedMode] ?? QUICKSTART_MODE_DEFINITIONS[WECOM_QUICKSTART_RECOMMENDED_MODE];
  const groupProfileDefinition =
    QUICKSTART_GROUP_PROFILE_DEFINITIONS[normalizedGroupProfile] ??
    QUICKSTART_GROUP_PROFILE_DEFINITIONS[WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE];
  return {
    modeDefinition,
    groupProfileDefinition,
  };
}

function collectQuickstartPlaceholders(value, path = "", out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectQuickstartPlaceholders(item, `${path}[${index}]`, out);
    });
    return out;
  }
  if (!value || typeof value !== "object") {
    const normalizedValue = typeof value === "string" ? String(value).trim() : value;
    for (const rule of QUICKSTART_PLACEHOLDER_RULES) {
      if (!rule.match({ path, value: normalizedValue })) continue;
      out.push({
        id: rule.id,
        path,
        label: rule.label,
        category: rule.category,
        currentValue: normalizedValue,
        action: rule.action,
      });
      break;
    }
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    collectQuickstartPlaceholders(child, childPath, out);
  }
  return out;
}

function uniquePaths(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function buildModeFirstRunGoal(modeDefinition) {
  if (modeDefinition?.id === "bot_long_connection") {
    return "先把 Bot 收消息、回消息和长连接健康跑通。";
  }
  if (modeDefinition?.id === "agent_callback") {
    return "先把自建应用 callback、主动发送和公网回调验证跑通。";
  }
  if (modeDefinition?.id === "hybrid") {
    return "先同时打通 Bot 对话入口和 Agent 主动发送链路。";
  }
  return "先把 WeCom 最小可用收发链路跑通。";
}

function buildModeRequiredAdminSteps(modeDefinition) {
  if (modeDefinition?.id === "bot_long_connection") {
    return [
      "在企业微信 Bot 后台启用长连接并拿到 BotID / Secret。",
    ];
  }
  if (modeDefinition?.id === "agent_callback") {
    return [
      "在企业微信自建应用后台配置回调 URL、Token 和 EncodingAESKey。",
      "为 callback 路径准备稳定公网入口并完成 URL 验证。",
    ];
  }
  if (modeDefinition?.id === "hybrid") {
    return [
      "在企业微信自建应用后台配置回调 URL、Token 和 EncodingAESKey。",
      "在企业微信 Bot 后台启用长连接并拿到 BotID / Secret。",
    ];
  }
  return [];
}

function buildModeSuccessChecks(modeDefinition) {
  return (modeDefinition?.checks ?? []).map((command, index) => ({
    id: `${modeDefinition?.id || "mode"}-check-${index + 1}`,
    command,
    summary: `检查 ${index + 1}: ${command}`,
  }));
}

function buildSetupChecklist({
  modeDefinition,
  groupProfileDefinition,
  accountId = "default",
  starterConfig,
  placeholders = [],
  groupChatId = "",
  groupAllow = [],
  sourcePlaybook = null,
} = {}) {
  const checklist = [];
  const warnings = [];
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountConfigPath =
    normalizedAccountId === "default" ? "channels.wecom" : `channels.wecom.accounts.${normalizedAccountId}`;
  const targetGroupChatId = String(groupChatId ?? "").trim();
  const normalizedGroupAllow = normalizeAllowList(groupAllow);

  if (placeholders.length > 0) {
    checklist.push({
      id: "fill-placeholders",
      kind: "edit",
      title: sourcePlaybook?.placeholderHint?.title || "替换模板占位项",
      detail:
        sourcePlaybook?.placeholderHint?.detail ||
        `当前 starter config 里还有 ${placeholders.length} 个待填字段。`,
      paths: placeholders.map((item) => item.path),
    });
  }

  if (modeDefinition?.requiresPublicWebhook) {
    checklist.push({
      id: "public-webhook",
      kind: "wecom-admin",
      title: "准备公网 callback",
      detail: `为 ${accountConfigPath}.webhookPath 准备稳定公网地址，并在企业微信后台完成 URL 验证。`,
      paths: [`${accountConfigPath}.webhookPath`],
    });
  } else {
    checklist.push({
      id: "no-public-webhook",
      kind: "note",
      title: "无需公网 callback",
      detail: "当前模式优先走 Bot 长连接，可先不准备公网回调地址。",
      paths: [],
    });
  }

  if (groupProfileDefinition?.id === "allowlist_template") {
    checklist.push({
      id: "group-allowlist",
      kind: "group-policy",
      title: "确认群白名单模板",
      detail: targetGroupChatId
        ? `已写入群 ${targetGroupChatId} 的 allowlist 模板，请确认成员列表和拒绝文案。`
        : "请把模板里的 wr-your-chat-id 和示例成员替换成真实群配置。",
      paths: [
        `${accountConfigPath}.groupPolicy`,
        `${accountConfigPath}.groupAllowFrom`,
        `${accountConfigPath}.groups`,
      ],
    });
    if (!targetGroupChatId) {
      warnings.push("群白名单模板仍使用默认 chatId，占位项需要替换。");
    }
    if (normalizedGroupAllow.length === 0) {
      warnings.push("群白名单模板仍使用示例成员 ops_lead/oncall_user，请替换成真实成员。");
    }
  }

  if (groupProfileDefinition?.id === "open_direct" && modeDefinition?.id === "bot_long_connection") {
    warnings.push("企业微信 Bot 群回调通常仍只支持 @ 触发；open_direct 更适合自建应用回调模式。");
  }

  const checkItems =
    Array.isArray(sourcePlaybook?.checkOrder) && sourcePlaybook.checkOrder.length > 0
      ? sourcePlaybook.checkOrder
      : (modeDefinition?.checks ?? []).map((command, index) => ({
          id: `mode-check-${index + 1}`,
          title: `运行体检 ${index + 1}`,
          detail: command,
          command,
        }));

  checkItems.forEach((item, index) => {
    checklist.push({
      id: `verify-${index + 1}`,
      kind: "verify",
      title: item.title || `运行体检 ${index + 1}`,
      detail: item.detail || item.command || `检查 ${index + 1}`,
      command: item.command,
      paths: [],
    });
  });

  return {
    checklist,
    warnings,
  };
}

function buildSetupActions({
  modeDefinition,
  groupProfileDefinition,
  accountId = "default",
  placeholders = [],
  groupChatId = "",
  commands = {},
  diagnostics = null,
  sourcePlaybook = null,
} = {}) {
  const actions = [];
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountConfigPath =
    normalizedAccountId === "default" ? "channels.wecom" : `channels.wecom.accounts.${normalizedAccountId}`;

  if (diagnostics?.installState === "stale_package") {
    actions.push({
      id: "upgrade-plugin-package",
      kind: "upgrade_package",
      title: "升级 npm 插件版本",
      detail: diagnostics.installStateSummary,
      paths: ["plugins.installs.openclaw-wechat.version"],
      command: "npm install @dingxiang-me/openclaw-wechat@latest",
      recommended: true,
      blocking: false,
    });
  }

  if (placeholders.length > 0) {
    actions.push({
      id: "fill-config-placeholders",
      kind: "fill_config",
      title: sourcePlaybook?.placeholderHint?.title || "替换 starter config 占位项",
      detail:
        sourcePlaybook?.placeholderHint?.detail ||
        `当前有 ${placeholders.length} 个待填字段，先补齐真实 CorpId / Secret / Token / AES Key。`,
      paths: uniquePaths(placeholders.map((item) => item.path)),
      command: commands.preview,
      recommended: true,
      blocking: true,
    });
  }

  if (sourcePlaybook?.source && !["fresh", "native-openclaw-wechat", "unknown"].includes(sourcePlaybook.source)) {
    actions.push({
      id: "review-source-playbook",
      kind: "review_setup_profile",
      title: "确认来源专属接入策略",
      detail: sourcePlaybook.checkOrderSummary || uniqueStrings(sourcePlaybook.notes ?? []).join(" "),
      paths: uniquePaths((diagnostics?.detectedLegacyFields ?? []).map((item) => item.path)),
      command: commands.migrate,
      recommended: true,
      blocking: diagnostics?.migrationState === "mixed_layout",
    });
  }

  if (modeDefinition?.requiresPublicWebhook) {
    actions.push({
      id: "configure-wecom-admin-callback",
      kind: "open_wecom_admin",
      title: "在企业微信后台配置回调",
      detail: `为 ${accountConfigPath}.webhookPath 配置稳定公网地址，并完成 URL 验证。`,
      paths: [`${accountConfigPath}.webhookPath`, `${accountConfigPath}.callbackToken`, `${accountConfigPath}.callbackAesKey`],
      command: "",
      recommended: true,
      blocking: true,
    });
  } else {
    actions.push({
      id: "collect-bot-longconn-credentials",
      kind: "open_wecom_admin",
      title: "在企业微信后台拿到 Bot 长连接凭据",
      detail: "确认机器人已开通长连接，并复制 BotID / Secret。",
      paths: [`${accountConfigPath}.bot.longConnection.botId`, `${accountConfigPath}.bot.longConnection.secret`],
      command: "",
      recommended: true,
      blocking: true,
    });
  }

  if (groupProfileDefinition?.id === "allowlist_template") {
    actions.push({
      id: "review-group-policy-template",
      kind: "fill_config",
      title: "确认群白名单模板",
      detail: groupChatId
        ? `确认群 ${groupChatId} 的 allowlist、触发方式和拒绝文案。`
        : "替换模板里的示例群 ChatId 和成员白名单。",
      paths: [
        `${accountConfigPath}.groupPolicy`,
        `${accountConfigPath}.groupAllowFrom`,
        `${accountConfigPath}.groups`,
      ],
      command: commands.preview,
      recommended: true,
      blocking: false,
    });
  }

  actions.push({
    id: "write-starter-config",
    kind: "write_patch",
    title: "写入 starter config",
    detail: "把生成的 starter config 合并进 openclaw.json。",
    paths: [accountConfigPath],
    command: commands.write,
    recommended: true,
    blocking: false,
  });

  if (Array.isArray(diagnostics?.envTemplate?.lines) && diagnostics.envTemplate.lines.length > 0) {
    actions.push({
      id: "set-wecom-env-template",
      kind: "set_env",
      title: "整理 WeCom 环境变量模板",
      detail: "将 Secret 和回调参数整理进 env.vars 或系统环境变量，减少 JSON 内联密钥。",
      paths: [],
      command: diagnostics.migrationCommand,
      recommended: false,
      blocking: false,
    });
  }

  const checkItems =
    Array.isArray(sourcePlaybook?.checkOrder) && sourcePlaybook.checkOrder.length > 0
      ? sourcePlaybook.checkOrder
      : (modeDefinition?.checks ?? []).map((command, index) => ({
          id: `mode-check-${index + 1}`,
          title: `运行体检 ${index + 1}`,
          detail: command,
          command,
        }));

  checkItems.forEach((item, index) => {
    actions.push({
      id: `run-check-${index + 1}`,
      kind: "run_check",
      title: item.title || `运行体检 ${index + 1}`,
      detail: item.detail || item.command || `检查 ${index + 1}`,
      paths: [],
      command: item.command,
      recommended: true,
      blocking: false,
    });
  });

  if (diagnostics?.migrationState === "legacy_config" || diagnostics?.migrationState === "mixed_layout") {
    const migrationTitle =
      diagnostics?.migrationSource === "official-wecom"
        ? "迁移官方 WeCom 插件配置"
        : diagnostics?.migrationSource === "sunnoy-wecom"
          ? "迁移 sunnoy WeCom 插件配置"
          : diagnostics?.migrationSource === "legacy-openclaw-wechat"
            ? "迁移 legacy OpenClaw-Wechat 配置"
            : diagnostics?.migrationSource === "mixed-source"
              ? "审阅 mixed-source WeCom 配置并迁移"
              : "迁移 legacy WeCom 配置";
    actions.push({
      id: "migrate-legacy-layout",
      kind: "apply_patch",
      title: migrationTitle,
      detail: [diagnostics?.migrationSourceSummary, diagnostics?.migrationStateSummary].filter(Boolean).join(" "),
      paths: uniquePaths((diagnostics.detectedLegacyFields ?? []).map((item) => item.path)),
      command: diagnostics.migrationCommand,
      recommended: true,
      blocking: diagnostics.migrationState === "mixed_layout",
    });
  }

  actions.push({
    id: "apply-repair-patch",
    kind: "apply_patch",
    title: "检查失败后应用 repair patch",
    detail: "若 selfcheck 失败，可预览并应用自动生成的 repair patch。",
    paths: [accountConfigPath],
    command: commands.confirmRepair,
    recommended: false,
    blocking: false,
  });

  actions.push({
    id: "restart-openclaw-gateway",
    kind: "restart_gateway",
    title: "重启 OpenClaw gateway",
    detail: "写完配置或应用迁移 patch 后，重启 gateway 让新配置生效。",
    paths: [],
    command: "openclaw gateway restart",
    recommended: true,
    blocking: false,
  });

  return actions;
}

export const WECOM_QUICKSTART_MODES = Object.freeze(
  Object.values(QUICKSTART_MODE_DEFINITIONS).map((mode) =>
    Object.freeze({
      id: mode.id,
      label: mode.label,
      recommended: mode.recommended,
      requiresPublicWebhook: mode.requiresPublicWebhook,
      supportsPairing: mode.supportsPairing,
      docsAnchor: mode.docsAnchor,
      summary: mode.summary,
      firstRunGoal: buildModeFirstRunGoal(mode),
      requiredAdminSteps: Object.freeze(buildModeRequiredAdminSteps(mode)),
      successChecks: Object.freeze(buildModeSuccessChecks(mode)),
      requiredConfigPaths: Object.freeze([...mode.requiredConfigPaths]),
      checks: Object.freeze([...mode.checks]),
      notes: Object.freeze([...mode.notes]),
    }),
  ),
);

export const WECOM_QUICKSTART_GROUP_PROFILES = Object.freeze(
  Object.values(QUICKSTART_GROUP_PROFILE_DEFINITIONS).map((profile) =>
    Object.freeze({
      id: profile.id,
      label: profile.label,
      summary: profile.summary,
      recommendedForModes: Object.freeze([...(profile.recommendedForModes ?? [])]),
      notes: Object.freeze([...(profile.notes ?? [])]),
    }),
  ),
);

export function listWecomQuickstartModes() {
  return WECOM_QUICKSTART_MODES.map((mode) => ({
    ...mode,
    requiredAdminSteps: [...mode.requiredAdminSteps],
    successChecks: mode.successChecks.map((item) => ({ ...item })),
    requiredConfigPaths: [...mode.requiredConfigPaths],
    checks: [...mode.checks],
    notes: [...mode.notes],
  }));
}

export function listWecomQuickstartGroupProfiles() {
  return WECOM_QUICKSTART_GROUP_PROFILES.map((profile) => ({
    ...profile,
    recommendedForModes: [...profile.recommendedForModes],
    notes: [...profile.notes],
  }));
}

export function buildWecomQuickstartConfig({
  mode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  accountId = "default",
  dmMode = "pairing",
  groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  groupChatId = "",
  groupAllow = [],
} = {}) {
  const { modeDefinition: definition, groupProfileDefinition } = resolveQuickstartSelection({
    mode,
    groupProfile,
  });
  const starterConfig = deepClone(definition.buildConfig({ accountId, dmMode }));
  const targetAccountConfig = resolveStarterAccountConfig(starterConfig, accountId);
  if (targetAccountConfig && groupProfileDefinition) {
    const patch = groupProfileDefinition.buildPatch({
      mode: definition.id,
      accountId,
      dmMode,
      groupChatId,
      groupAllow,
    });
    const merged = mergeDeep(targetAccountConfig, patch);
    for (const key of Object.keys(targetAccountConfig)) {
      delete targetAccountConfig[key];
    }
    Object.assign(targetAccountConfig, merged);
  }
  return starterConfig;
}

export function buildWecomQuickstartSetupPlan({
  mode = WECOM_QUICKSTART_RECOMMENDED_MODE,
  accountId = "default",
  dmMode = "pairing",
  groupProfile = WECOM_QUICKSTART_DEFAULT_GROUP_PROFILE,
  groupChatId = "",
  groupAllow = [],
  currentConfig = {},
} = {}) {
  const { modeDefinition, groupProfileDefinition } = resolveQuickstartSelection({
    mode,
    groupProfile,
  });
  const starterConfig = buildWecomQuickstartConfig({
    mode: modeDefinition.id,
    accountId,
    dmMode,
    groupProfile: groupProfileDefinition.id,
    groupChatId,
    groupAllow,
  });
  const placeholders = collectQuickstartPlaceholders(starterConfig);
  const diagnostics = collectWecomMigrationDiagnostics({
    config: asObject(currentConfig),
    accountId,
  });
  const sourcePlaybook = buildWecomSourcePlaybook({
    source: diagnostics.migrationSource,
    selectedMode: modeDefinition.id,
    config: mergeDeep(asObject(currentConfig), starterConfig),
    accountId,
  });
  const { checklist, warnings } = buildSetupChecklist({
    modeDefinition,
    groupProfileDefinition,
    accountId,
    starterConfig,
    placeholders,
    groupChatId,
    groupAllow,
    sourcePlaybook,
  });
  const commands = {
    preview: WECOM_QUICKSTART_SETUP_COMMAND,
    runChecks: WECOM_QUICKSTART_RUN_CHECKS_COMMAND,
    forceChecks: WECOM_QUICKSTART_FORCE_CHECKS_COMMAND,
    applyRepair: WECOM_QUICKSTART_APPLY_REPAIR_COMMAND,
    confirmRepair: WECOM_QUICKSTART_CONFIRM_REPAIR_COMMAND,
    migrate: WECOM_QUICKSTART_MIGRATION_COMMAND,
    wizard: WECOM_QUICKSTART_WIZARD_COMMAND,
    write: WECOM_QUICKSTART_WRITE_COMMAND,
  };
  const actions = buildSetupActions({
    modeDefinition,
    groupProfileDefinition,
    accountId,
    placeholders,
    groupChatId,
    commands,
    diagnostics,
    sourcePlaybook,
  });

  if (sourcePlaybook?.repairDefaults?.doctorFixMode === "confirm") {
    warnings.push("当前来源默认只给修复建议；若需要自动应用本地 patch，请显式确认 doctor --fix / confirm-repair。");
  }
  if (sourcePlaybook?.source === "mixed-source") {
    warnings.push("当前配置混合了多种来源字段，建议优先审阅 migration patch，再决定是否直接覆盖 starter config。");
  }

  return {
    mode: {
      id: modeDefinition.id,
      label: modeDefinition.label,
      requiresPublicWebhook: modeDefinition.requiresPublicWebhook,
      summary: modeDefinition.summary,
      firstRunGoal: buildModeFirstRunGoal(modeDefinition),
      requiredAdminSteps: buildModeRequiredAdminSteps(modeDefinition),
      successChecks: buildModeSuccessChecks(modeDefinition),
    },
    groupProfile: {
      id: groupProfileDefinition.id,
      label: groupProfileDefinition.label,
      summary: groupProfileDefinition.summary,
    },
    accountId: normalizeAccountId(accountId),
    dmMode: String(dmMode ?? "pairing").trim().toLowerCase() || "pairing",
    installState: diagnostics.installState,
    installStateSummary: diagnostics.installStateSummary,
    migrationState: diagnostics.migrationState,
    migrationStateSummary: diagnostics.migrationStateSummary,
    migrationSource: diagnostics.migrationSource,
    migrationSourceSummary: diagnostics.migrationSourceSummary,
    migrationSourceSignals: diagnostics.migrationSourceSignals,
    detectedLegacyFields: diagnostics.detectedLegacyFields,
    migration: {
      source: diagnostics.migrationSource,
      sourceSummary: diagnostics.migrationSourceSummary,
      sourceSignals: diagnostics.migrationSourceSignals,
      command: diagnostics.migrationCommand,
      recommendedActions: diagnostics.recommendedActions,
      configPatch: diagnostics.configPatch,
      envTemplate: diagnostics.envTemplate,
    },
    sourcePlaybook,
    commands,
    actions,
    starterConfig,
    placeholders,
    checklist,
    warnings,
  };
}
