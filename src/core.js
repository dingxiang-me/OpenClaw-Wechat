import crypto from "node:crypto";
import { buildDefaultBotWebhookPath } from "./wecom/account-paths.js";
import { resolveWecomApiBaseUrl } from "./wecom/network-config.js";

export { resolveWecomApiBaseUrl } from "./wecom/network-config.js";

export const WECOM_TEXT_BYTE_LIMIT = 2000;
export const INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;
const FALSE_LIKE_VALUES = new Set(["0", "false", "off", "no"]);
const TRUE_LIKE_VALUES = new Set(["1", "true", "on", "yes"]);
const LOCAL_STT_DIRECT_SUPPORTED_CONTENT_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "audio/x-flac",
]);
const AUDIO_CONTENT_TYPE_TO_EXTENSION = Object.freeze({
  "audio/amr": ".amr",
  "audio/flac": ".flac",
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/silk": ".sil",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
  "audio/x-flac": ".flac",
});
const DEFAULT_COMMAND_ALLOWLIST = Object.freeze([
  "/help",
  "/status",
  "/clear",
  "/reset",
  "/new",
  "/compact",
]);
const DEFAULT_ALLOW_FROM_REJECT_MESSAGE = "当前账号未授权，请联系管理员。";
const DEFAULT_EVENT_ENTER_AGENT_WELCOME_TEXT = "你好，我是 AI 助手，直接发消息即可开始对话。";
const DEFAULT_DELIVERY_FALLBACK_ORDER = Object.freeze([
  "long_connection",
  "active_stream",
  "response_url",
  "webhook_bot",
  "agent_push",
]);
const DEFAULT_BOT_CARD_MODE = "markdown";
const BOT_CARD_MODE_SET = new Set(["markdown", "template_card"]);
const DELIVERY_FALLBACK_LAYER_SET = new Set(DEFAULT_DELIVERY_FALLBACK_ORDER);
const DELIVERY_REASONING_MODE_SET = new Set(["separate", "append", "hidden"]);
const DELIVERY_REPLY_FORMAT_SET = new Set(["auto", "text", "markdown"]);
const DYNAMIC_AGENT_MAP_SPLITTER = /[,\n]/;
const GROUP_CHAT_TRIGGER_MODE_SET = new Set(["direct", "mention", "keyword"]);
const GROUP_POLICY_MODE_SET = new Set(["open", "allowlist", "deny", "disabled"]);
const DM_POLICY_MODE_SET = new Set(["open", "allowlist", "pairing", "deny"]);
const DYNAMIC_AGENT_MODE_SET = new Set(["mapping", "deterministic", "hybrid"]);
const DYNAMIC_AGENT_ID_STRATEGY_SET = new Set(["readable-hash"]);
const LEGACY_INLINE_ACCOUNT_RESERVED_KEYS = new Set([
  "name",
  "enabled",
  "botId",
  "botid",
  "secret",
  "corpId",
  "corpSecret",
  "agentId",
  "callbackToken",
  "token",
  "callbackAesKey",
  "encodingAesKey",
  "webhookPath",
  "outboundProxy",
  "proxyUrl",
  "proxy",
  "network",
  "apiBaseUrl",
  "webhooks",
  "allowFrom",
  "allowFromRejectMessage",
  "groupPolicy",
  "groupAllowFrom",
  "groupAllowFromRejectMessage",
  "rejectUnauthorizedMessage",
  "adminUsers",
  "commandAllowlist",
  "commandBlockMessage",
  "commands",
  "workspaceTemplate",
  "groupChat",
  "groups",
  "dynamicAgent",
  "dynamicAgents",
  "dm",
  "debounce",
  "streaming",
  "bot",
  "delivery",
  "webhookBot",
  "stream",
  "observability",
  "voiceTranscription",
  "defaultAccount",
  "tools",
  "accounts",
  "agent",
]);

const inboundMessageDedupe = new Map();

export function buildWecomSessionId(userId, accountId = "default") {
  const normalizedUserId = String(userId ?? "").trim().toLowerCase();
  const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
  if (normalizedAccountId === "default") {
    return `wecom:${normalizedUserId}`;
  }
  return `wecom:${normalizedAccountId}:${normalizedUserId}`;
}

export function buildInboundDedupeKey(msgObj, namespace = "default") {
  const ns = String(namespace ?? "default").trim().toLowerCase() || "default";
  const msgId = String(msgObj?.MsgId ?? "").trim();
  if (msgId) return `${ns}:id:${msgId}`;
  const fromUser = String(msgObj?.FromUserName ?? "").trim().toLowerCase();
  const createTime = String(msgObj?.CreateTime ?? "").trim();
  const msgType = String(msgObj?.MsgType ?? "").trim().toLowerCase();
  const stableHint = String(
    msgObj?.Content ?? msgObj?.MediaId ?? msgObj?.EventKey ?? msgObj?.Event ?? "",
  )
    .trim()
    .slice(0, 160);
  if (!fromUser && !createTime && !msgType && !stableHint) return null;
  return `${ns}:${fromUser}|${createTime}|${msgType}|${stableHint}`;
}

export function markInboundMessageSeen(msgObj, namespace = "default") {
  const dedupeKey = buildInboundDedupeKey(msgObj, namespace);
  if (!dedupeKey) return true;

  const now = Date.now();
  for (const [key, expiresAt] of inboundMessageDedupe) {
    if (expiresAt <= now) inboundMessageDedupe.delete(key);
  }

  const existingExpiry = inboundMessageDedupe.get(dedupeKey);
  if (typeof existingExpiry === "number" && existingExpiry > now) return false;

  inboundMessageDedupe.set(dedupeKey, now + INBOUND_DEDUPE_TTL_MS);
  return true;
}

export function resetInboundMessageDedupeForTests() {
  inboundMessageDedupe.clear();
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return sha1(arr.join(""));
}

export function getByteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

