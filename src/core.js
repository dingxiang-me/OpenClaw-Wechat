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

function asPositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
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
