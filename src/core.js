import crypto from "node:crypto";

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

const inboundMessageDedupe = new Map();

export function buildWecomSessionId(userId) {
  return `wecom:${String(userId ?? "").trim().toLowerCase()}`;
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

function readProxyEnv(envVars, processEnv, accountId = "default") {
  const normalizedId = normalizeAccountIdForEnv(accountId);
  const scopedProxyKey = normalizedId === "default" ? null : `WECOM_${normalizedId.toUpperCase()}_PROXY`;
  return pickFirstNonEmptyString(
    scopedProxyKey ? envVars?.[scopedProxyKey] : undefined,
    scopedProxyKey ? processEnv?.[scopedProxyKey] : undefined,
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
  );
  const fromChannelConfig = pickFirstNonEmptyString(
    channelConfig?.outboundProxy,
    channelConfig?.proxyUrl,
    channelConfig?.proxy,
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

export function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

function uniqueAllowFromList(values) {
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeWecomAllowFromEntry(value);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
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
  const enabled = parseBooleanLike(
    commandConfig.enabled,
    parseBooleanLike(envVars?.WECOM_COMMANDS_ENABLED, parseBooleanLike(processEnv?.WECOM_COMMANDS_ENABLED, false)),
  );
  const configuredAllowlist = uniqueCommandList(
    parseStringList(
      commandConfig.allowlist,
      envVars?.WECOM_COMMANDS_ALLOWLIST,
      processEnv?.WECOM_COMMANDS_ALLOWLIST,
    ),
  );
  const allowlist = configuredAllowlist.length > 0 ? configuredAllowlist : Array.from(DEFAULT_COMMAND_ALLOWLIST);
  const adminUsers = uniqueLowerCaseList(
    parseStringList(channelConfig?.adminUsers, envVars?.WECOM_ADMIN_USERS, processEnv?.WECOM_ADMIN_USERS),
  );
  const rejectMessage = pickFirstNonEmptyString(
    commandConfig.rejectMessage,
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
  const accountAllowFrom = uniqueAllowFromList(parseStringList(accountConfig?.allowFrom));
  const channelAllowFrom = uniqueAllowFromList(parseStringList(channelConfig?.allowFrom));
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

export function isWecomSenderAllowed({ senderId, allowFrom = [] } = {}) {
  const sender = normalizeWecomAllowFromEntry(senderId);
  if (!sender) return false;
  const normalizedAllowFrom = uniqueAllowFromList(Array.isArray(allowFrom) ? allowFrom : parseStringList(allowFrom));
  if (normalizedAllowFrom.length === 0 || normalizedAllowFrom.includes("*")) return true;
  return normalizedAllowFrom.includes(sender);
}

export function resolveWecomGroupChatConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const groupConfig =
    channelConfig?.groupChat && typeof channelConfig.groupChat === "object" ? channelConfig.groupChat : {};
  const enabled = parseBooleanLike(
    groupConfig.enabled,
    parseBooleanLike(envVars?.WECOM_GROUP_CHAT_ENABLED, parseBooleanLike(processEnv?.WECOM_GROUP_CHAT_ENABLED, true)),
  );
  const requireMention = parseBooleanLike(
    groupConfig.requireMention,
    parseBooleanLike(
      envVars?.WECOM_GROUP_CHAT_REQUIRE_MENTION,
      parseBooleanLike(processEnv?.WECOM_GROUP_CHAT_REQUIRE_MENTION, false),
    ),
  );
  const mentionPatterns = parseStringList(
    groupConfig.mentionPatterns,
    envVars?.WECOM_GROUP_CHAT_MENTION_PATTERNS,
    processEnv?.WECOM_GROUP_CHAT_MENTION_PATTERNS,
    "@",
  );
  const dedupedPatterns = [];
  const seen = new Set();
  for (const pattern of mentionPatterns) {
    const token = String(pattern ?? "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    dedupedPatterns.push(token);
  }

  return {
    enabled,
    requireMention,
    mentionPatterns: dedupedPatterns.length > 0 ? dedupedPatterns : ["@"],
  };
}

export function shouldTriggerWecomGroupResponse(content, groupChatConfig) {
  if (groupChatConfig?.enabled === false) return false;
  if (groupChatConfig?.requireMention !== true) return true;
  const text = String(content ?? "");
  if (!text.trim()) return false;
  const patterns =
    Array.isArray(groupChatConfig?.mentionPatterns) && groupChatConfig.mentionPatterns.length > 0
      ? groupChatConfig.mentionPatterns
      : ["@"];
  return patterns.some((pattern) => {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function resolveWecomBotModeConfig({
  channelConfig = {},
  envVars = {},
  processEnv = process.env,
} = {}) {
  const botConfig = channelConfig?.bot && typeof channelConfig.bot === "object" ? channelConfig.bot : {};
  const enabled = parseBooleanLike(
    botConfig.enabled,
    parseBooleanLike(envVars?.WECOM_BOT_ENABLED, parseBooleanLike(processEnv?.WECOM_BOT_ENABLED, false)),
  );
  const token = pickFirstNonEmptyString(
    botConfig.token,
    envVars?.WECOM_BOT_TOKEN,
    processEnv?.WECOM_BOT_TOKEN,
  );
  const encodingAesKey = pickFirstNonEmptyString(
    botConfig.encodingAesKey,
    envVars?.WECOM_BOT_ENCODING_AES_KEY,
    processEnv?.WECOM_BOT_ENCODING_AES_KEY,
  );
  const webhookPath = pickFirstNonEmptyString(
    botConfig.webhookPath,
    envVars?.WECOM_BOT_WEBHOOK_PATH,
    processEnv?.WECOM_BOT_WEBHOOK_PATH,
    "/wecom/bot/callback",
  );
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
  const placeholderText = (() => {
    if (hasOwn(botConfig, "placeholderText")) return String(botConfig.placeholderText ?? "");
    if (hasOwn(envVars, "WECOM_BOT_PLACEHOLDER_TEXT")) return String(envVars.WECOM_BOT_PLACEHOLDER_TEXT ?? "");
    if (hasOwn(processEnv, "WECOM_BOT_PLACEHOLDER_TEXT"))
      return String(processEnv.WECOM_BOT_PLACEHOLDER_TEXT ?? "");
    return "消息已收到，正在处理中，请稍等片刻。";
  })();
  const streamExpireMs = asBoundedPositiveInteger(
    botConfig.streamExpireMs ??
      envVars?.WECOM_BOT_STREAM_EXPIRE_MS ??
      processEnv?.WECOM_BOT_STREAM_EXPIRE_MS,
    10 * 60 * 1000,
    30 * 1000,
    60 * 60 * 1000,
  );

  return {
    enabled,
    token: token || undefined,
    encodingAesKey: encodingAesKey || undefined,
    webhookPath: webhookPath || "/wecom/bot/callback",
    placeholderText,
    streamExpireMs,
  };
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