export function splitWecomText(text, byteLimit = WECOM_TEXT_BYTE_LIMIT) {
  if (getByteLength(text) <= byteLimit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (getByteLength(remaining) <= byteLimit) {
      chunks.push(remaining);
      break;
    }

    let low = 1;
    let high = remaining.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (getByteLength(remaining.slice(0, mid)) <= byteLimit) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    let splitIndex = low;

    const searchStart = Math.max(0, splitIndex - 200);
    const searchText = remaining.slice(searchStart, splitIndex);

    let naturalBreak = searchText.lastIndexOf("\n\n");
    if (naturalBreak === -1) {
      naturalBreak = searchText.lastIndexOf("\n");
    }
    if (naturalBreak === -1) {
      naturalBreak = searchText.lastIndexOf("。");
      if (naturalBreak !== -1) naturalBreak += 1;
    }
    if (naturalBreak !== -1 && naturalBreak > 0) {
      splitIndex = searchStart + naturalBreak;
    }

    if (splitIndex <= 0) {
      splitIndex = Math.min(remaining.length, Math.floor(byteLimit / 3));
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export function pickAccountBySignature({ accounts, msgSignature, timestamp, nonce, encrypt }) {
  if (!msgSignature || !encrypt) return null;
  for (const account of accounts) {
    if (!account?.callbackToken || !account?.callbackAesKey) continue;
    const expected = computeMsgSignature({
      token: account.callbackToken,
      timestamp,
      nonce,
      encrypt,
    });
    if (expected === msgSignature) return account;
  }
  return null;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeAccountIdForEnv(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function resolveLegacyInlineAccountConfig(channelConfig, accountId) {
  if (!channelConfig || typeof channelConfig !== "object") return null;
  const normalizedAccountId = normalizeAccountIdForEnv(accountId);
  for (const [key, value] of Object.entries(channelConfig)) {
    const normalizedKey = normalizeAccountIdForEnv(key);
    if (LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(normalizedKey)) continue;
    if (normalizedKey !== normalizedAccountId) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    return value;
  }
  return null;
}

function collectLegacyInlineAccountIds(channelConfig) {
  if (!channelConfig || typeof channelConfig !== "object") return [];
  const ids = [];
  for (const [key, value] of Object.entries(channelConfig)) {
    const normalizedKey = normalizeAccountIdForEnv(key);
    if (!normalizedKey) continue;
    if (LEGACY_INLINE_ACCOUNT_RESERVED_KEYS.has(normalizedKey)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    ids.push(normalizedKey);
  }
  return Array.from(new Set(ids));
}

function readAllowFromEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedAllowFromKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_ALLOW_FROM`;
  const scoped = parseStringList(
    scopedAllowFromKey ? envVars?.[scopedAllowFromKey] : undefined,
    scopedAllowFromKey ? processEnv?.[scopedAllowFromKey] : undefined,
  );
  if (scoped.length > 0) return scoped;
  return parseStringList(envVars?.WECOM_ALLOW_FROM, processEnv?.WECOM_ALLOW_FROM);
}

function readAllowFromRejectMessageEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedRejectMessageKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_ALLOW_FROM_REJECT_MESSAGE`;
  return pickFirstNonEmptyString(
    scopedRejectMessageKey ? envVars?.[scopedRejectMessageKey] : undefined,
    scopedRejectMessageKey ? processEnv?.[scopedRejectMessageKey] : undefined,
    envVars?.WECOM_ALLOW_FROM_REJECT_MESSAGE,
    processEnv?.WECOM_ALLOW_FROM_REJECT_MESSAGE,
  );
}

function readGroupAllowFromEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedAllowFromKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_GROUP_ALLOW_FROM`;
  const scoped = parseStringList(
    scopedAllowFromKey ? envVars?.[scopedAllowFromKey] : undefined,
    scopedAllowFromKey ? processEnv?.[scopedAllowFromKey] : undefined,
  );
  if (scoped.length > 0) return scoped;
  return parseStringList(envVars?.WECOM_GROUP_ALLOW_FROM, processEnv?.WECOM_GROUP_ALLOW_FROM);
}

function readGroupPolicyEnv(envVars, processEnv, accountId = "default") {
  const scopedAccountId = String(accountId ?? "default")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  return pickFirstNonEmptyString(
    envVars?.[`WECOM_${scopedAccountId}_GROUP_POLICY`],
    processEnv?.[`WECOM_${scopedAccountId}_GROUP_POLICY`],
    envVars?.WECOM_GROUP_POLICY,
    processEnv?.WECOM_GROUP_POLICY,
  );
}

function readGroupAllowFromRejectMessageEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedRejectMessageKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_GROUP_ALLOW_FROM_REJECT_MESSAGE`;
  const scopedGroupRejectMessageKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_GROUP_REJECT_MESSAGE`;
  return pickFirstNonEmptyString(
    scopedRejectMessageKey ? envVars?.[scopedRejectMessageKey] : undefined,
    scopedRejectMessageKey ? processEnv?.[scopedRejectMessageKey] : undefined,
    scopedGroupRejectMessageKey ? envVars?.[scopedGroupRejectMessageKey] : undefined,
    scopedGroupRejectMessageKey ? processEnv?.[scopedGroupRejectMessageKey] : undefined,
    envVars?.WECOM_GROUP_ALLOW_FROM_REJECT_MESSAGE,
    processEnv?.WECOM_GROUP_ALLOW_FROM_REJECT_MESSAGE,
    envVars?.WECOM_GROUP_REJECT_MESSAGE,
    processEnv?.WECOM_GROUP_REJECT_MESSAGE,
  );
}

function readDmPolicyModeEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedDmPolicyKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_DM_POLICY`;
  const scopedDmModeKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_DM_MODE`;
  return pickFirstNonEmptyString(
    scopedDmPolicyKey ? envVars?.[scopedDmPolicyKey] : undefined,
    scopedDmPolicyKey ? processEnv?.[scopedDmPolicyKey] : undefined,
    scopedDmModeKey ? envVars?.[scopedDmModeKey] : undefined,
    scopedDmModeKey ? processEnv?.[scopedDmModeKey] : undefined,
    envVars?.WECOM_DM_POLICY,
    processEnv?.WECOM_DM_POLICY,
    envVars?.WECOM_DM_MODE,
    processEnv?.WECOM_DM_MODE,
  );
}

function readDmAllowFromEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedAllowFromKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_DM_ALLOW_FROM`;
  const scoped = parseStringList(
    scopedAllowFromKey ? envVars?.[scopedAllowFromKey] : undefined,
    scopedAllowFromKey ? processEnv?.[scopedAllowFromKey] : undefined,
  );
  if (scoped.length > 0) return scoped;
  return parseStringList(envVars?.WECOM_DM_ALLOW_FROM, processEnv?.WECOM_DM_ALLOW_FROM);
}

function readDmRejectMessageEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedRejectMessageKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_DM_REJECT_MESSAGE`;
  return pickFirstNonEmptyString(
    scopedRejectMessageKey ? envVars?.[scopedRejectMessageKey] : undefined,
    scopedRejectMessageKey ? processEnv?.[scopedRejectMessageKey] : undefined,
    envVars?.WECOM_DM_REJECT_MESSAGE,
    processEnv?.WECOM_DM_REJECT_MESSAGE,
  );
}

function readEventEnabledEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedEnabledKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENT_ENABLED`;
  const scopedEventsEnabledKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENTS_ENABLED`;
  return pickFirstNonEmptyString(
    scopedEnabledKey ? envVars?.[scopedEnabledKey] : undefined,
    scopedEnabledKey ? processEnv?.[scopedEnabledKey] : undefined,
    scopedEventsEnabledKey ? envVars?.[scopedEventsEnabledKey] : undefined,
    scopedEventsEnabledKey ? processEnv?.[scopedEventsEnabledKey] : undefined,
    envVars?.WECOM_EVENT_ENABLED,
    processEnv?.WECOM_EVENT_ENABLED,
    envVars?.WECOM_EVENTS_ENABLED,
    processEnv?.WECOM_EVENTS_ENABLED,
  );
}

function readEventEnterAgentWelcomeEnabledEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedEnabledKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENT_ENTER_AGENT_WELCOME_ENABLED`;
  const scopedEventsEnabledKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENTS_ENTER_AGENT_WELCOME_ENABLED`;
  return pickFirstNonEmptyString(
    scopedEnabledKey ? envVars?.[scopedEnabledKey] : undefined,
    scopedEnabledKey ? processEnv?.[scopedEnabledKey] : undefined,
    scopedEventsEnabledKey ? envVars?.[scopedEventsEnabledKey] : undefined,
    scopedEventsEnabledKey ? processEnv?.[scopedEventsEnabledKey] : undefined,
    envVars?.WECOM_EVENT_ENTER_AGENT_WELCOME_ENABLED,
    processEnv?.WECOM_EVENT_ENTER_AGENT_WELCOME_ENABLED,
    envVars?.WECOM_EVENTS_ENTER_AGENT_WELCOME_ENABLED,
    processEnv?.WECOM_EVENTS_ENTER_AGENT_WELCOME_ENABLED,
  );
}

function readEventEnterAgentWelcomeTextEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedTextKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENT_ENTER_AGENT_WELCOME_TEXT`;
  const scopedEventsTextKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EVENTS_ENTER_AGENT_WELCOME_TEXT`;
  return pickFirstNonEmptyString(
    scopedTextKey ? envVars?.[scopedTextKey] : undefined,
    scopedTextKey ? processEnv?.[scopedTextKey] : undefined,
    scopedEventsTextKey ? envVars?.[scopedEventsTextKey] : undefined,
    scopedEventsTextKey ? processEnv?.[scopedEventsTextKey] : undefined,
    envVars?.WECOM_EVENT_ENTER_AGENT_WELCOME_TEXT,
    processEnv?.WECOM_EVENT_ENTER_AGENT_WELCOME_TEXT,
    envVars?.WECOM_EVENTS_ENTER_AGENT_WELCOME_TEXT,
    processEnv?.WECOM_EVENTS_ENTER_AGENT_WELCOME_TEXT,
  );
}

function readProxyEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedProxyKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_PROXY`;
  const scopedEgressProxyKey =
    normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_EGRESS_PROXY_URL`;
  return pickFirstNonEmptyString(
    scopedEgressProxyKey ? envVars?.[scopedEgressProxyKey] : undefined,
    scopedEgressProxyKey ? processEnv?.[scopedEgressProxyKey] : undefined,
    scopedProxyKey ? envVars?.[scopedProxyKey] : undefined,
    scopedProxyKey ? processEnv?.[scopedProxyKey] : undefined,
    envVars?.WECOM_EGRESS_PROXY_URL,
    processEnv?.WECOM_EGRESS_PROXY_URL,
    envVars?.WECOM_PROXY,
    processEnv?.WECOM_PROXY,
    processEnv?.HTTPS_PROXY,
    processEnv?.HTTP_PROXY,
  );
}

export function resolveWecomProxyConfig({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
} = {}) {
  const fromAccountConfig = pickFirstNonEmptyString(
    accountConfig?.outboundProxy,
    accountConfig?.proxyUrl,
    accountConfig?.proxy,
    accountConfig?.network?.egressProxyUrl,
    accountConfig?.network?.proxyUrl,
    accountConfig?.network?.proxy,
  );
  const fromChannelConfig = pickFirstNonEmptyString(
    channelConfig?.outboundProxy,
    channelConfig?.proxyUrl,
    channelConfig?.proxy,
    channelConfig?.network?.egressProxyUrl,
    channelConfig?.network?.proxyUrl,
    channelConfig?.network?.proxy,
  );
  const fromEnv = readProxyEnv(envVars, processEnv, accountId);
  const resolved = pickFirstNonEmptyString(fromAccountConfig, fromChannelConfig, fromEnv);
  return resolved || undefined;
}

function asPositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asBoundedPositiveInteger(value, fallback, minimum, maximum) {
  const n = asPositiveInteger(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minimum, Math.min(maximum, n));
}

function parseBooleanLike(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_LIKE_VALUES.has(normalized)) return true;
  if (FALSE_LIKE_VALUES.has(normalized)) return false;
  return fallback;
}

function parseStringList(...values) {
  const out = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const trimmed = String(item ?? "").trim();
        if (trimmed) out.push(trimmed);
      }
      continue;
    }
    if (typeof value === "string") {
      for (const part of value.split(/[,\n]/)) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out;
}

function normalizeDynamicAgentMapKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseDynamicAgentMap(...values) {
  const out = {};
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const key = normalizeDynamicAgentMapKey(item.key ?? item.from ?? item.id ?? item.user ?? item.chat);
        const agentId = String(item.agentId ?? item.agent ?? item.to ?? "").trim();
        if (key && agentId) out[key] = agentId;
      }
      continue;
    }
    if (typeof value === "object") {
      for (const [rawKey, rawAgentId] of Object.entries(value)) {
        const key = normalizeDynamicAgentMapKey(rawKey);
        const agentId = String(rawAgentId ?? "").trim();
        if (key && agentId) out[key] = agentId;
      }
      continue;
    }
    if (typeof value !== "string") continue;
    const tokens = value.split(DYNAMIC_AGENT_MAP_SPLITTER);
    for (const token of tokens) {
      const trimmed = String(token ?? "").trim();
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf("=");
      const colonIndex = trimmed.indexOf(":");
      let sepIndex = -1;
      if (eqIndex >= 0 && colonIndex >= 0) sepIndex = Math.min(eqIndex, colonIndex);
      else sepIndex = Math.max(eqIndex, colonIndex);
      if (sepIndex <= 0 || sepIndex >= trimmed.length - 1) continue;
      const key = normalizeDynamicAgentMapKey(trimmed.slice(0, sepIndex));
      const agentId = String(trimmed.slice(sepIndex + 1)).trim();
      if (key && agentId) out[key] = agentId;
    }
  }
  return out;
}

function uniqueLowerCaseList(values) {
  const deduped = new Set();
  for (const raw of values) {
    const normalized = String(raw ?? "").trim().toLowerCase();
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

function normalizeCommandToken(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function uniqueCommandList(values) {
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeCommandToken(value);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

function normalizeDeliveryLayerToken(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (!normalized) return "";
  if (normalized === "active" || normalized === "stream" || normalized === "active_stream") {
    return "active_stream";
  }
  if (
    normalized === "longconnection" ||
    normalized === "long_connection" ||
    normalized === "ws" ||
    normalized === "websocket"
  ) {
    return "long_connection";
  }
  if (normalized === "responseurl" || normalized === "response_url") {
    return "response_url";
  }
  if (normalized === "webhook" || normalized === "webhookbot" || normalized === "webhook_bot") {
    return "webhook_bot";
  }
  if (normalized === "agent" || normalized === "agentpush" || normalized === "agent_push") {
    return "agent_push";
  }
  return normalized;
}

function uniqueDeliveryFallbackOrder(values) {
  const deduped = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeDeliveryLayerToken(value);
    if (!normalized || !DELIVERY_FALLBACK_LAYER_SET.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeWecomBotCardMode(value, fallback = DEFAULT_BOT_CARD_MODE) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "template-card" || normalized === "templatecard") return "template_card";
  if (BOT_CARD_MODE_SET.has(normalized)) return normalized;
  return fallback;
}

function normalizeWecomDmPolicyMode(value, fallback = "open") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "closed" || normalized === "close") return "deny";
  if (normalized === "disabled") return "deny";
  if (normalized === "whitelist") return "allowlist";
  if (DM_POLICY_MODE_SET.has(normalized)) return normalized;
  return fallback;
}

export function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

export function normalizeWecomWebhookTargetAlias(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeWecomWebhookTargetMap(...values) {
  const out = {};
  const assignEntry = (rawAlias, rawTarget) => {
    const alias = normalizeWecomWebhookTargetAlias(rawAlias);
    const target = String(rawTarget ?? "").trim();
    if (!alias || !target) return;
    out[alias] = target;
  };

  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [rawAlias, rawTarget] of Object.entries(parsed)) {
              assignEntry(rawAlias, rawTarget);
            }
            continue;
          }
        } catch {
          // fall through to key=value parser
        }
      }
      for (const token of trimmed.split(/[,\n;]/)) {
        const pair = String(token ?? "").trim();
        if (!pair) continue;
        const eqIndex = pair.indexOf("=");
        if (eqIndex <= 0 || eqIndex >= pair.length - 1) continue;
        const alias = pair.slice(0, eqIndex);
        const target = pair.slice(eqIndex + 1);
        assignEntry(alias, target);
      }
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [rawAlias, rawTarget] of Object.entries(value)) {
        assignEntry(rawAlias, rawTarget);
      }
    }
  }

  return out;
}

export function resolveWecomWebhookTargetConfig(rawWebhook, webhookTargets = {}) {
  const targetMap = normalizeWecomWebhookTargetMap(webhookTargets);
  let current = String(rawWebhook ?? "").trim();
  if (!current) return null;

  const visitedAliases = new Set();
  for (let depth = 0; depth < 8; depth++) {
    if (/^key:/i.test(current)) {
      const key = current.replace(/^key:/i, "").trim();
      return key ? { key } : null;
    }
    if (/^https?:\/\//i.test(current)) {
      return { url: current };
    }
    const alias = normalizeWecomWebhookTargetAlias(current);
    const mapped = alias ? String(targetMap[alias] ?? "").trim() : "";
    if (mapped) {
      if (visitedAliases.has(alias)) return null;
      visitedAliases.add(alias);
      current = mapped;
      continue;
    }
    return { key: current };
  }
  return null;
}

export function resolveWecomTarget(rawTarget) {
  const raw = String(rawTarget ?? "").trim();
  if (!raw) return null;

  if (/^webhook:/i.test(raw)) {
    const webhook = raw.replace(/^webhook:/i, "").trim();
    return webhook ? { webhook } : null;
  }

  let clean = raw.replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "").trim();
  if (!clean) return null;

  if (/^party:/i.test(clean) || /^dept:/i.test(clean)) {
    const toParty = clean.replace(/^(party|dept):/i, "").trim();
    return toParty ? { toParty } : null;
  }
  if (/^tag:/i.test(clean)) {
    const toTag = clean.replace(/^tag:/i, "").trim();
    return toTag ? { toTag } : null;
  }
  if (/^(group|chat):/i.test(clean)) {
    const chatId = clean.replace(/^(group|chat):/i, "").trim();
    return chatId ? { chatId } : null;
  }
  if (/^user:/i.test(clean)) {
    const toUser = clean.replace(/^user:/i, "").trim();
    return toUser ? { toUser } : null;
  }

  if (/^(wr|wc)/i.test(clean)) {
    return { chatId: clean };
  }
  if (/^\d+$/.test(clean)) {
    return { toParty: clean };
  }
  return { toUser: clean };
}

function uniqueAllowFromList(values) {
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeWecomAllowFromEntry(value);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

function asConfigObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pickFirstStringList(...values) {
  for (const value of values) {
    const parsed = parseStringList(value);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function pickFirstStringListWithSource(entries = [], fallbackSource = "") {
  for (const entry of entries) {
    const parsed = parseStringList(entry?.value);
    if (parsed.length > 0) {
      return {
        values: parsed,
        source: String(entry?.source ?? "").trim() || fallbackSource,
      };
    }
  }
  return {
    values: [],
    source: fallbackSource,
  };
}

function pickFirstNonEmptyStringWithSource(entries = [], fallbackValue = "", fallbackSource = "default") {
  for (const entry of entries) {
    const text = String(entry?.value ?? "").trim();
    if (!text) continue;
    return {
      value: text,
      source: String(entry?.source ?? "").trim() || fallbackSource,
    };
  }
  return {
    value: String(fallbackValue ?? "").trim(),
    source: fallbackSource,
  };
}

function hasExplicitConfigValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return true;
  return String(value ?? "").trim().length > 0;
}

function resolveBooleanLike(values, fallback) {
  let resolved = fallback;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    resolved = parseBooleanLike(values[index], resolved);
  }
  return resolved;
}

function lookupWecomGroupOverrideConfig(groupsConfig, chatId = "") {
  const normalizedChatId = String(chatId ?? "").trim();
  const groups = asConfigObject(groupsConfig);
  if (!normalizedChatId || Object.keys(groups).length === 0) return {};
  const direct = groups[normalizedChatId];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }
  const normalizedLookup = normalizedChatId.toLowerCase();
  for (const [rawChatId, value] of Object.entries(groups)) {
    if (String(rawChatId ?? "").trim().toLowerCase() !== normalizedLookup) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    return value;
  }
  return {};
}

function collectConfiguredGroupIds(...values) {
  const ids = new Set();
  for (const value of values) {
    const groups = asConfigObject(value);
    for (const [rawChatId, entry] of Object.entries(groups)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const normalizedChatId = String(rawChatId ?? "").trim();
      if (normalizedChatId) ids.add(normalizedChatId);
    }
  }
  return Array.from(ids);
}

function resolveGroupScopedTriggerMode(scopeConfigs = [], envVars = {}, processEnv = process.env) {
  for (const scopeConfig of scopeConfigs) {
    const scope = asConfigObject(scopeConfig);
    const triggerModeRaw = String(scope.triggerMode ?? "")
      .trim()
      .toLowerCase();
    if (GROUP_CHAT_TRIGGER_MODE_SET.has(triggerModeRaw)) {
      return triggerModeRaw;
    }
    const requireMention = parseBooleanLike(scope.requireMention, null);
    if (requireMention === true) return "mention";
    if (requireMention === false) return "direct";
  }

  const envTriggerModeRaw = pickFirstNonEmptyString(
    envVars?.WECOM_GROUP_CHAT_TRIGGER_MODE,
    processEnv?.WECOM_GROUP_CHAT_TRIGGER_MODE,
  )
    .trim()
    .toLowerCase();
  if (GROUP_CHAT_TRIGGER_MODE_SET.has(envTriggerModeRaw)) {
    return envTriggerModeRaw;
  }
  const envRequireMention = resolveBooleanLike(
    [envVars?.WECOM_GROUP_CHAT_REQUIRE_MENTION, processEnv?.WECOM_GROUP_CHAT_REQUIRE_MENTION],
    false,
  );
  return envRequireMention ? "mention" : "direct";
}

function resolveGroupScopedTriggerDetails(scopeEntries = [], envVars = {}, processEnv = process.env) {
  for (const entry of scopeEntries) {
    const scope = asConfigObject(entry?.config);
    const sourceBase = String(entry?.source ?? "").trim();
    const triggerModeRaw = String(scope.triggerMode ?? "")
      .trim()
      .toLowerCase();
    if (GROUP_CHAT_TRIGGER_MODE_SET.has(triggerModeRaw)) {
      return {
        triggerMode: triggerModeRaw,
        source: sourceBase ? `${sourceBase}.triggerMode` : "triggerMode",
      };
    }
    const requireMention = parseBooleanLike(scope.requireMention, null);
    if (requireMention === true || requireMention === false) {
      return {
        triggerMode: requireMention ? "mention" : "direct",
        source: sourceBase ? `${sourceBase}.requireMention` : "requireMention",
      };
    }
  }

  const envTriggerModeCandidates = [
    ["WECOM_GROUP_CHAT_TRIGGER_MODE", envVars?.WECOM_GROUP_CHAT_TRIGGER_MODE],
    ["WECOM_GROUP_CHAT_TRIGGER_MODE", processEnv?.WECOM_GROUP_CHAT_TRIGGER_MODE],
  ];
  for (const [key, value] of envTriggerModeCandidates) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!GROUP_CHAT_TRIGGER_MODE_SET.has(normalized)) continue;
    return {
      triggerMode: normalized,
      source: `env.${key}`,
    };
  }

  const envRequireMentionCandidates = [
    ["WECOM_GROUP_CHAT_REQUIRE_MENTION", envVars?.WECOM_GROUP_CHAT_REQUIRE_MENTION],
    ["WECOM_GROUP_CHAT_REQUIRE_MENTION", processEnv?.WECOM_GROUP_CHAT_REQUIRE_MENTION],
  ];
  for (const [key, value] of envRequireMentionCandidates) {
    if (!hasExplicitConfigValue(value)) continue;
    return {
      triggerMode: parseBooleanLike(value, false) ? "mention" : "direct",
      source: `env.${key}`,
    };
  }

  return {
    triggerMode: "direct",
    source: "default",
  };
}

function normalizeWecomGroupPolicyMode(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "disabled") return "deny";
  return GROUP_POLICY_MODE_SET.has(normalized) ? normalized : fallback;
}

function resolveGroupScopedPolicyMode(scopeConfigs = [], envVars = {}, processEnv = process.env, accountId = "default") {
  for (const scopeConfig of scopeConfigs) {
    const scope = asConfigObject(scopeConfig);
    const mode = normalizeWecomGroupPolicyMode(
      pickFirstNonEmptyString(scope.policy, scope.groupPolicy),
      "",
    );
    if (mode) return mode;
  }

  return normalizeWecomGroupPolicyMode(readGroupPolicyEnv(envVars, processEnv, accountId), "");
}

function resolveGroupScopedPolicyDetails(scopeEntries = [], envVars = {}, processEnv = process.env, accountId = "default") {
  for (const entry of scopeEntries) {
    const scope = asConfigObject(entry?.config);
    const sourceBase = String(entry?.source ?? "").trim();
    const policyMode = normalizeWecomGroupPolicyMode(scope.policy, "");
    if (policyMode) {
      return {
        policyMode,
        source: sourceBase ? `${sourceBase}.policy` : "policy",
      };
    }
    const compatMode = normalizeWecomGroupPolicyMode(scope.groupPolicy, "");
    if (compatMode) {
      return {
        policyMode: compatMode,
        source: sourceBase ? `${sourceBase}.groupPolicy` : "groupPolicy",
      };
    }
  }

  const scopedKey = accountId === "default" ? "" : `WECOM_${String(accountId ?? "default").trim().toUpperCase()}_GROUP_POLICY`;
  const envCandidates = [
    [scopedKey, scopedKey ? envVars?.[scopedKey] : ""],
    [scopedKey, scopedKey ? processEnv?.[scopedKey] : ""],
    ["WECOM_GROUP_POLICY", envVars?.WECOM_GROUP_POLICY],
    ["WECOM_GROUP_POLICY", processEnv?.WECOM_GROUP_POLICY],
  ];
  for (const [key, value] of envCandidates) {
    if (!key) continue;
    const policyMode = normalizeWecomGroupPolicyMode(value, "");
    if (!policyMode) continue;
    return {
      policyMode,
      source: `env.${key}`,
    };
  }

  return {
    policyMode: "",
    source: "",
  };
}

export function extractLeadingSlashCommand(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized.startsWith("/")) return "";
  const command = normalized.split(/\s+/)[0]?.trim().toLowerCase() ?? "";
  return normalizeCommandToken(command);
}

export function resolveWecomCommandPolicyConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const commandConfig =
    channelConfig?.commands && typeof channelConfig.commands === "object" ? channelConfig.commands : {};
  const legacyAllowlist = uniqueCommandList(parseStringList(channelConfig?.commandAllowlist));
  const configuredAllowlist = uniqueCommandList(
    parseStringList(
      commandConfig.allowlist,
      legacyAllowlist,
      envVars?.WECOM_COMMANDS_ALLOWLIST,
      processEnv?.WECOM_COMMANDS_ALLOWLIST,
    ),
  );
  const allowlistEnabledByConfig = configuredAllowlist.length > 0;
  const enabled = parseBooleanLike(
    commandConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_COMMANDS_ENABLED,
      parseBooleanLike(processEnv?.WECOM_COMMANDS_ENABLED, allowlistEnabledByConfig),
    ),
  );
  const allowlist = configuredAllowlist.length > 0 ? configuredAllowlist : Array.from(DEFAULT_COMMAND_ALLOWLIST);
  const adminUsers = uniqueLowerCaseList(
    parseStringList(channelConfig?.adminUsers, envVars?.WECOM_ADMIN_USERS, processEnv?.WECOM_ADMIN_USERS),
  );
  const rejectMessage = pickFirstNonEmptyString(
    commandConfig.rejectMessage,
    commandConfig.blockMessage,
    channelConfig?.commandBlockMessage,
    envVars?.WECOM_COMMANDS_REJECT_MESSAGE,
    processEnv?.WECOM_COMMANDS_REJECT_MESSAGE,
    "该指令未开放，请联系管理员。",
  );

  return {
    enabled,
    allowlist,
    adminUsers,
    rejectMessage,
  };
}

export function resolveWecomAllowFromPolicyConfig({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
} = {}) {
  const accountAllowFrom = uniqueAllowFromList(
    parseStringList(accountConfig?.allowFrom, accountConfig?.dm?.allowFrom),
  );
  const channelAllowFrom = uniqueAllowFromList(
    parseStringList(channelConfig?.allowFrom, channelConfig?.dm?.allowFrom),
  );
  const envAllowFrom = uniqueAllowFromList(readAllowFromEnv(envVars, processEnv, accountId));
  const allowFrom = accountAllowFrom.length > 0 ? accountAllowFrom : channelAllowFrom.length > 0 ? channelAllowFrom : envAllowFrom;
  const rejectMessage = pickFirstNonEmptyString(
    accountConfig?.allowFromRejectMessage,
    accountConfig?.rejectUnauthorizedMessage,
    channelConfig?.allowFromRejectMessage,
    channelConfig?.rejectUnauthorizedMessage,
    readAllowFromRejectMessageEnv(envVars, processEnv, accountId),
    DEFAULT_ALLOW_FROM_REJECT_MESSAGE,
  );
  return {
    allowFrom,
    rejectMessage,
  };
}

export function resolveWecomDmPolicyConfig({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
} = {}) {
  const channelDmConfig = channelConfig?.dm && typeof channelConfig.dm === "object" ? channelConfig.dm : {};
  const accountDmConfig = accountConfig?.dm && typeof accountConfig.dm === "object" ? accountConfig.dm : {};
  const mode = normalizeWecomDmPolicyMode(
    pickFirstNonEmptyString(
      accountDmConfig.mode,
      channelDmConfig.mode,
      readDmPolicyModeEnv(envVars, processEnv, accountId),
      "open",
    ),
  );
  const allowFrom = uniqueAllowFromList(
    parseStringList(
      accountDmConfig.allowFrom,
      channelDmConfig.allowFrom,
      readDmAllowFromEnv(envVars, processEnv, accountId),
    ),
  );
  const rejectMessage = pickFirstNonEmptyString(
    accountDmConfig.rejectMessage,
    accountDmConfig.blockMessage,
    channelDmConfig.rejectMessage,
    channelDmConfig.blockMessage,
    readDmRejectMessageEnv(envVars, processEnv, accountId),
    mode === "deny"
      ? "当前渠道私聊已关闭，请联系管理员。"
      : mode === "pairing"
        ? "当前私聊需先完成配对审批。"
        : "当前私聊账号未授权，请联系管理员。",
  );
  const effectiveMode =
    mode === "allowlist" && allowFrom.length === 0
      ? "deny"
      : mode;
  return {
    mode: effectiveMode,
    allowFrom,
    rejectMessage,
    enabled: effectiveMode !== "open" || allowFrom.length > 0,
  };
}

export function resolveWecomEventPolicyConfig({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
} = {}) {
  const channelEventConfig = channelConfig?.events && typeof channelConfig.events === "object" ? channelConfig.events : {};
  const accountEventConfig = accountConfig?.events && typeof accountConfig.events === "object" ? accountConfig.events : {};
  const enabled = parseBooleanLike(
    accountEventConfig.enabled,
    parseBooleanLike(
      channelEventConfig.enabled,
      parseBooleanLike(readEventEnabledEnv(envVars, processEnv, accountId), true),
    ),
  );
  const enterAgentWelcomeEnabled = enabled
    ? parseBooleanLike(
        accountEventConfig.enterAgentWelcomeEnabled,
        parseBooleanLike(
          channelEventConfig.enterAgentWelcomeEnabled,
          parseBooleanLike(readEventEnterAgentWelcomeEnabledEnv(envVars, processEnv, accountId), false),
        ),
      )
    : false;
  const enterAgentWelcomeText = pickFirstNonEmptyString(
    accountEventConfig.enterAgentWelcomeText,
    channelEventConfig.enterAgentWelcomeText,
    readEventEnterAgentWelcomeTextEnv(envVars, processEnv, accountId),
    DEFAULT_EVENT_ENTER_AGENT_WELCOME_TEXT,
  );
  return {
    enabled,
    enterAgentWelcomeEnabled,
    enterAgentWelcomeText,
  };
}

export function isWecomSenderAllowed({ senderId, allowFrom = [] } = {}) {
  const sender = normalizeWecomAllowFromEntry(senderId);
  if (!sender) return false;
  const normalizedAllowFrom = uniqueAllowFromList(Array.isArray(allowFrom) ? allowFrom : parseStringList(allowFrom));
  if (normalizedAllowFrom.length === 0 || normalizedAllowFrom.includes("*")) return true;
  return normalizedAllowFrom.includes(sender);
}

export function resolveWecomGroupChatConfig({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
  chatId = "",
} = {}) {
  const normalizedChatId = String(chatId ?? "").trim();
  const channelGroupConfig = asConfigObject(channelConfig?.groupChat);
  const accountGroupConfig = asConfigObject(accountConfig?.groupChat);
  const channelGroupOverrides = asConfigObject(channelConfig?.groups);
  const accountGroupOverrides = asConfigObject(accountConfig?.groups);
  const channelChatConfig = lookupWecomGroupOverrideConfig(channelGroupOverrides, normalizedChatId);
  const accountChatConfig = lookupWecomGroupOverrideConfig(accountGroupOverrides, normalizedChatId);
  const triggerScopeEntries = [
    { config: accountChatConfig, source: "account.group" },
    { config: accountGroupConfig, source: "account.groupChat" },
    { config: channelChatConfig, source: "channel.group" },
    { config: channelGroupConfig, source: "channel.groupChat" },
  ];
  const policyScopeEntries = [
    { config: accountChatConfig, source: "account.group" },
    { config: accountGroupConfig, source: "account.groupChat" },
    { config: accountConfig, source: "account.root" },
    { config: channelChatConfig, source: "channel.group" },
    { config: channelGroupConfig, source: "channel.groupChat" },
    { config: channelConfig, source: "channel.root" },
  ];

  const configuredEnabled = resolveBooleanLike(
    [
      accountChatConfig.enabled,
      accountGroupConfig.enabled,
      channelChatConfig.enabled,
      channelGroupConfig.enabled,
      envVars?.WECOM_GROUP_CHAT_ENABLED,
      processEnv?.WECOM_GROUP_CHAT_ENABLED,
    ],
    true,
  );
  const triggerDetails = resolveGroupScopedTriggerDetails(
    triggerScopeEntries,
    envVars,
    processEnv,
  );
  const triggerMode = triggerDetails.triggerMode;
  const mentionPatterns = pickFirstStringList(
    accountChatConfig.mentionPatterns,
    accountGroupConfig.mentionPatterns,
    channelChatConfig.mentionPatterns,
    channelGroupConfig.mentionPatterns,
    envVars?.WECOM_GROUP_CHAT_MENTION_PATTERNS,
    processEnv?.WECOM_GROUP_CHAT_MENTION_PATTERNS,
    "@",
  );
  const triggerKeywords = pickFirstStringList(
    accountChatConfig.triggerKeywords,
    accountGroupConfig.triggerKeywords,
    channelChatConfig.triggerKeywords,
    channelGroupConfig.triggerKeywords,
    envVars?.WECOM_GROUP_CHAT_TRIGGER_KEYWORDS,
    processEnv?.WECOM_GROUP_CHAT_TRIGGER_KEYWORDS,
  ).map((item) => String(item ?? "").trim());
  const dedupedPatterns = [];
  const seen = new Set();
  for (const pattern of mentionPatterns) {
    const token = String(pattern ?? "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    dedupedPatterns.push(token);
  }

  const allowFromDetails = pickFirstStringListWithSource([
    { value: accountChatConfig.allowFrom, source: "account.group.allowFrom" },
    { value: accountChatConfig.groupAllowFrom, source: "account.group.groupAllowFrom" },
    { value: accountConfig?.groupAllowFrom, source: "account.root.groupAllowFrom" },
    { value: accountGroupConfig.allowFrom, source: "account.groupChat.allowFrom" },
    { value: accountGroupConfig.groupAllowFrom, source: "account.groupChat.groupAllowFrom" },
    { value: channelChatConfig.allowFrom, source: "channel.group.allowFrom" },
    { value: channelChatConfig.groupAllowFrom, source: "channel.group.groupAllowFrom" },
    { value: channelConfig?.groupAllowFrom, source: "channel.root.groupAllowFrom" },
    { value: channelGroupConfig.allowFrom, source: "channel.groupChat.allowFrom" },
    { value: channelGroupConfig.groupAllowFrom, source: "channel.groupChat.groupAllowFrom" },
    {
      value: readGroupAllowFromEnv(envVars, processEnv, accountId),
      source: accountId === "default" ? "env.WECOM_GROUP_ALLOW_FROM" : "env.account.WECOM_GROUP_ALLOW_FROM",
    },
  ]);
  const allowFrom = uniqueAllowFromList(allowFromDetails.values);
  const policyDetails = resolveGroupScopedPolicyDetails(
    policyScopeEntries,
    envVars,
    processEnv,
    accountId,
  );
  const configuredPolicyMode = policyDetails.policyMode;
  const inferredPolicyMode =
    configuredPolicyMode ||
    (!configuredEnabled
      ? "deny"
      : allowFrom.length > 0 && !allowFrom.includes("*")
        ? "allowlist"
        : "open");
  const policyMode =
    !configuredEnabled || (inferredPolicyMode === "allowlist" && allowFrom.length === 0) ? "deny" : inferredPolicyMode;
  const enabled = policyMode !== "deny";
  const rejectMessageDetails = pickFirstNonEmptyStringWithSource(
    [
      { value: accountChatConfig.rejectMessage, source: "account.group.rejectMessage" },
      { value: accountChatConfig.groupAllowFromRejectMessage, source: "account.group.groupAllowFromRejectMessage" },
      { value: accountChatConfig.blockMessage, source: "account.group.blockMessage" },
      { value: accountConfig?.groupAllowFromRejectMessage, source: "account.root.groupAllowFromRejectMessage" },
      { value: accountGroupConfig.rejectMessage, source: "account.groupChat.rejectMessage" },
      { value: accountGroupConfig.groupAllowFromRejectMessage, source: "account.groupChat.groupAllowFromRejectMessage" },
      { value: accountGroupConfig.blockMessage, source: "account.groupChat.blockMessage" },
      { value: channelChatConfig.rejectMessage, source: "channel.group.rejectMessage" },
      { value: channelChatConfig.groupAllowFromRejectMessage, source: "channel.group.groupAllowFromRejectMessage" },
      { value: channelChatConfig.blockMessage, source: "channel.group.blockMessage" },
      { value: channelConfig?.groupAllowFromRejectMessage, source: "channel.root.groupAllowFromRejectMessage" },
      { value: channelGroupConfig.rejectMessage, source: "channel.groupChat.rejectMessage" },
      { value: channelGroupConfig.groupAllowFromRejectMessage, source: "channel.groupChat.groupAllowFromRejectMessage" },
      { value: channelGroupConfig.blockMessage, source: "channel.groupChat.blockMessage" },
      {
        value: readGroupAllowFromRejectMessageEnv(envVars, processEnv, accountId),
        source:
          accountId === "default"
            ? "env.WECOM_GROUP_ALLOW_FROM_REJECT_MESSAGE"
            : "env.account.WECOM_GROUP_ALLOW_FROM_REJECT_MESSAGE",
      },
    ],
    DEFAULT_ALLOW_FROM_REJECT_MESSAGE,
    "default",
  );
  const rejectMessage = rejectMessageDetails.value;
  const configuredGroupIds = collectConfiguredGroupIds(channelGroupOverrides, accountGroupOverrides);
  const matchedGroupOverride =
    Object.keys(channelChatConfig).length > 0 || Object.keys(accountChatConfig).length > 0;
  const matchedGroupOverrideSource =
    Object.keys(accountChatConfig).length > 0 ? "account.group" : Object.keys(channelChatConfig).length > 0 ? "channel.group" : "";
  const effectivePolicySource =
    policyMode === inferredPolicyMode
      ? configuredPolicyMode
        ? policyDetails.source
        : "inferred"
      : !configuredEnabled
        ? "enabled=false"
        : "allowlist-empty";

  return {
    enabled,
    policyMode,
    policySource: effectivePolicySource,
    triggerSource: triggerDetails.source,
    requireMention: triggerMode === "mention",
    triggerMode,
    mentionPatterns: dedupedPatterns.length > 0 ? dedupedPatterns : ["@"],
    triggerKeywords: uniqueLowerCaseList(triggerKeywords),
    allowFrom,
    allowFromSource: allowFromDetails.source,
    allowFromActive: policyMode === "allowlist",
    rejectMessage,
    rejectMessageSource: rejectMessageDetails.source,
    chatId: normalizedChatId,
    matchedGroupOverride,
    matchedGroupOverrideSource,
    configuredGroupCount: configuredGroupIds.length,
  };
}

function matchMentionPattern(content, mentionPatterns = ["@"]) {
  const text = String(content ?? "");
  if (!text.trim()) return false;
  return mentionPatterns.some((pattern) => {
    const normalized = String(pattern ?? "").trim();
    if (!normalized) return false;
    if (normalized === "@") {
      // Avoid false positives for email-like "user@domain" content.
      return /(^|[^A-Za-z0-9._%+-])@[^\s@]+/u.test(text);
    }
    const escaped = escapeRegExp(normalized);
    if (normalized.startsWith("@")) {
      return new RegExp(`(^|[^A-Za-z0-9._%+-])${escaped}(?=$|\\s|[()\\[\\]{}<>,.!?;:，。！？、；：])`, "u").test(
        text,
      );
    }
    return new RegExp(
      `(^|\\s|[()\\[\\]{}<>,.!?;:，。！？、；：])${escaped}(?=$|\\s|[()\\[\\]{}<>,.!?;:，。！？、；：])`,
      "u",
    ).test(text);
  });
}

function matchKeywordPattern(content, triggerKeywords = []) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  const normalizedText = text.toLowerCase();
  return triggerKeywords.some((rawKeyword) => {
    const keyword = String(rawKeyword ?? "").trim().toLowerCase();
    if (!keyword) return false;
    return normalizedText.includes(keyword);
  });
}

export function shouldTriggerWecomGroupResponse(content, groupChatConfig) {
  if (groupChatConfig?.enabled === false) return false;
  const triggerMode = String(groupChatConfig?.triggerMode || "").trim().toLowerCase();
  if (triggerMode === "mention") {
    const patterns =
      Array.isArray(groupChatConfig?.mentionPatterns) && groupChatConfig.mentionPatterns.length > 0
        ? groupChatConfig.mentionPatterns
        : ["@"];
    return matchMentionPattern(content, patterns);
  }
  if (triggerMode === "keyword") {
    const keywords =
      Array.isArray(groupChatConfig?.triggerKeywords) && groupChatConfig.triggerKeywords.length > 0
        ? groupChatConfig.triggerKeywords
        : [];
    return matchKeywordPattern(content, keywords);
  }
  return String(content ?? "").trim().length > 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldStripWecomGroupMentions(groupChatConfig) {
  const triggerMode = String(groupChatConfig?.triggerMode || "").trim().toLowerCase();
  return triggerMode === "mention" || groupChatConfig?.requireMention === true;
}

export function stripWecomGroupMentions(content, mentionPatterns = ["@"]) {
  let text = String(content ?? "");
  const patterns = Array.isArray(mentionPatterns) && mentionPatterns.length > 0 ? mentionPatterns : ["@"];
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern ?? "").trim();
    if (!pattern) continue;
    if (pattern === "@") {
      // Remove "@name" mentions while keeping email-like local@domain untouched.
      text = text.replace(/(^|[^A-Za-z0-9._%+-])@[^\s@]+/gu, "$1");
      continue;
    }
    const escaped = escapeRegExp(pattern);
    if (pattern.startsWith("@")) {
      text = text.replace(new RegExp(`(^|[^A-Za-z0-9._%+-])${escaped}\\S*`, "gu"), "$1");
      continue;
    }
    text = text.replace(
      new RegExp(`(^|\\s|[()\\[\\]{}<>,.!?;:，。！？、；：])${escaped}\\S*`, "gu"),
      "$1",
    );
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

export function resolveWecomDebounceConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const debounceConfig =
    channelConfig?.debounce && typeof channelConfig.debounce === "object" ? channelConfig.debounce : {};
  const enabled = parseBooleanLike(
    debounceConfig.enabled,
    parseBooleanLike(envVars?.WECOM_DEBOUNCE_ENABLED, parseBooleanLike(processEnv?.WECOM_DEBOUNCE_ENABLED, false)),
  );
  const windowMs = asBoundedPositiveInteger(
    debounceConfig.windowMs ?? envVars?.WECOM_DEBOUNCE_WINDOW_MS ?? processEnv?.WECOM_DEBOUNCE_WINDOW_MS,
    1200,
    100,
    10000,
  );
  const maxBatch = asBoundedPositiveInteger(
    debounceConfig.maxBatch ?? envVars?.WECOM_DEBOUNCE_MAX_BATCH ?? processEnv?.WECOM_DEBOUNCE_MAX_BATCH,
    6,
    1,
    50,
  );
  return {
    enabled,
    windowMs,
    maxBatch,
  };
}

export function resolveWecomStreamingConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const streamingConfig =
    channelConfig?.streaming && typeof channelConfig.streaming === "object" ? channelConfig.streaming : {};
  const enabled = parseBooleanLike(
    streamingConfig.enabled,
    parseBooleanLike(envVars?.WECOM_STREAMING_ENABLED, parseBooleanLike(processEnv?.WECOM_STREAMING_ENABLED, false)),
  );
  const minChars = asBoundedPositiveInteger(
    streamingConfig.minChars ?? envVars?.WECOM_STREAMING_MIN_CHARS ?? processEnv?.WECOM_STREAMING_MIN_CHARS,
    120,
    20,
    2000,
  );
  const minIntervalMs = asBoundedPositiveInteger(
    streamingConfig.minIntervalMs ??
      envVars?.WECOM_STREAMING_MIN_INTERVAL_MS ??
      processEnv?.WECOM_STREAMING_MIN_INTERVAL_MS,
    1200,
    200,
    10000,
  );
  return {
    enabled,
    minChars,
    minIntervalMs,
  };
}

export function resolveWecomDynamicAgentConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const dynamicAgentConfig =
    channelConfig?.dynamicAgent && typeof channelConfig.dynamicAgent === "object"
      ? channelConfig.dynamicAgent
      : {};
  const dynamicAgentsCompatConfig =
    channelConfig?.dynamicAgents && typeof channelConfig.dynamicAgents === "object"
      ? channelConfig.dynamicAgents
      : {};
  const dynamicConfig = Object.keys(dynamicAgentConfig).length > 0 ? dynamicAgentConfig : dynamicAgentsCompatConfig;
  const dmCompatConfig = channelConfig?.dm && typeof channelConfig.dm === "object" ? channelConfig.dm : {};
  const enabled = parseBooleanLike(
    dynamicConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_ENABLED,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_ENABLED, false),
    ),
  );
  const modeRaw = pickFirstNonEmptyString(
    dynamicConfig.mode,
    envVars?.WECOM_DYNAMIC_AGENT_MODE,
    processEnv?.WECOM_DYNAMIC_AGENT_MODE,
    enabled ? "deterministic" : "mapping",
  )
    .trim()
    .toLowerCase();
  const mode = DYNAMIC_AGENT_MODE_SET.has(modeRaw) ? modeRaw : enabled ? "deterministic" : "mapping";
  const idStrategyRaw = pickFirstNonEmptyString(
    dynamicConfig.idStrategy,
    envVars?.WECOM_DYNAMIC_AGENT_ID_STRATEGY,
    processEnv?.WECOM_DYNAMIC_AGENT_ID_STRATEGY,
    "readable-hash",
  )
    .trim()
    .toLowerCase();
  const idStrategy = DYNAMIC_AGENT_ID_STRATEGY_SET.has(idStrategyRaw) ? idStrategyRaw : "readable-hash";
  const deterministicPrefix = pickFirstNonEmptyString(
    dynamicConfig.deterministicPrefix,
    envVars?.WECOM_DYNAMIC_AGENT_PREFIX,
    processEnv?.WECOM_DYNAMIC_AGENT_PREFIX,
    "wecom",
  );
  const autoProvision = parseBooleanLike(
    dynamicConfig.autoProvision,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_AUTO_PROVISION,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_AUTO_PROVISION, true),
    ),
  );
  const allowUnknownAgentId = parseBooleanLike(
    dynamicConfig.allowUnknownAgentId,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_ALLOW_UNKNOWN_AGENT_ID,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_ALLOW_UNKNOWN_AGENT_ID, autoProvision),
    ),
  );
  const workspaceTemplate = pickFirstNonEmptyString(
    dynamicConfig.workspaceTemplate,
    channelConfig?.workspaceTemplate,
    envVars?.WECOM_DYNAMIC_AGENT_WORKSPACE_TEMPLATE,
    processEnv?.WECOM_DYNAMIC_AGENT_WORKSPACE_TEMPLATE,
  );
  const defaultAgentId = pickFirstNonEmptyString(
    dynamicConfig.defaultAgentId,
    dynamicConfig.default,
    envVars?.WECOM_DYNAMIC_AGENT_DEFAULT_AGENT_ID,
    processEnv?.WECOM_DYNAMIC_AGENT_DEFAULT_AGENT_ID,
    envVars?.WECOM_DYNAMIC_AGENT_DEFAULT,
    processEnv?.WECOM_DYNAMIC_AGENT_DEFAULT,
  );
  const adminAgentId = pickFirstNonEmptyString(
    dynamicConfig.adminAgentId,
    envVars?.WECOM_DYNAMIC_AGENT_ADMIN_AGENT_ID,
    processEnv?.WECOM_DYNAMIC_AGENT_ADMIN_AGENT_ID,
  );
  const adminUsers = uniqueLowerCaseList(
    parseStringList(
      dynamicConfig.adminUsers,
      envVars?.WECOM_DYNAMIC_AGENT_ADMIN_USERS,
      processEnv?.WECOM_DYNAMIC_AGENT_ADMIN_USERS,
      channelConfig?.adminUsers,
    ),
  );
  const forceAgentSessionKey = parseBooleanLike(
    dynamicConfig.forceAgentSessionKey,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_FORCE_SESSION_KEY,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_FORCE_SESSION_KEY, true),
    ),
  );
  const preferMentionMap = parseBooleanLike(
    dynamicConfig.preferMentionMap,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_PREFER_MENTION_MAP,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_PREFER_MENTION_MAP, true),
    ),
  );
  const allowFallbackToDefaultRoute = parseBooleanLike(
    dynamicConfig.allowFallbackToDefaultRoute,
    parseBooleanLike(
      envVars?.WECOM_DYNAMIC_AGENT_ALLOW_FALLBACK,
      parseBooleanLike(processEnv?.WECOM_DYNAMIC_AGENT_ALLOW_FALLBACK, true),
    ),
  );
  const dmCreateAgent = parseBooleanLike(
    dynamicConfig.dmCreateAgentOnFirstMessage,
    parseBooleanLike(
      dmCompatConfig.createAgentOnFirstMessage,
      parseBooleanLike(
        envVars?.WECOM_DM_CREATE_AGENT_ON_FIRST_MESSAGE,
        parseBooleanLike(processEnv?.WECOM_DM_CREATE_AGENT_ON_FIRST_MESSAGE, true),
      ),
    ),
  );
  const groupEnabled = parseBooleanLike(
    dynamicConfig.groupEnabled,
    parseBooleanLike(
      channelConfig?.groupChat?.enabled,
      parseBooleanLike(envVars?.WECOM_GROUP_CHAT_ENABLED, parseBooleanLike(processEnv?.WECOM_GROUP_CHAT_ENABLED, true)),
    ),
  );
  const userMap = parseDynamicAgentMap(
    dynamicConfig.userMap,
    envVars?.WECOM_DYNAMIC_AGENT_USER_MAP,
    processEnv?.WECOM_DYNAMIC_AGENT_USER_MAP,
  );
  const groupMap = parseDynamicAgentMap(
    dynamicConfig.groupMap,
    envVars?.WECOM_DYNAMIC_AGENT_GROUP_MAP,
    processEnv?.WECOM_DYNAMIC_AGENT_GROUP_MAP,
  );
  const mentionMap = parseDynamicAgentMap(
    dynamicConfig.mentionMap,
    envVars?.WECOM_DYNAMIC_AGENT_MENTION_MAP,
    processEnv?.WECOM_DYNAMIC_AGENT_MENTION_MAP,
  );

  return {
    enabled,
    mode,
    idStrategy,
    deterministicPrefix: deterministicPrefix || "wecom",
    autoProvision,
    allowUnknownAgentId,
    workspaceTemplate: workspaceTemplate || undefined,
    defaultAgentId: defaultAgentId || undefined,
    adminAgentId: adminAgentId || undefined,
    adminUsers,
    forceAgentSessionKey,
    preferMentionMap,
    allowFallbackToDefaultRoute,
    dmCreateAgent,
    groupEnabled,
    userMap,
    groupMap,
    mentionMap,
  };
}

export function resolveWecomDeliveryFallbackConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const deliveryConfig =
    channelConfig?.delivery && typeof channelConfig.delivery === "object" ? channelConfig.delivery : {};
  const fallbackConfig =
    deliveryConfig?.fallback && typeof deliveryConfig.fallback === "object" ? deliveryConfig.fallback : {};
  const enabled = parseBooleanLike(
    fallbackConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_DELIVERY_FALLBACK_ENABLED,
      parseBooleanLike(processEnv?.WECOM_DELIVERY_FALLBACK_ENABLED, true),
    ),
  );
  const order = uniqueDeliveryFallbackOrder(
    parseStringList(
      fallbackConfig.order,
      envVars?.WECOM_DELIVERY_FALLBACK_ORDER,
      processEnv?.WECOM_DELIVERY_FALLBACK_ORDER,
    ),
  );
  return {
    enabled,
    order: order.length > 0 ? order : Array.from(DEFAULT_DELIVERY_FALLBACK_ORDER),
  };
}

export function resolveWecomPendingReplyConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const deliveryConfig =
    channelConfig?.delivery && typeof channelConfig.delivery === "object" ? channelConfig.delivery : {};
  const pendingReplyConfig =
    deliveryConfig?.pendingReply && typeof deliveryConfig.pendingReply === "object" ? deliveryConfig.pendingReply : {};
  const enabled = parseBooleanLike(
    pendingReplyConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_PENDING_REPLY_ENABLED,
      parseBooleanLike(processEnv?.WECOM_PENDING_REPLY_ENABLED, true),
    ),
  );
  const maxRetries = asBoundedPositiveInteger(
    pendingReplyConfig.maxRetries ??
      envVars?.WECOM_PENDING_REPLY_MAX_RETRIES ??
      processEnv?.WECOM_PENDING_REPLY_MAX_RETRIES,
    3,
    1,
    10,
  );
  const retryBackoffMs = asBoundedPositiveInteger(
    pendingReplyConfig.retryBackoffMs ??
      envVars?.WECOM_PENDING_REPLY_RETRY_BACKOFF_MS ??
      processEnv?.WECOM_PENDING_REPLY_RETRY_BACKOFF_MS,
    15000,
    1000,
    10 * 60 * 1000,
  );
  const expireMs = asBoundedPositiveInteger(
    pendingReplyConfig.expireMs ??
      envVars?.WECOM_PENDING_REPLY_EXPIRE_MS ??
      processEnv?.WECOM_PENDING_REPLY_EXPIRE_MS,
    10 * 60 * 1000,
    30000,
    24 * 60 * 60 * 1000,
  );
  const persist = parseBooleanLike(
    pendingReplyConfig.persist,
    parseBooleanLike(
      envVars?.WECOM_PENDING_REPLY_PERSIST,
      parseBooleanLike(processEnv?.WECOM_PENDING_REPLY_PERSIST, true),
    ),
  );
  const storeFile = pickFirstNonEmptyString(
    pendingReplyConfig.storeFile,
    envVars?.WECOM_PENDING_REPLY_STORE_FILE,
    processEnv?.WECOM_PENDING_REPLY_STORE_FILE,
  );
  return {
    enabled,
    maxRetries,
    retryBackoffMs,
    expireMs,
    persist,
    storeFile: storeFile || undefined,
  };
}

export function resolveWecomReasoningConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const deliveryConfig =
    channelConfig?.delivery && typeof channelConfig.delivery === "object" ? channelConfig.delivery : {};
  const reasoningConfig =
    deliveryConfig?.reasoning && typeof deliveryConfig.reasoning === "object" ? deliveryConfig.reasoning : {};
  const modeRaw = pickFirstNonEmptyString(
    reasoningConfig.mode,
    envVars?.WECOM_REASONING_MODE,
    processEnv?.WECOM_REASONING_MODE,
  )
    .trim()
    .toLowerCase();
  const sendThinkingMessage = parseBooleanLike(
    reasoningConfig.sendThinkingMessage,
    parseBooleanLike(
      envVars?.WECOM_SEND_THINKING_MESSAGE,
      parseBooleanLike(processEnv?.WECOM_SEND_THINKING_MESSAGE, true),
    ),
  );
  const includeInFinalAnswer = parseBooleanLike(
    reasoningConfig.includeInFinalAnswer,
    parseBooleanLike(
      envVars?.WECOM_REASONING_INCLUDE_IN_FINAL_ANSWER,
      parseBooleanLike(processEnv?.WECOM_REASONING_INCLUDE_IN_FINAL_ANSWER, false),
    ),
  );
  let mode = DELIVERY_REASONING_MODE_SET.has(modeRaw)
    ? modeRaw
    : includeInFinalAnswer
      ? "append"
      : sendThinkingMessage
        ? "separate"
        : "hidden";
  if (!DELIVERY_REASONING_MODE_SET.has(mode)) mode = "separate";
  const title = pickFirstNonEmptyString(
    reasoningConfig.title,
    envVars?.WECOM_REASONING_TITLE,
    processEnv?.WECOM_REASONING_TITLE,
    "思考过程",
  );
  const maxChars = asBoundedPositiveInteger(
    reasoningConfig.maxChars ??
      envVars?.WECOM_REASONING_MAX_CHARS ??
      processEnv?.WECOM_REASONING_MAX_CHARS,
    1200,
    64,
    8000,
  );
  return {
    mode,
    sendThinkingMessage: mode === "separate",
    includeInFinalAnswer: mode === "append",
    title,
    maxChars,
  };
}

export function resolveWecomReplyFormatConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const deliveryConfig =
    channelConfig?.delivery && typeof channelConfig.delivery === "object" ? channelConfig.delivery : {};
  const replyFormatRaw = pickFirstNonEmptyString(
    deliveryConfig?.replyFormat,
    envVars?.WECOM_REPLY_FORMAT,
    processEnv?.WECOM_REPLY_FORMAT,
    "auto",
  )
    .trim()
    .toLowerCase();
  const mode = DELIVERY_REPLY_FORMAT_SET.has(replyFormatRaw) ? replyFormatRaw : "auto";
  return {
    mode,
  };
}

export function resolveWecomQuotaTrackingConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const deliveryConfig =
    channelConfig?.delivery && typeof channelConfig.delivery === "object" ? channelConfig.delivery : {};
  const quotaTrackingConfig =
    deliveryConfig?.quotaTracking && typeof deliveryConfig.quotaTracking === "object"
      ? deliveryConfig.quotaTracking
      : {};
  const enabled = parseBooleanLike(
    quotaTrackingConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_QUOTA_TRACKING_ENABLED,
      parseBooleanLike(processEnv?.WECOM_QUOTA_TRACKING_ENABLED, true),
    ),
  );
  return {
    enabled,
  };
}

export function resolveWecomWebhookBotDeliveryConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const webhookBotConfig =
    channelConfig?.webhookBot && typeof channelConfig.webhookBot === "object" ? channelConfig.webhookBot : {};
  const enabled = parseBooleanLike(
    webhookBotConfig.enabled,
    parseBooleanLike(envVars?.WECOM_WEBHOOK_BOT_ENABLED, parseBooleanLike(processEnv?.WECOM_WEBHOOK_BOT_ENABLED, false)),
  );
  const url = pickFirstNonEmptyString(
    webhookBotConfig.url,
    envVars?.WECOM_WEBHOOK_BOT_URL,
    processEnv?.WECOM_WEBHOOK_BOT_URL,
  );
  const key = pickFirstNonEmptyString(
    webhookBotConfig.key,
    envVars?.WECOM_WEBHOOK_BOT_KEY,
    processEnv?.WECOM_WEBHOOK_BOT_KEY,
  );
  const timeoutMs = asBoundedPositiveInteger(
    webhookBotConfig.timeoutMs ??
      envVars?.WECOM_WEBHOOK_BOT_TIMEOUT_MS ??
      processEnv?.WECOM_WEBHOOK_BOT_TIMEOUT_MS,
    8000,
    1000,
    60000,
  );
  return {
    enabled,
    url: url || undefined,
    key: key || undefined,
    timeoutMs,
  };
}

export function resolveWecomStreamManagerConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const streamConfig = channelConfig?.stream && typeof channelConfig.stream === "object" ? channelConfig.stream : {};
  const managerConfig =
    streamConfig?.manager && typeof streamConfig.manager === "object" ? streamConfig.manager : {};
  const enabled = parseBooleanLike(
    managerConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_STREAM_MANAGER_ENABLED,
      parseBooleanLike(processEnv?.WECOM_STREAM_MANAGER_ENABLED, false),
    ),
  );
  const timeoutMs = asBoundedPositiveInteger(
    managerConfig.timeoutMs ??
      envVars?.WECOM_STREAM_MANAGER_TIMEOUT_MS ??
      processEnv?.WECOM_STREAM_MANAGER_TIMEOUT_MS,
    45000,
    1000,
    10 * 60 * 1000,
  );
  const maxConcurrentPerSession = asBoundedPositiveInteger(
    managerConfig.maxConcurrentPerSession ??
      envVars?.WECOM_STREAM_MANAGER_MAX_CONCURRENT_PER_SESSION ??
      processEnv?.WECOM_STREAM_MANAGER_MAX_CONCURRENT_PER_SESSION,
    1,
    1,
    8,
  );
  return {
    enabled,
    timeoutMs,
    maxConcurrentPerSession,
  };
}

export function resolveWecomObservabilityConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const observabilityConfig =
    channelConfig?.observability && typeof channelConfig.observability === "object"
      ? channelConfig.observability
      : {};
  const enabled = parseBooleanLike(
    observabilityConfig.enabled,
    parseBooleanLike(envVars?.WECOM_OBSERVABILITY_ENABLED, parseBooleanLike(processEnv?.WECOM_OBSERVABILITY_ENABLED, true)),
  );
  const logPayloadMeta = parseBooleanLike(
    observabilityConfig.logPayloadMeta,
    parseBooleanLike(
      envVars?.WECOM_OBSERVABILITY_PAYLOAD_META,
      parseBooleanLike(processEnv?.WECOM_OBSERVABILITY_PAYLOAD_META, true),
    ),
  );
  return {
    enabled,
    logPayloadMeta,
  };
}

export function resolveWecomBotCardConfig({
  botConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const cardConfig = botConfig?.card && typeof botConfig.card === "object" ? botConfig.card : {};
  const enabled = parseBooleanLike(
    cardConfig.enabled,
    parseBooleanLike(
      envVars?.WECOM_BOT_CARD_ENABLED,
      parseBooleanLike(processEnv?.WECOM_BOT_CARD_ENABLED, false),
    ),
  );
  const mode = normalizeWecomBotCardMode(
    pickFirstNonEmptyString(
      cardConfig.mode,
      envVars?.WECOM_BOT_CARD_MODE,
      processEnv?.WECOM_BOT_CARD_MODE,
      DEFAULT_BOT_CARD_MODE,
    ),
  );
  const title = pickFirstNonEmptyString(
    cardConfig.title,
    envVars?.WECOM_BOT_CARD_TITLE,
    processEnv?.WECOM_BOT_CARD_TITLE,
    "OpenClaw-Wechat",
  );
  const subtitle = pickFirstNonEmptyString(
    cardConfig.subtitle,
    cardConfig.subTitle,
    envVars?.WECOM_BOT_CARD_SUBTITLE,
    processEnv?.WECOM_BOT_CARD_SUBTITLE,
  );
  const footer = pickFirstNonEmptyString(
    cardConfig.footer,
    envVars?.WECOM_BOT_CARD_FOOTER,
    processEnv?.WECOM_BOT_CARD_FOOTER,
  );
  const maxContentLength = asBoundedPositiveInteger(
    cardConfig.maxContentLength ??
      cardConfig.maxBodyChars ??
      envVars?.WECOM_BOT_CARD_MAX_CONTENT_LENGTH ??
      processEnv?.WECOM_BOT_CARD_MAX_CONTENT_LENGTH,
    1400,
    200,
    4000,
  );
  const responseUrlEnabled = parseBooleanLike(
    cardConfig.responseUrlEnabled,
    parseBooleanLike(
      envVars?.WECOM_BOT_CARD_RESPONSE_URL_ENABLED,
      parseBooleanLike(processEnv?.WECOM_BOT_CARD_RESPONSE_URL_ENABLED, true),
    ),
  );
  const webhookBotEnabled = parseBooleanLike(
    cardConfig.webhookBotEnabled,
    parseBooleanLike(
      envVars?.WECOM_BOT_CARD_WEBHOOK_BOT_ENABLED,
      parseBooleanLike(processEnv?.WECOM_BOT_CARD_WEBHOOK_BOT_ENABLED, true),
    ),
  );
  return {
    enabled,
    mode,
    title,
    subtitle: subtitle || undefined,
    footer: footer || undefined,
    maxContentLength,
    responseUrlEnabled,
    webhookBotEnabled,
  };
}

export function resolveWecomBotModeConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
  botConfigOverride,
} = {}) {
  const normalizedAccountId = normalizeAccountIdForEnv(accountId);
  const legacyInlineAccountConfig = resolveLegacyInlineAccountConfig(channelConfig, normalizedAccountId);
  const defaultInlineAccountConfig = resolveLegacyInlineAccountConfig(channelConfig, "default");
  const accountConfig =
    normalizedAccountId === "default"
      ? (defaultInlineAccountConfig ?? channelConfig)
      : channelConfig?.accounts && typeof channelConfig.accounts === "object"
        ? (channelConfig.accounts[normalizedAccountId] ?? legacyInlineAccountConfig)
        : legacyInlineAccountConfig;
  const scopedBotConfig =
    normalizedAccountId === "default"
      ? channelConfig?.bot
      : accountConfig && typeof accountConfig === "object"
        ? accountConfig.bot
        : null;
  const botConfig =
    botConfigOverride && typeof botConfigOverride === "object"
      ? botConfigOverride
      : scopedBotConfig && typeof scopedBotConfig === "object"
        ? scopedBotConfig
        : {};

  const scopedEnvVars = { ...(envVars && typeof envVars === "object" ? envVars : {}) };
  const scopedProcessEnv = { ...(processEnv && typeof processEnv === "object" ? processEnv : {}) };
  const botEnvSuffixes = [
    "ENABLED",
    "TOKEN",
    "ENCODING_AES_KEY",
    "WEBHOOK_PATH",
    "LONG_CONNECTION_ENABLED",
    "LONG_CONNECTION_BOT_ID",
    "LONG_CONNECTION_SECRET",
    "LONG_CONNECTION_URL",
    "LONG_CONNECTION_PING_INTERVAL_MS",
    "LONG_CONNECTION_RECONNECT_DELAY_MS",
    "LONG_CONNECTION_MAX_RECONNECT_DELAY_MS",
    "PLACEHOLDER_TEXT",
    "STREAM_EXPIRE_MS",
    "REPLY_TIMEOUT_MS",
    "LATE_REPLY_WATCH_MS",
    "LATE_REPLY_POLL_MS",
    "CARD_ENABLED",
    "CARD_MODE",
    "CARD_TITLE",
    "CARD_SUBTITLE",
    "CARD_FOOTER",
    "CARD_MAX_CONTENT_LENGTH",
    "CARD_RESPONSE_URL_ENABLED",
    "CARD_WEBHOOK_BOT_ENABLED",
  ];
  if (normalizedAccountId !== "default") {
    const accountPrefix = `WECOM_${normalizedAccountId.toUpperCase()}_BOT_`;
    for (const suffix of botEnvSuffixes) {
      const scopedKey = `${accountPrefix}${suffix}`;
      const mappedKey = `WECOM_BOT_${suffix}`;
      if (Object.prototype.hasOwnProperty.call(scopedEnvVars, scopedKey)) {
        scopedEnvVars[mappedKey] = scopedEnvVars[scopedKey];
      }
      if (Object.prototype.hasOwnProperty.call(scopedProcessEnv, scopedKey)) {
        scopedProcessEnv[mappedKey] = scopedProcessEnv[scopedKey];
      }
    }
  }
  const longConnectionConfig =
    botConfig.longConnection && typeof botConfig.longConnection === "object" ? botConfig.longConnection : {};
  const compatLongConnectionBotId = pickFirstNonEmptyString(accountConfig?.botId, accountConfig?.botid);
  const compatLongConnectionSecret = pickFirstNonEmptyString(accountConfig?.secret);
  const compatLongConnectionEnabled =
    Boolean(compatLongConnectionBotId) || Boolean(compatLongConnectionSecret);
  const longConnectionEnabled = parseBooleanLike(
    longConnectionConfig.enabled,
    parseBooleanLike(
      scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_ENABLED,
      parseBooleanLike(scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_ENABLED, compatLongConnectionEnabled),
    ),
  );
  const enabled = parseBooleanLike(
    botConfig.enabled,
    parseBooleanLike(
      scopedEnvVars?.WECOM_BOT_ENABLED,
      parseBooleanLike(scopedProcessEnv?.WECOM_BOT_ENABLED, longConnectionEnabled),
    ),
  );
  const legacyAgentCompat =
    accountConfig?.agent && typeof accountConfig.agent === "object" ? accountConfig.agent : null;
  const legacyTopLevelBotToken = legacyAgentCompat ? pickFirstNonEmptyString(accountConfig?.token) : "";
  const legacyTopLevelBotAesKey = legacyAgentCompat ? pickFirstNonEmptyString(accountConfig?.encodingAesKey) : "";
  const legacyTopLevelBotWebhookPath = legacyAgentCompat ? pickFirstNonEmptyString(accountConfig?.webhookPath) : "";
  const token = pickFirstNonEmptyString(
    botConfig.token,
    botConfig.callbackToken,
    legacyTopLevelBotToken,
    scopedEnvVars?.WECOM_BOT_TOKEN,
    scopedProcessEnv?.WECOM_BOT_TOKEN,
  );
  const encodingAesKey = pickFirstNonEmptyString(
    botConfig.encodingAesKey,
    botConfig.callbackAesKey,
    legacyTopLevelBotAesKey,
    scopedEnvVars?.WECOM_BOT_ENCODING_AES_KEY,
    scopedProcessEnv?.WECOM_BOT_ENCODING_AES_KEY,
  );
  const webhookPath = pickFirstNonEmptyString(
    botConfig.webhookPath,
    legacyTopLevelBotWebhookPath,
    scopedEnvVars?.WECOM_BOT_WEBHOOK_PATH,
    scopedProcessEnv?.WECOM_BOT_WEBHOOK_PATH,
    buildDefaultBotWebhookPath(normalizedAccountId),
  );
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
  const placeholderText = (() => {
    if (hasOwn(botConfig, "placeholderText")) return String(botConfig.placeholderText ?? "");
    if (hasOwn(scopedEnvVars, "WECOM_BOT_PLACEHOLDER_TEXT")) return String(scopedEnvVars.WECOM_BOT_PLACEHOLDER_TEXT ?? "");
    if (hasOwn(scopedProcessEnv, "WECOM_BOT_PLACEHOLDER_TEXT"))
      return String(scopedProcessEnv.WECOM_BOT_PLACEHOLDER_TEXT ?? "");
    return "消息已收到，正在处理中，请稍等片刻。";
  })();
  const streamExpireMs = asBoundedPositiveInteger(
    botConfig.streamExpireMs ??
      scopedEnvVars?.WECOM_BOT_STREAM_EXPIRE_MS ??
      scopedProcessEnv?.WECOM_BOT_STREAM_EXPIRE_MS,
    10 * 60 * 1000,
    30 * 1000,
    60 * 60 * 1000,
  );
  const replyTimeoutMs = asBoundedPositiveInteger(
    botConfig.replyTimeoutMs ??
      scopedEnvVars?.WECOM_BOT_REPLY_TIMEOUT_MS ??
      scopedProcessEnv?.WECOM_BOT_REPLY_TIMEOUT_MS ??
      scopedEnvVars?.WECOM_REPLY_TIMEOUT_MS ??
      scopedProcessEnv?.WECOM_REPLY_TIMEOUT_MS,
    90000,
    15000,
    10 * 60 * 1000,
  );
  const lateReplyWatchMs = asBoundedPositiveInteger(
    botConfig.lateReplyWatchMs ??
      scopedEnvVars?.WECOM_BOT_LATE_REPLY_WATCH_MS ??
      scopedProcessEnv?.WECOM_BOT_LATE_REPLY_WATCH_MS ??
      scopedEnvVars?.WECOM_LATE_REPLY_WATCH_MS ??
      scopedProcessEnv?.WECOM_LATE_REPLY_WATCH_MS,
    180000,
    30000,
    10 * 60 * 1000,
  );
  const lateReplyPollMs = asBoundedPositiveInteger(
    botConfig.lateReplyPollMs ??
      scopedEnvVars?.WECOM_BOT_LATE_REPLY_POLL_MS ??
      scopedProcessEnv?.WECOM_BOT_LATE_REPLY_POLL_MS ??
      scopedEnvVars?.WECOM_LATE_REPLY_POLL_MS ??
      scopedProcessEnv?.WECOM_LATE_REPLY_POLL_MS,
    2000,
    500,
    10000,
  );
  const card = resolveWecomBotCardConfig({
    botConfig,
    envVars: scopedEnvVars,
    processEnv: scopedProcessEnv,
  });
  const longConnectionBotId = pickFirstNonEmptyString(
    longConnectionConfig.botId,
    longConnectionConfig.botid,
    compatLongConnectionBotId,
    scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_BOT_ID,
    scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_BOT_ID,
  );
  const longConnectionSecret = pickFirstNonEmptyString(
    longConnectionConfig.secret,
    compatLongConnectionSecret,
    scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_SECRET,
    scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_SECRET,
  );
  const resolvedLongConnectionUrl = pickFirstNonEmptyString(
    longConnectionConfig.url,
    scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_URL,
    scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_URL,
    "wss://openws.work.weixin.qq.com",
  );
  const longConnectionUrl =
    resolvedLongConnectionUrl === "wss://open.work.weixin.qq.com/ws/aibot"
      ? "wss://openws.work.weixin.qq.com"
      : resolvedLongConnectionUrl;
  const longConnectionPingIntervalMs = asBoundedPositiveInteger(
    longConnectionConfig.pingIntervalMs ??
      scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_PING_INTERVAL_MS ??
      scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_PING_INTERVAL_MS,
    30000,
    10000,
    120000,
  );
  const longConnectionReconnectDelayMs = asBoundedPositiveInteger(
    longConnectionConfig.reconnectDelayMs ??
      scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_RECONNECT_DELAY_MS ??
      scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_RECONNECT_DELAY_MS,
    5000,
    1000,
    60000,
  );
  const longConnectionMaxReconnectDelayMs = asBoundedPositiveInteger(
    longConnectionConfig.maxReconnectDelayMs ??
      scopedEnvVars?.WECOM_BOT_LONG_CONNECTION_MAX_RECONNECT_DELAY_MS ??
      scopedProcessEnv?.WECOM_BOT_LONG_CONNECTION_MAX_RECONNECT_DELAY_MS,
    60000,
    5000,
    300000,
  );

  return {
    accountId: normalizedAccountId,
    enabled,
    token: token || undefined,
    encodingAesKey: encodingAesKey || undefined,
    webhookPath: webhookPath || buildDefaultBotWebhookPath(normalizedAccountId),
    placeholderText,
    streamExpireMs,
    replyTimeoutMs,
    lateReplyWatchMs,
    lateReplyPollMs,
    card,
    longConnection: {
      enabled: longConnectionEnabled,
      botId: longConnectionBotId || undefined,
      secret: longConnectionSecret || undefined,
      url: longConnectionUrl || "wss://openws.work.weixin.qq.com",
      pingIntervalMs: longConnectionPingIntervalMs,
      reconnectDelayMs: longConnectionReconnectDelayMs,
      maxReconnectDelayMs: longConnectionMaxReconnectDelayMs,
    },
  };
}

export function resolveWecomBotModeAccountsConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const accountIds = new Set(["default"]);
  const channelAccounts = channelConfig?.accounts;
  if (channelAccounts && typeof channelAccounts === "object") {
    for (const accountId of Object.keys(channelAccounts)) {
      accountIds.add(normalizeAccountIdForEnv(accountId));
    }
  }
  for (const accountId of collectLegacyInlineAccountIds(channelConfig)) {
    accountIds.add(normalizeAccountIdForEnv(accountId));
  }

  const scopedBotIdRegex =
    /^WECOM_([A-Z0-9]+)_BOT_(ENABLED|TOKEN|ENCODING_AES_KEY|WEBHOOK_PATH|LONG_CONNECTION_ENABLED|LONG_CONNECTION_BOT_ID|LONG_CONNECTION_SECRET|LONG_CONNECTION_URL|LONG_CONNECTION_PING_INTERVAL_MS|LONG_CONNECTION_RECONNECT_DELAY_MS|LONG_CONNECTION_MAX_RECONNECT_DELAY_MS|PLACEHOLDER_TEXT|STREAM_EXPIRE_MS|REPLY_TIMEOUT_MS|LATE_REPLY_WATCH_MS|LATE_REPLY_POLL_MS|PROXY|CARD_ENABLED|CARD_MODE|CARD_TITLE|CARD_SUBTITLE|CARD_FOOTER|CARD_MAX_CONTENT_LENGTH|CARD_RESPONSE_URL_ENABLED|CARD_WEBHOOK_BOT_ENABLED)$/;
  const collectScopedIds = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      const match = key.match(scopedBotIdRegex);
      if (!match) continue;
      const candidate = String(match[1] ?? "").trim().toLowerCase();
      if (candidate) accountIds.add(candidate);
    }
  };
  collectScopedIds(envVars);
  collectScopedIds(processEnv);

  const hasScopedBotEnv = (accountId) => {
    const normalizedAccountId = normalizeAccountIdForEnv(accountId);
    if (normalizedAccountId === "default") return false;
    const prefix = `WECOM_${normalizedAccountId.toUpperCase()}_BOT_`;
    const hasIn = (obj) =>
      Boolean(
        obj &&
          typeof obj === "object" &&
          Object.keys(obj).some((key) => String(key ?? "").startsWith(prefix)),
      );
    return hasIn(envVars) || hasIn(processEnv);
  };

  const ordered = Array.from(accountIds).sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (a !== "default" && b === "default") return 1;
    return a.localeCompare(b);
  });

  const botConfigs = [];
  for (const accountId of ordered) {
    const resolved = resolveWecomBotModeConfig({
      channelConfig,
      envVars,
      processEnv,
      accountId,
    });
    const normalizedAccountId = normalizeAccountIdForEnv(accountId);
    const accountCfg =
      normalizedAccountId === "default"
        ? channelConfig
        : channelConfig?.accounts && typeof channelConfig.accounts === "object"
          ? (channelConfig.accounts[normalizedAccountId] ??
            resolveLegacyInlineAccountConfig(channelConfig, normalizedAccountId))
          : resolveLegacyInlineAccountConfig(channelConfig, normalizedAccountId);
    const hasBotConfigObject = Boolean(accountCfg && typeof accountCfg === "object" && accountCfg.bot && typeof accountCfg.bot === "object");
    if (
      normalizedAccountId !== "default" &&
      !hasBotConfigObject &&
      !hasScopedBotEnv(normalizedAccountId) &&
      resolved.enabled !== true &&
      !resolved.token &&
      !resolved.encodingAesKey &&
      resolved.longConnection?.enabled !== true
    ) {
      continue;
    }
    botConfigs.push(resolved);
  }
  return botConfigs;
}

function readVoiceEnv(envVars, processEnv, suffix) {
  const keys = [`WECOM_VOICE_TRANSCRIBE_${suffix}`, `WECOM_VOICE_${suffix}`];
  for (const key of keys) {
    const fromConfig = envVars?.[key];
    if (fromConfig != null && String(fromConfig).trim() !== "") return fromConfig;
    const fromProcess = processEnv?.[key];
    if (fromProcess != null && String(fromProcess).trim() !== "") return fromProcess;
  }
  return undefined;
}

export function normalizeAudioContentType(contentType) {
  const normalized = String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  return normalized || "";
}

export function isLocalVoiceInputTypeDirectlySupported(contentType) {
  const normalized = normalizeAudioContentType(contentType);
  if (!normalized) return false;
  return LOCAL_STT_DIRECT_SUPPORTED_CONTENT_TYPES.has(normalized);
}

export function pickAudioFileExtension({ contentType, fileName } = {}) {
  const normalized = normalizeAudioContentType(contentType);
  if (normalized && AUDIO_CONTENT_TYPE_TO_EXTENSION[normalized]) {
    return AUDIO_CONTENT_TYPE_TO_EXTENSION[normalized];
  }
  const extMatch = String(fileName ?? "")
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]{1,8})$/);
  if (extMatch) return `.${extMatch[1]}`;
  return ".bin";
}

export function resolveVoiceTranscriptionConfig({ channelConfig, envVars = {}, processEnv = process.env } = {}) {
  const voiceConfig =
    channelConfig?.voiceTranscription && typeof channelConfig.voiceTranscription === "object"
      ? channelConfig.voiceTranscription
      : {};

  const enabled = parseBooleanLike(
    voiceConfig.enabled,
    parseBooleanLike(readVoiceEnv(envVars, processEnv, "ENABLED"), true),
  );
  const providerRaw = pickFirstNonEmptyString(
    voiceConfig.provider,
    readVoiceEnv(envVars, processEnv, "PROVIDER"),
    "local-whisper-cli",
  );
  const provider = providerRaw.toLowerCase();
  const command = pickFirstNonEmptyString(
    voiceConfig.command,
    readVoiceEnv(envVars, processEnv, "COMMAND"),
  );
  const homebrewPrefix = pickFirstNonEmptyString(processEnv?.HOMEBREW_PREFIX);
  const defaultHomebrewModelPath = homebrewPrefix
    ? `${homebrewPrefix}/opt/whisper-cpp/share/whisper-cpp/for-tests-ggml-tiny.bin`
    : "";
  const modelPath = pickFirstNonEmptyString(
    voiceConfig.modelPath,
    readVoiceEnv(envVars, processEnv, "MODEL_PATH"),
    processEnv?.WHISPER_MODEL,
    processEnv?.WHISPER_MODEL_PATH,
    defaultHomebrewModelPath,
    "/usr/local/opt/whisper-cpp/share/whisper-cpp/for-tests-ggml-tiny.bin",
    "/opt/homebrew/opt/whisper-cpp/share/whisper-cpp/for-tests-ggml-tiny.bin",
  );
  const model = pickFirstNonEmptyString(
    voiceConfig.model,
    readVoiceEnv(envVars, processEnv, "MODEL"),
    "base",
  );
  const language = pickFirstNonEmptyString(
    voiceConfig.language,
    readVoiceEnv(envVars, processEnv, "LANGUAGE"),
  );
  const prompt = pickFirstNonEmptyString(
    voiceConfig.prompt,
    readVoiceEnv(envVars, processEnv, "PROMPT"),
  );
  const timeoutMs = asPositiveInteger(
    voiceConfig.timeoutMs,
    asPositiveInteger(readVoiceEnv(envVars, processEnv, "TIMEOUT_MS"), 120000),
  );
  const maxBytes = asPositiveInteger(
    voiceConfig.maxBytes,
    asPositiveInteger(readVoiceEnv(envVars, processEnv, "MAX_BYTES"), 10 * 1024 * 1024),
  );
  const ffmpegEnabled = parseBooleanLike(
    voiceConfig.ffmpegEnabled,
    parseBooleanLike(readVoiceEnv(envVars, processEnv, "FFMPEG_ENABLED"), true),
  );
  const transcodeToWav = parseBooleanLike(
    voiceConfig.transcodeToWav,
    parseBooleanLike(readVoiceEnv(envVars, processEnv, "TRANSCODE_TO_WAV"), true),
  );
  const requireModelPath = parseBooleanLike(
    voiceConfig.requireModelPath,
    parseBooleanLike(readVoiceEnv(envVars, processEnv, "REQUIRE_MODEL_PATH"), true),
  );

  return {
    enabled,
    provider,
    command: command || undefined,
    modelPath: modelPath || undefined,
    model,
    language: language || undefined,
    prompt: prompt || undefined,
    timeoutMs,
    maxBytes,
    ffmpegEnabled,
    transcodeToWav,
    requireModelPath,
  };
}
