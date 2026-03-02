import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { normalizePluginHttpPath } from "openclaw/plugin-sdk";
import { writeFile, unlink, mkdir, readFile, stat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { ProxyAgent } from "undici";
import { WecomSessionTaskQueue, WecomStreamManager } from "./core/stream-manager.js";
import { createWecomDeliveryRouter, parseWecomResponseUrlResult } from "./core/delivery-router.js";
import { resolveWebhookBotSendUrl, webhookSendText } from "./wecom/webhook-bot.js";
import { resolveWecomAgentRoute } from "./core/agent-routing.js";
import {
  buildWecomBotMixedPayload,
  describeWecomBotParsedMessage,
  extractWecomXmlInboundEnvelope,
  normalizeWecomBotOutboundMediaUrls,
  parseWecomBotInboundMessage,
} from "./wecom/webhook-adapter.js";
import {
  WECOM_TEXT_BYTE_LIMIT,
  buildWecomSessionId,
  buildInboundDedupeKey,
  markInboundMessageSeen,
  resetInboundMessageDedupeForTests,
  computeMsgSignature,
  getByteLength,
  isLocalVoiceInputTypeDirectlySupported,
  normalizeAudioContentType,
  pickAudioFileExtension,
  extractLeadingSlashCommand,
  isWecomSenderAllowed,
  resolveWecomAllowFromPolicyConfig,
  resolveWecomBotModeConfig,
  resolveWecomCommandPolicyConfig,
  resolveWecomDebounceConfig,
  resolveWecomDeliveryFallbackConfig,
  resolveWecomDynamicAgentConfig,
  resolveWecomGroupChatConfig,
  resolveWecomObservabilityConfig,
  resolveWecomStreamingConfig,
  resolveWecomStreamManagerConfig,
  resolveWecomWebhookBotDeliveryConfig,
  resolveVoiceTranscriptionConfig,
  resolveWecomProxyConfig,
  shouldStripWecomGroupMentions,
  shouldTriggerWecomGroupResponse,
  stripWecomGroupMentions,
  splitWecomText,
  pickAccountBySignature,
} from "./core.js";
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false, // 禁用实体处理，防止 XXE 攻击
});

// 请求体大小限制 (1MB)
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
const PLUGIN_VERSION = "0.5.0";
const WECOM_TEMP_DIR_NAME = "openclaw-wechat";
const WECOM_TEMP_FILE_RETENTION_MS = 30 * 60 * 1000;
const FFMPEG_PATH_CHECK_CACHE = {
  checked: false,
  available: false,
};
const COMMAND_PATH_CHECK_CACHE = new Map();
const WECOM_PROXY_DISPATCHER_CACHE = new Map();
const INVALID_PROXY_CACHE = new Set();
const TEXT_MESSAGE_DEBOUNCE_BUFFERS = new Map();
const ACTIVE_LATE_REPLY_WATCHERS = new Map();
const DELIVERED_TRANSCRIPT_REPLY_CACHE = new Map();
const TRANSCRIPT_REPLY_CACHE_TTL_MS = 30 * 60 * 1000;
const BOT_STREAM_MANAGER = new WecomStreamManager({ expireMs: 10 * 60 * 1000 });
const BOT_SESSION_TASK_QUEUE = new WecomSessionTaskQueue({ maxConcurrentPerSession: 1 });
const WECOM_SESSION_TASK_QUEUE = new WecomSessionTaskQueue({ maxConcurrentPerSession: 1 });
const BOT_RESPONSE_URL_CACHE = new Map();
const BOT_RESPONSE_URL_TTL_MS = 60 * 60 * 1000;

function readRequestBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function decodeAesKey(aesKey) {
  const base64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(`Invalid callbackAesKey: expected 32-byte key, got ${key.length}`);
  }
  return key;
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function decryptWecom({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(cipherTextBase64, "base64")),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(plain);

  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const msg = unpadded.subarray(msgStart, msgEnd).toString("utf8");
  const corpId = unpadded.subarray(msgEnd).toString("utf8");
  return { msg, corpId };
}

function decryptWecomMediaBuffer({ aesKey, encryptedBuffer }) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
    throw new Error("empty media buffer");
  }
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1];
  if (!Number.isFinite(padLen) || padLen < 1 || padLen > 32) {
    return decrypted;
  }
  for (let i = decrypted.length - padLen; i < decrypted.length; i += 1) {
    if (decrypted[i] !== padLen) return decrypted;
  }
  return decrypted.subarray(0, decrypted.length - padLen);
}

function pkcs7Pad(buf, blockSize = 32) {
  const amountToPad = blockSize - (buf.length % blockSize || blockSize);
  const pad = Buffer.alloc(amountToPad === 0 ? blockSize : amountToPad, amountToPad === 0 ? blockSize : amountToPad);
  return Buffer.concat([buf, pad]);
}

function encryptWecom({ aesKey, plainText, corpId = "" }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msgBuffer = Buffer.from(String(plainText ?? ""), "utf8");
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32BE(msgBuffer.length, 0);
  const corpBuffer = Buffer.from(String(corpId ?? ""), "utf8");
  const raw = Buffer.concat([random16, lenBuffer, msgBuffer, corpBuffer]);
  const padded = pkcs7Pad(raw, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

function parseIncomingXml(xml) {
  const obj = xmlParser.parse(xml);
  const root = obj?.xml ?? obj;
  return root;
}

function parseIncomingJson(jsonText) {
  if (!jsonText) return null;
  const parsed = JSON.parse(jsonText);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function buildWecomBotEncryptedResponse({ token, aesKey, timestamp, nonce, plainPayload }) {
  const plainText = JSON.stringify(plainPayload ?? {});
  const encrypt = encryptWecom({
    aesKey,
    plainText,
    corpId: "",
  });
  const msgsignature = computeMsgSignature({
    token,
    timestamp,
    nonce,
    encrypt,
  });
  return JSON.stringify({
    encrypt,
    msgsignature,
    timestamp: String(timestamp ?? ""),
    nonce: String(nonce ?? ""),
  });
}

function createBotStream(streamId, initialContent = "") {
  return BOT_STREAM_MANAGER.create(streamId, initialContent);
}

function updateBotStream(streamId, content, { append = false, finished = false } = {}) {
  return BOT_STREAM_MANAGER.update(streamId, content, { append, finished });
}

function finishBotStream(streamId, content) {
  return BOT_STREAM_MANAGER.finish(streamId, content);
}

function getBotStream(streamId) {
  return BOT_STREAM_MANAGER.get(streamId);
}

function hasBotStream(streamId) {
  return BOT_STREAM_MANAGER.has(streamId);
}

function upsertBotResponseUrlCache({ sessionId, responseUrl }) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  const normalizedUrl = String(responseUrl ?? "").trim();
  if (!normalizedSessionId || !normalizedUrl) return;
  BOT_RESPONSE_URL_CACHE.set(normalizedSessionId, {
    url: normalizedUrl,
    used: false,
    expiresAt: Date.now() + BOT_RESPONSE_URL_TTL_MS,
    updatedAt: Date.now(),
  });
}

function getBotResponseUrlCache(sessionId) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId) return null;
  const cached = BOT_RESPONSE_URL_CACHE.get(normalizedSessionId);
  if (!cached) return null;
  if (Number(cached.expiresAt || 0) <= Date.now()) {
    BOT_RESPONSE_URL_CACHE.delete(normalizedSessionId);
    return null;
  }
  return cached;
}

function markBotResponseUrlUsed(sessionId) {
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedSessionId) return;
  const cached = BOT_RESPONSE_URL_CACHE.get(normalizedSessionId);
  if (!cached) return;
  cached.used = true;
  cached.updatedAt = Date.now();
  BOT_RESPONSE_URL_CACHE.set(normalizedSessionId, cached);
}

function cleanupBotResponseUrlCache(ttlMs = BOT_RESPONSE_URL_TTL_MS) {
  const now = Date.now();
  for (const [sessionId, cached] of BOT_RESPONSE_URL_CACHE.entries()) {
    const expiresAt = Number(cached?.expiresAt ?? now + ttlMs);
    if (expiresAt <= now) {
      BOT_RESPONSE_URL_CACHE.delete(sessionId);
    }
  }
}

function cleanupExpiredBotStreams(expireMs = 10 * 60 * 1000) {
  BOT_STREAM_MANAGER.cleanup(expireMs);
  cleanupBotResponseUrlCache();
}

function ensureBotStreamCleanupTimer(expireMs, logger) {
  BOT_STREAM_MANAGER.startCleanup({ expireMs, logger });
}

function requireEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v;
}

function buildWecomBotSessionId(userId) {
  return `wecom-bot:${String(userId ?? "").trim().toLowerCase()}`;
}

function asNumber(v, fallback = null) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function scheduleTempFileCleanup(filePath, logger, delayMs = WECOM_TEMP_FILE_RETENTION_MS) {
  if (!filePath) return;
  const timer = setTimeout(() => {
    unlink(filePath).catch((err) => {
      logger?.warn?.(`wecom: failed to cleanup temp file ${filePath}: ${String(err?.message || err)}`);
    });
  }, delayMs);
  timer.unref?.();
}

// 企业微信 access_token 缓存（支持多账户）
const accessTokenCaches = new Map(); // key: corpId, value: { token, expiresAt, refreshPromise }

async function getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger }) {
  const cacheKey = corpId;
  let cache = accessTokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: null, expiresAt: 0, refreshPromise: null };
    accessTokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60000) {
    return cache.token;
  }

  // 如果已有刷新在进行中，等待它完成
  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const tokenRes = await fetchWithRetry(tokenUrl, {}, 3, 1000, { proxyUrl, logger });
      const tokenJson = await tokenRes.json();
      if (!tokenJson?.access_token) {
        throw new Error(`WeCom gettoken failed: ${JSON.stringify(tokenJson)}`);
      }

      cache.token = tokenJson.access_token;
      cache.expiresAt = Date.now() + (tokenJson.expires_in || 7200) * 1000;

      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

// Markdown 转换为企业微信纯文本
// 企业微信不支持 Markdown 渲染，需要转换为可读的纯文本格式
function markdownToWecomText(markdown) {
  if (!markdown) return markdown;

  let text = markdown;

  // 移除代码块标记，保留内容并添加缩进
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const lines = code.trim().split('\n').map(line => '  ' + line).join('\n');
    return lang ? `[${lang}]\n${lines}` : lines;
  });

  // 移除行内代码标记
  text = text.replace(/`([^`]+)`/g, '$1');

  // 转换标题为带符号的格式
  text = text.replace(/^### (.+)$/gm, '▸ $1');
  text = text.replace(/^## (.+)$/gm, '■ $1');
  text = text.replace(/^# (.+)$/gm, '◆ $1');

  // 移除粗体/斜体标记，保留内容
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/___([^_]+)___/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');

  // 转换链接为 "文字 (URL)" 格式
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 转换无序列表标记
  text = text.replace(/^[\*\-] /gm, '• ');

  // 转换有序列表（保持原样，数字已经可读）

  // 转换水平线
  text = text.replace(/^[-*_]{3,}$/gm, '────────────');

  // 移除图片标记，保留 alt 文字
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图片: $1]');

  // 清理多余空行（保留最多两个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function isAgentFailureText(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes("request was aborted") || normalized.includes("fetch failed");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isDispatchTimeoutError(err) {
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return text.includes("dispatch timed out after") || text.includes("operation timed out after");
}

function normalizeAssistantReplyText(text) {
  if (text == null) return "";
  return String(text)
    .replace(/\[\[\s*reply_to(?:_|:|\s*)current\s*\]\]/gi, "")
    .replace(/\[\[\s*reply_to\s*:\s*current\s*\]\]/gi, "")
    .trim();
}

function extractAssistantTextFromTranscriptMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (message.role !== "assistant") return "";
  const stopReason = String(message.stopReason ?? "").trim().toLowerCase();
  if (stopReason === "error" || stopReason === "aborted") return "";

  const content = message.content;
  if (typeof content === "string") {
    return normalizeAssistantReplyText(content);
  }
  if (!Array.isArray(content)) return "";

  const chunks = [];
  for (const block of content) {
    if (typeof block === "string") {
      const text = normalizeAssistantReplyText(block);
      if (text) chunks.push(text);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const blockType = String(block.type ?? "").trim().toLowerCase();
    if (!["text", "output_text", "markdown", "final_text"].includes(blockType)) continue;
    const text = normalizeAssistantReplyText(block.text);
    if (text) chunks.push(text);
  }
  return normalizeAssistantReplyText(chunks.join("\n").trim());
}

function pruneDeliveredTranscriptReplyCache(now = Date.now()) {
  for (const [cacheKey, expiresAt] of DELIVERED_TRANSCRIPT_REPLY_CACHE.entries()) {
    if (expiresAt <= now) DELIVERED_TRANSCRIPT_REPLY_CACHE.delete(cacheKey);
  }
}

function markTranscriptReplyDelivered(sessionId, transcriptMessageId) {
  const cacheKey = `${String(sessionId ?? "").trim().toLowerCase()}:${String(transcriptMessageId ?? "").trim()}`;
  if (!cacheKey) return;
  pruneDeliveredTranscriptReplyCache();
  DELIVERED_TRANSCRIPT_REPLY_CACHE.set(cacheKey, Date.now() + TRANSCRIPT_REPLY_CACHE_TTL_MS);
}

function hasTranscriptReplyBeenDelivered(sessionId, transcriptMessageId) {
  const cacheKey = `${String(sessionId ?? "").trim().toLowerCase()}:${String(transcriptMessageId ?? "").trim()}`;
  if (!cacheKey) return false;
  pruneDeliveredTranscriptReplyCache();
  const expiresAt = DELIVERED_TRANSCRIPT_REPLY_CACHE.get(cacheKey);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

async function resolveSessionTranscriptFilePath({ storePath, sessionKey, sessionId, logger }) {
  const fallbackPath = join(dirname(storePath), `${sessionId}.jsonl`);
  try {
    const raw = await readFile(storePath, "utf8");
    const store = JSON.parse(raw);
    if (!store || typeof store !== "object") return fallbackPath;
    const entry =
      store?.[sessionKey] ??
      Object.values(store).find((value) => value?.sessionId === sessionId && typeof value?.sessionFile === "string");
    const sessionFile = String(entry?.sessionFile ?? "").trim();
    if (!sessionFile) return fallbackPath;
    if (isAbsolute(sessionFile)) return sessionFile;
    return join(dirname(storePath), sessionFile);
  } catch (err) {
    logger?.warn?.(
      `wecom: failed to resolve session transcript path from store (${sessionKey}): ${String(err?.message || err)}`,
    );
    return fallbackPath;
  }
}

async function readTranscriptAppendedChunk(filePath, offset) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { nextOffset: offset, chunk: "" };
  }

  const fileSize = Number(fileStat.size ?? 0);
  if (!Number.isFinite(fileSize) || fileSize <= offset) {
    return { nextOffset: offset, chunk: "" };
  }

  const readLength = fileSize - offset;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, offset);
    return { nextOffset: fileSize, chunk: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function parseLateAssistantReplyFromTranscriptLine(line, minTimestamp = 0) {
  if (!line?.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "message") return null;
    const message = entry?.message;
    const text = extractAssistantTextFromTranscriptMessage(message);
    if (!text || isAgentFailureText(text)) return null;
    const timestamp = Number(message?.timestamp ?? Date.parse(String(entry?.timestamp ?? "")) ?? 0);
    if (minTimestamp > 0 && Number.isFinite(timestamp) && timestamp > 0 && timestamp + 1000 < minTimestamp) {
      return null;
    }
    const transcriptMessageId = String(entry?.id ?? "").trim() || `${timestamp || Date.now()}-${text.slice(0, 32)}`;
    return {
      transcriptMessageId,
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  } catch {
    return null;
  }
}

function isWecomApiUrl(url) {
  const raw = typeof url === "string" ? url : String(url ?? "");
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "qyapi.weixin.qq.com";
  } catch {
    return raw.includes("qyapi.weixin.qq.com");
  }
}

function isLikelyHttpProxyUrl(proxyUrl) {
  return /^https?:\/\/\S+$/i.test(proxyUrl);
}

function sanitizeProxyForLog(proxyUrl) {
  const raw = String(proxyUrl ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function resolveWecomProxyDispatcher(proxyUrl, logger) {
  const normalized = String(proxyUrl ?? "").trim();
  if (!normalized) return null;
  const printableProxy = sanitizeProxyForLog(normalized);
  if (WECOM_PROXY_DISPATCHER_CACHE.has(normalized)) {
    return WECOM_PROXY_DISPATCHER_CACHE.get(normalized);
  }
  if (!isLikelyHttpProxyUrl(normalized)) {
    if (!INVALID_PROXY_CACHE.has(normalized)) {
      INVALID_PROXY_CACHE.add(normalized);
      logger?.warn?.(`wecom: outboundProxy ignored (invalid url): ${printableProxy}`);
    }
    return null;
  }
  try {
    const dispatcher = new ProxyAgent(normalized);
    WECOM_PROXY_DISPATCHER_CACHE.set(normalized, dispatcher);
    logger?.info?.(`wecom: outbound proxy enabled (${printableProxy})`);
    return dispatcher;
  } catch (err) {
    if (!INVALID_PROXY_CACHE.has(normalized)) {
      INVALID_PROXY_CACHE.add(normalized);
      logger?.warn?.(
        `wecom: outboundProxy init failed (${printableProxy}): ${String(err?.message || err)}`,
      );
    }
    return null;
  }
}

function attachWecomProxyDispatcher(url, options = {}, { proxyUrl, logger } = {}) {
  const shouldForceProxy = options?.forceProxy === true;
  if (!isWecomApiUrl(url) && !shouldForceProxy) return options;
  if (options?.dispatcher) return options;
  const dispatcher = resolveWecomProxyDispatcher(proxyUrl, logger);
  if (!dispatcher) return options;
  const { forceProxy, ...restOptions } = options || {};
  return {
    ...restOptions,
    dispatcher,
  };
}

// 带重试机制的 fetch 包装函数
async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 1000, requestContext = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const requestOptions = attachWecomProxyDispatcher(url, options, requestContext);
      const res = await fetch(url, requestOptions);
      
      // 如果是 2xx 以外的状态码，可能需要重试（根据业务逻辑判断）
      if (!res.ok && attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      // 如果是企业微信 API，检查 errcode
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.clone().json();
        // errcode: -1 表示系统繁忙，建议重试
        if (json?.errcode === -1 && attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
    }
  }
  throw lastError || new Error(`Fetch failed after ${maxRetries} retries`);
}

function runProcessWithTimeout({ command, args, timeoutMs = 15000, allowNonZeroExitCode = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && !allowNonZeroExitCode) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function checkCommandAvailable(command) {
  const normalized = String(command ?? "").trim();
  if (!normalized) return false;
  if (COMMAND_PATH_CHECK_CACHE.has(normalized)) {
    return COMMAND_PATH_CHECK_CACHE.get(normalized);
  }
  try {
    await runProcessWithTimeout({
      command: normalized,
      args: ["--help"],
      timeoutMs: 4000,
      allowNonZeroExitCode: true,
    });
    COMMAND_PATH_CHECK_CACHE.set(normalized, true);
    return true;
  } catch (err) {
    COMMAND_PATH_CHECK_CACHE.set(normalized, false);
    return false;
  }
}

async function ensureFfmpegAvailable(logger) {
  if (FFMPEG_PATH_CHECK_CACHE.checked) return FFMPEG_PATH_CHECK_CACHE.available;
  const available = await checkCommandAvailable("ffmpeg");
  FFMPEG_PATH_CHECK_CACHE.checked = true;
  FFMPEG_PATH_CHECK_CACHE.available = available;
  if (!available) {
    logger?.warn?.("wecom: ffmpeg not available");
  }
  return available;
}

async function resolveLocalWhisperCommand({ voiceConfig, logger }) {
  const provider = String(voiceConfig.provider ?? "").trim().toLowerCase();
  const explicitCommand = String(voiceConfig.command ?? "").trim();
  const fallbackCandidates =
    provider === "local-whisper"
      ? ["whisper"]
      : provider === "local-whisper-cli"
        ? ["whisper-cli"]
        : [];
  const candidates = explicitCommand ? [explicitCommand, ...fallbackCandidates] : fallbackCandidates;

  if (candidates.length === 0) {
    throw new Error(
      `unsupported voice transcription provider: ${provider || "unknown"} (supported: local-whisper-cli/local-whisper)`,
    );
  }

  for (const cmd of candidates) {
    if (await checkCommandAvailable(cmd)) {
      if (explicitCommand && cmd !== explicitCommand) {
        logger?.warn?.(`wecom: voice command ${explicitCommand} unavailable, fallback to ${cmd}`);
      }
      return cmd;
    }
  }

  throw new Error(`local transcription command not found: ${candidates.join(" / ")}`);
}

function resolveWecomVoiceTranscriptionConfig(api) {
  const cfg = api?.config ?? {};
  return resolveVoiceTranscriptionConfig({
    channelConfig: cfg?.channels?.wecom,
    envVars: cfg?.env?.vars ?? {},
    processEnv: process.env,
  });
}

async function transcodeAudioToWav({
  buffer,
  inputContentType,
  inputFileName,
  logger,
  timeoutMs = 30000,
}) {
  const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
  await mkdir(tempDir, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputExt = pickAudioFileExtension({ contentType: inputContentType, fileName: inputFileName });
  const inputPath = join(tempDir, `voice-input-${nonce}${inputExt || ".bin"}`);
  const outputPath = join(tempDir, `voice-output-${nonce}.wav`);

  try {
    await writeFile(inputPath, buffer);
    await runProcessWithTimeout({
      command: "ffmpeg",
      args: [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        outputPath,
      ],
      timeoutMs,
    });
    const outputBuffer = await readFile(outputPath);
    logger?.info?.(`wecom: transcoded voice to wav size=${outputBuffer.length} bytes`);
    return {
      buffer: outputBuffer,
      contentType: "audio/wav",
      fileName: `voice-${Date.now()}.wav`,
    };
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}

async function transcribeWithWhisperCli({
  command,
  modelPath,
  audioPath,
  language,
  prompt,
  timeoutMs,
}) {
  if (!modelPath) {
    throw new Error("local-whisper-cli requires voiceTranscription.modelPath");
  }

  const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
  await mkdir(tempDir, { recursive: true });
  const outputBase = join(tempDir, `voice-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outputTxt = `${outputBase}.txt`;

  const args = ["-m", modelPath, "-f", audioPath, "-otxt", "-of", outputBase, "--no-prints"];
  if (language) args.push("-l", language);
  if (prompt) args.push("--prompt", prompt);

  try {
    await runProcessWithTimeout({
      command,
      args,
      timeoutMs,
    });
    const transcript = String(await readFile(outputTxt, "utf8")).trim();
    if (!transcript) {
      throw new Error("whisper-cli transcription output is empty");
    }
    return transcript;
  } finally {
    await Promise.allSettled([unlink(outputTxt)]);
  }
}

async function transcribeWithWhisperPython({
  command,
  model,
  audioPath,
  language,
  prompt,
  timeoutMs,
}) {
  const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
  await mkdir(tempDir, { recursive: true });
  const audioBaseName = basename(audioPath, extname(audioPath));
  const outputTxt = join(tempDir, `${audioBaseName}.txt`);

  const args = [
    audioPath,
    "--model",
    model || "base",
    "--output_format",
    "txt",
    "--output_dir",
    tempDir,
    "--task",
    "transcribe",
  ];
  if (language) args.push("--language", language);
  if (prompt) args.push("--initial_prompt", prompt);

  try {
    await runProcessWithTimeout({
      command,
      args,
      timeoutMs,
    });
    const transcript = String(await readFile(outputTxt, "utf8")).trim();
    if (!transcript) {
      throw new Error("whisper transcription output is empty");
    }
    return transcript;
  } finally {
    await Promise.allSettled([unlink(outputTxt)]);
  }
}

async function transcribeInboundVoice({
  api,
  buffer,
  contentType,
  mediaId,
  voiceConfig,
}) {
  if (!voiceConfig.enabled) {
    throw new Error("voice transcription is disabled");
  }

  let audioBuffer = buffer;
  let normalizedContentType = normalizeAudioContentType(contentType) || "application/octet-stream";
  let fileName = `voice-${mediaId}${pickAudioFileExtension({
    contentType: normalizedContentType,
    fileName: `voice-${mediaId}`,
  })}`;

  if (audioBuffer.length > voiceConfig.maxBytes) {
    throw new Error(`audio size ${audioBuffer.length} exceeds maxBytes ${voiceConfig.maxBytes}`);
  }

  const isWav = normalizedContentType === "audio/wav" || normalizedContentType === "audio/x-wav";
  const unsupportedDirect = !isLocalVoiceInputTypeDirectlySupported(normalizedContentType);
  const shouldTranscode = unsupportedDirect || (voiceConfig.transcodeToWav === true && !isWav);
  if (shouldTranscode) {
    if (!voiceConfig.ffmpegEnabled) {
      throw new Error(
        `content type ${normalizedContentType || "unknown"} requires ffmpeg conversion but ffmpegEnabled=false`,
      );
    }
    const ffmpegAvailable = await ensureFfmpegAvailable(api.logger);
    if (!ffmpegAvailable) {
      throw new Error(
        `unsupported content type ${normalizedContentType || "unknown"} and ffmpeg not available`,
      );
    }
    const transcoded = await transcodeAudioToWav({
      buffer: audioBuffer,
      inputContentType: normalizedContentType,
      inputFileName: fileName,
      logger: api.logger,
      timeoutMs: Math.max(10000, Math.min(voiceConfig.timeoutMs, 45000)),
    });
    audioBuffer = transcoded.buffer;
    normalizedContentType = transcoded.contentType;
    fileName = transcoded.fileName;
  }

  const command = await resolveLocalWhisperCommand({ voiceConfig, logger: api.logger });
  const provider = String(voiceConfig.provider ?? "").trim().toLowerCase();

  const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
  await mkdir(tempDir, { recursive: true });
  const audioPath = join(
    tempDir,
    `voice-transcribe-${Date.now()}-${Math.random().toString(36).slice(2)}${pickAudioFileExtension({
      contentType: normalizedContentType,
      fileName,
    })}`,
  );

  await writeFile(audioPath, audioBuffer);
  try {
    if (provider === "local-whisper-cli") {
      if (voiceConfig.requireModelPath !== false && !voiceConfig.modelPath) {
        throw new Error(
          "voiceTranscription.modelPath is required for local-whisper-cli (or set requireModelPath=false)",
        );
      }
      const transcript = await transcribeWithWhisperCli({
        command,
        modelPath: voiceConfig.modelPath,
        audioPath,
        language: voiceConfig.language,
        prompt: voiceConfig.prompt,
        timeoutMs: voiceConfig.timeoutMs,
      });
      return transcript;
    }

    if (provider === "local-whisper") {
      const transcript = await transcribeWithWhisperPython({
        command,
        model: voiceConfig.model,
        audioPath,
        language: voiceConfig.language,
        prompt: voiceConfig.prompt,
        timeoutMs: voiceConfig.timeoutMs,
      });
      return transcript;
    }

    throw new Error(`unsupported local provider ${provider}`);
  } finally {
    await Promise.allSettled([unlink(audioPath)]);
  }
}

// 简单的限流器，防止触发企业微信 API 限流
class RateLimiter {
  constructor({ maxConcurrent = 3, minInterval = 200 }) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.running = 0;
    this.queue = [];
    this.lastExecution = 0;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitTime = Math.max(0, this.lastExecution + this.minInterval - now);

    if (waitTime > 0) {
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    this.running++;
    this.lastExecution = Date.now();

    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running--;
      this.processQueue();
    }
  }
}

// API 调用限流器（最多3并发，200ms间隔）
const apiLimiter = new RateLimiter({ maxConcurrent: 3, minInterval: 200 });

// 消息处理限流器（最多2并发，适合 1GB 内存环境）
const messageProcessLimiter = new RateLimiter({ maxConcurrent: 2, minInterval: 0 });

// 发送单条文本消息（内部函数，带限流）
async function sendWecomTextSingle({
  corpId,
  corpSecret,
  agentId,
  toUser,
  text,
  logger,
  proxyUrl,
}) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });

    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "text",
      agentid: agentId,
      text: { content: text },
      safe: 0,
    };
    const sendRes = await fetchWithRetry(
      sendUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      3,
      1000,
      { proxyUrl, logger },
    );
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom message/send failed: ${JSON.stringify(sendJson)}`);
    }
    logger?.info?.(`wecom: message sent ok (to=${toUser}, msgid=${sendJson?.msgid || "n/a"})`);
    return sendJson;
  });
}

// 发送文本消息（支持自动分段）
async function sendWecomText({ corpId, corpSecret, agentId, toUser, text, logger, proxyUrl }) {
  const chunks = splitWecomText(text);

  logger?.info?.(`wecom: splitting message into ${chunks.length} chunks, total bytes=${getByteLength(text)}`);

  for (let i = 0; i < chunks.length; i++) {
    logger?.info?.(`wecom: sending chunk ${i + 1}/${chunks.length}, bytes=${getByteLength(chunks[i])}`);
    await sendWecomTextSingle({ corpId, corpSecret, agentId, toUser, text: chunks[i], logger, proxyUrl });
    // 分段发送时添加间隔，避免触发限流
    if (i < chunks.length - 1) {
      await sleep(300);
    }
  }
}

// 上传临时素材到企业微信
async function uploadWecomMedia({ corpId, corpSecret, type, buffer, filename, logger, proxyUrl }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`;

  // 构建 multipart/form-data
  const boundary = "----WecomMediaUpload" + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const res = await fetchWithRetry(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
    3,
    1000,
    { proxyUrl, logger },
  );

  const json = await res.json();
  if (json.errcode !== 0) {
    throw new Error(`WeCom media upload failed: ${JSON.stringify(json)}`);
  }

  return json.media_id;
}

// 发送图片消息（带限流）
async function sendWecomImage({ corpId, corpSecret, agentId, toUser, mediaId, logger, proxyUrl }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

    const body = {
      touser: toUser,
      msgtype: "image",
      agentid: agentId,
      image: { media_id: mediaId },
      safe: 0,
    };

    const sendRes = await fetchWithRetry(
      sendUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      3,
      1000,
      { proxyUrl, logger },
    );

    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom image send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送视频消息（带限流）
async function sendWecomVideo({
  corpId,
  corpSecret,
  agentId,
  toUser,
  mediaId,
  title,
  description,
  logger,
  proxyUrl,
}) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "video",
      agentid: agentId,
      video: {
        media_id: mediaId,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      },
      safe: 0,
    };
    const sendRes = await fetchWithRetry(
      sendUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      3,
      1000,
      { proxyUrl, logger },
    );
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom video send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送文件消息（带限流）
async function sendWecomFile({ corpId, corpSecret, agentId, toUser, mediaId, logger, proxyUrl }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "file",
      agentid: agentId,
      file: { media_id: mediaId },
      safe: 0,
    };
    const sendRes = await fetchWithRetry(
      sendUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      3,
      1000,
      { proxyUrl, logger },
    );
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom file send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 从 URL 下载媒体文件
async function fetchMediaFromUrl(url, { proxyUrl, logger, forceProxy = false, maxBytes = 10 * 1024 * 1024 } = {}) {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": `OpenClaw-Wechat/${PLUGIN_VERSION}`,
        Accept: "*/*",
      },
      forceProxy,
    },
    3,
    1000,
    { proxyUrl, logger },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch media from URL: ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > maxBytes) {
    throw new Error(`Media too large (${contentLength} bytes > ${maxBytes} bytes)`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Media too large (${buffer.length} bytes > ${maxBytes} bytes)`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}

function detectImageContentTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  // JPEG
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF87a / GIF89a
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  // WEBP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // BMP
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  // HEIC / HEIF (ISO BMFF ftyp brand)
  if (buffer.length >= 12) {
    const boxType = buffer.subarray(4, 8).toString("ascii");
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (boxType === "ftyp") {
      if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("hevc") || brand.startsWith("hevx")) {
        return "image/heic";
      }
      if (brand.startsWith("mif1") || brand.startsWith("msf1")) {
        return "image/heif";
      }
    }
  }
  return "";
}

function pickImageFileExtension({ contentType, sourceUrl }) {
  const normalizedType = String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (normalizedType.includes("png")) return ".png";
  if (normalizedType.includes("gif")) return ".gif";
  if (normalizedType.includes("webp")) return ".webp";
  if (normalizedType.includes("bmp")) return ".bmp";
  if (normalizedType.includes("heic")) return ".heic";
  if (normalizedType.includes("heif")) return ".heif";
  if (normalizedType.includes("jpg") || normalizedType.includes("jpeg")) return ".jpg";

  const rawPath = String(sourceUrl ?? "").trim().split("?")[0].split("#")[0];
  const ext = extname(rawPath).trim().toLowerCase();
  if (ext && ext.length <= 8 && ext.length >= 2) return ext;
  return ".jpg";
}

function resolveWecomOutboundMediaTarget({ mediaUrl, mediaType }) {
  const normalizedType = String(mediaType ?? "").trim().toLowerCase();
  const lowerUrl = String(mediaUrl ?? "").trim().toLowerCase();
  const pathPart = lowerUrl.split("?")[0].split("#")[0];
  const ext = (pathPart.match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  const inferredName = (() => {
    const raw = String(mediaUrl ?? "").trim();
    if (!raw) return "attachment";
    const withoutQuery = raw.split("?")[0].split("#")[0];
    const name = basename(withoutQuery);
    return name || "attachment";
  })();

  if (normalizedType === "image") return { type: "image", filename: inferredName || "image.jpg" };
  if (normalizedType === "video") return { type: "video", filename: inferredName || "video.mp4" };
  if (normalizedType === "file") return { type: "file", filename: inferredName || "file.bin" };

  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
  const videoExts = new Set(["mp4", "mov", "m4v", "webm", "avi"]);

  if (imageExts.has(ext)) return { type: "image", filename: inferredName || `image.${ext}` };
  if (videoExts.has(ext)) return { type: "video", filename: inferredName || `video.${ext}` };
  return { type: "file", filename: inferredName || "file.bin" };
}

const WecomChannelPlugin = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "WeCom",
    selectionLabel: "WeCom (企业微信自建应用)",
    docsPath: "/channels/wecom",
    blurb: "Enterprise WeChat internal app via callback + send API.",
    aliases: ["wework", "qiwei", "wxwork"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: {
      inbound: true,
      outbound: true, // 阶段二完成：支持发送图片
    },
    markdown: true, // 阶段三完成：支持 Markdown 转换
  },
  config: {
    listAccountIds: (cfg) => listWecomAccountIds({ config: cfg }),
    resolveAccount: (cfg, accountId) =>
      (getWecomConfig({ config: cfg }, accountId ?? "default") ?? { accountId: accountId ?? "default" }),
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) return { ok: false, error: new Error("WeCom requires --to <UserId>") };
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId }) => {
      const config = getWecomConfig({ config: gatewayRuntime?.config }, accountId);
      if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
        return { ok: false, error: new Error("WeCom not configured (check channels.wecom in openclaw.json)") };
      }
      await sendWecomText({
        corpId: config.corpId,
        corpSecret: config.corpSecret,
        agentId: config.agentId,
        toUser: to,
        text,
        logger: gatewayRuntime?.logger,
        proxyUrl: config.outboundProxy,
      });
      return { ok: true, provider: "wecom" };
    },
  },
  // 入站消息处理
  inbound: {
    // 当消息需要回复时会调用这个方法
    deliverReply: async ({ to, text, accountId, mediaUrl, mediaType }) => {
      const config = getWecomConfig({ config: gatewayRuntime?.config }, accountId);
      if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
        throw new Error("WeCom not configured (check channels.wecom in openclaw.json)");
      }
      const { corpId, corpSecret, agentId, outboundProxy: proxyUrl } = config;
      // to 格式为 "wecom:userid"，需要提取 userid
      const userId = to.startsWith("wecom:") ? to.slice(6) : to;

      // 如果有媒体附件，先发送媒体
      if (mediaUrl) {
        try {
          const target = resolveWecomOutboundMediaTarget({ mediaUrl, mediaType });
          const { buffer } = await fetchMediaFromUrl(mediaUrl);
          const mediaId = await uploadWecomMedia({
            corpId, corpSecret,
            type: target.type,
            buffer,
            filename: target.filename,
            logger: gatewayRuntime?.logger,
            proxyUrl,
          });
          if (target.type === "image") {
            await sendWecomImage({
              corpId,
              corpSecret,
              agentId,
              toUser: userId,
              mediaId,
              logger: gatewayRuntime?.logger,
              proxyUrl,
            });
          } else if (target.type === "video") {
            await sendWecomVideo({
              corpId,
              corpSecret,
              agentId,
              toUser: userId,
              mediaId,
              logger: gatewayRuntime?.logger,
              proxyUrl,
            });
          } else {
            await sendWecomFile({
              corpId,
              corpSecret,
              agentId,
              toUser: userId,
              mediaId,
              logger: gatewayRuntime?.logger,
              proxyUrl,
            });
          }
        } catch (mediaErr) {
          // 媒体发送失败不阻止文本发送，只记录警告
          gatewayRuntime?.logger?.warn?.(`wecom: failed to send media: ${mediaErr.message}`);
        }
      }

      // 发送文本消息
      if (text) {
        await sendWecomText({
          corpId,
          corpSecret,
          agentId,
          toUser: userId,
          text,
          logger: gatewayRuntime?.logger,
          proxyUrl,
        });
      }

      return { ok: true };
    },
  },
};

// 存储 runtime 引用以便在消息处理中使用
let gatewayRuntime = null;

// 多账户配置存储
const wecomAccounts = new Map(); // key: accountId, value: config
let defaultAccountId = "default";

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function normalizeAccountConfig(raw, accountId) {
  const normalizedId = normalizeAccountId(accountId);
  if (!raw || typeof raw !== "object") return null;

  const corpId = String(raw.corpId ?? "").trim();
  const corpSecret = String(raw.corpSecret ?? "").trim();
  const agentId = asNumber(raw.agentId);
  const callbackToken = String(raw.callbackToken ?? "").trim();
  const callbackAesKey = String(raw.callbackAesKey ?? "").trim();
  const webhookPath = String(raw.webhookPath ?? "/wecom/callback").trim() || "/wecom/callback";
  const outboundProxy = String(raw.outboundProxy ?? raw.proxyUrl ?? raw.proxy ?? "").trim();
  const allowFrom = raw.allowFrom;
  const allowFromRejectMessage = String(
    raw.allowFromRejectMessage ?? raw.rejectUnauthorizedMessage ?? "",
  ).trim();

  if (!corpId || !corpSecret || !agentId) {
    return null;
  }

  return {
    accountId: normalizedId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    webhookPath,
    outboundProxy: outboundProxy || undefined,
    allowFrom,
    allowFromRejectMessage: allowFromRejectMessage || undefined,
    enabled: raw.enabled !== false,
  };
}

function readAccountConfigFromEnv({ envVars, accountId }) {
  const normalizedId = normalizeAccountId(accountId);
  const prefix = normalizedId === "default" ? "WECOM" : `WECOM_${normalizedId.toUpperCase()}`;

  const readVar = (suffix) =>
    envVars?.[`${prefix}_${suffix}`] ??
    (normalizedId === "default" ? envVars?.[`WECOM_${suffix}`] : undefined) ??
    requireEnv(`${prefix}_${suffix}`) ??
    (normalizedId === "default" ? requireEnv(`WECOM_${suffix}`) : undefined);

  const corpId = String(readVar("CORP_ID") ?? "").trim();
  const corpSecret = String(readVar("CORP_SECRET") ?? "").trim();
  const agentId = asNumber(readVar("AGENT_ID"));
  const callbackToken = String(readVar("CALLBACK_TOKEN") ?? "").trim();
  const callbackAesKey = String(readVar("CALLBACK_AES_KEY") ?? "").trim();
  const webhookPath = String(readVar("WEBHOOK_PATH") ?? "/wecom/callback").trim() || "/wecom/callback";
  const outboundProxyRaw =
    readVar("PROXY") ??
      (normalizedId === "default"
        ? requireEnv("HTTPS_PROXY")
        : envVars?.WECOM_PROXY ?? requireEnv("WECOM_PROXY") ?? requireEnv("HTTPS_PROXY"));
  const outboundProxy = String(outboundProxyRaw ?? "").trim();
  const allowFrom = readVar("ALLOW_FROM");
  const allowFromRejectMessage = String(readVar("ALLOW_FROM_REJECT_MESSAGE") ?? "").trim();
  const enabledRaw = String(readVar("ENABLED") ?? "").trim().toLowerCase();
  const enabled = !["0", "false", "off", "no"].includes(enabledRaw);

  if (!corpId || !corpSecret || !agentId) return null;

  return {
    accountId: normalizedId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    webhookPath,
    outboundProxy: outboundProxy || undefined,
    allowFrom,
    allowFromRejectMessage: allowFromRejectMessage || undefined,
    enabled,
  };
}

function rebuildWecomAccounts(api) {
  const cfg = api?.config ?? gatewayRuntime?.config ?? {};
  const channelConfig = cfg?.channels?.wecom;
  const envVars = cfg?.env?.vars ?? {};
  const resolved = new Map();

  const upsert = (accountId, rawConfig) => {
    const normalized = normalizeAccountConfig(rawConfig, accountId);
    if (!normalized) return;
    resolved.set(normalized.accountId, normalized);
  };

  // 1) channels.wecom 顶层默认账户
  if (channelConfig && typeof channelConfig === "object") {
    upsert("default", channelConfig);
  }

  // 2) channels.wecom.accounts 多账户
  const channelAccounts = channelConfig?.accounts;
  if (channelAccounts && typeof channelAccounts === "object") {
    for (const [accountId, accountConfig] of Object.entries(channelAccounts)) {
      upsert(accountId, accountConfig);
    }
  }

  // 3) env.vars / process.env 回退（兼容旧配置）
  const envAccountIds = new Set(["default"]);
  for (const key of Object.keys(envVars)) {
    const m = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
    if (m && m[1] !== "CORP") envAccountIds.add(m[1].toLowerCase());
  }
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
    if (m && m[1] !== "CORP") envAccountIds.add(m[1].toLowerCase());
  }
  for (const accountId of envAccountIds) {
    if (resolved.has(normalizeAccountId(accountId))) continue;
    const envConfig = readAccountConfigFromEnv({ envVars, accountId });
    if (envConfig) resolved.set(envConfig.accountId, envConfig);
  }

  for (const [accountId, config] of resolved.entries()) {
    config.outboundProxy = resolveWecomProxyConfig({
      channelConfig,
      accountConfig: config,
      envVars,
      processEnv: process.env,
      accountId,
    });
  }

  wecomAccounts.clear();
  for (const [accountId, config] of resolved) {
    wecomAccounts.set(accountId, config);
  }

  defaultAccountId = wecomAccounts.has("default")
    ? "default"
    : (Array.from(wecomAccounts.keys())[0] ?? "default");

  return wecomAccounts;
}

// 获取 wecom 配置（支持多账户）
function getWecomConfig(api, accountId = null) {
  const accountMap = rebuildWecomAccounts(api);
  const targetAccountId = normalizeAccountId(accountId ?? defaultAccountId);

  if (accountMap.has(targetAccountId)) {
    return accountMap.get(targetAccountId);
  }

  if (targetAccountId !== "default" && accountMap.has("default")) {
    return accountMap.get("default");
  }

  return accountMap.values().next().value ?? null;
}

// 列出所有已配置的账户ID
function listWecomAccountIds(api) {
  return Array.from(rebuildWecomAccounts(api).keys());
}

function listEnabledWecomAccounts(api) {
  return Array.from(rebuildWecomAccounts(api).values()).filter((cfg) => cfg?.enabled !== false);
}

function groupAccountsByWebhookPath(api) {
  const grouped = new Map();
  for (const account of listEnabledWecomAccounts(api)) {
    const normalizedPath =
      normalizePluginHttpPath(account.webhookPath ?? "/wecom/callback", "/wecom/callback") ?? "/wecom/callback";
    const existing = grouped.get(normalizedPath);
    if (existing) existing.push(account);
    else grouped.set(normalizedPath, [account]);
  }
  return grouped;
}

function resolveWecomPolicyInputs(api) {
  const cfg = api?.config ?? gatewayRuntime?.config ?? {};
  return {
    channelConfig: cfg?.channels?.wecom ?? {},
    envVars: cfg?.env?.vars ?? {},
    processEnv: process.env,
  };
}

function resolveWecomBotConfig(api) {
  return resolveWecomBotModeConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomBotProxyConfig(api) {
  const inputs = resolveWecomPolicyInputs(api);
  return resolveWecomProxyConfig({
    ...inputs,
    accountId: "bot",
    accountConfig: {},
  });
}

function resolveWecomCommandPolicy(api) {
  return resolveWecomCommandPolicyConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomAllowFromPolicy(api, accountId, accountConfig = {}) {
  const inputs = resolveWecomPolicyInputs(api);
  return resolveWecomAllowFromPolicyConfig({
    ...inputs,
    accountId: normalizeAccountId(accountId ?? "default"),
    accountConfig: accountConfig ?? {},
  });
}

function resolveWecomGroupChatPolicy(api) {
  return resolveWecomGroupChatConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomTextDebouncePolicy(api) {
  return resolveWecomDebounceConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomReplyStreamingPolicy(api) {
  return resolveWecomStreamingConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomDeliveryFallbackPolicy(api) {
  return resolveWecomDeliveryFallbackConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomWebhookBotDeliveryPolicy(api) {
  return resolveWecomWebhookBotDeliveryConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomStreamManagerPolicy(api) {
  return resolveWecomStreamManagerConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomObservabilityPolicy(api) {
  return resolveWecomObservabilityConfig(resolveWecomPolicyInputs(api));
}

function resolveWecomDynamicAgentPolicy(api) {
  return resolveWecomDynamicAgentConfig(resolveWecomPolicyInputs(api));
}

function createDeliveryTraceId(prefix = "wecom") {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stamp}-${rand}`;
}

function syncWecomSessionQueuePolicy(api) {
  const policy = resolveWecomStreamManagerPolicy(api);
  WECOM_SESSION_TASK_QUEUE.setMaxConcurrentPerSession(policy.maxConcurrentPerSession);
  BOT_SESSION_TASK_QUEUE.setMaxConcurrentPerSession(policy.maxConcurrentPerSession);
  BOT_STREAM_MANAGER.setExpireMs(policy.timeoutMs);
  return policy;
}

function executeInboundTaskWithSessionQueue({ api, sessionId, isBot = false, task }) {
  const policy = syncWecomSessionQueuePolicy(api);
  if (!policy.enabled) {
    return task();
  }
  const queue = isBot ? BOT_SESSION_TASK_QUEUE : WECOM_SESSION_TASK_QUEUE;
  return queue.enqueue(sessionId, task);
}

async function sendWecomBotPayloadViaResponseUrl({
  responseUrl,
  payload,
  logger,
  proxyUrl,
  timeoutMs = 8000,
}) {
  const normalizedUrl = String(responseUrl ?? "").trim();
  if (!normalizedUrl) {
    throw new Error("missing response_url");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("missing response payload");
  }
  const requestOptions = attachWecomProxyDispatcher(
    normalizedUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
    },
    { proxyUrl, logger },
  );
  const response = await fetch(normalizedUrl, requestOptions);
  const responseBody = await response.text().catch(() => "");
  const result = parseWecomResponseUrlResult(response, responseBody);
  if (!result.accepted) {
    throw new Error(
      `response_url rejected: status=${response.status} errcode=${result.errcode ?? "unknown"} errmsg=${result.errmsg || "n/a"}`,
    );
  }
  return {
    status: response.status,
    errcode: result.errcode,
  };
}

async function sendWecomBotTextViaResponseUrl({
  responseUrl,
  text,
  logger,
  proxyUrl,
  timeoutMs = 8000,
}) {
  return sendWecomBotPayloadViaResponseUrl({
    responseUrl,
    payload: {
      msgtype: "text",
      text: {
        content: String(text ?? ""),
      },
    },
    logger,
    proxyUrl,
    timeoutMs,
  });
}

async function deliverBotReplyText({
  api,
  fromUser,
  sessionId,
  streamId,
  responseUrl,
  text,
  mediaUrl,
  mediaUrls,
  reason = "reply",
} = {}) {
  const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
  const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
  const observabilityPolicy = resolveWecomObservabilityPolicy(api);
  const botProxyUrl = resolveWecomBotProxyConfig(api);
  const normalizedText = String(text ?? "").trim();
  const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({ mediaUrl, mediaUrls });
  const mixedPayload = buildWecomBotMixedPayload({
    text: normalizedText,
    mediaUrls: normalizedMediaUrls,
  });
  const mediaFallbackSuffix =
    normalizedMediaUrls.length > 0 ? `\n\n媒体链接：\n${normalizedMediaUrls.join("\n")}` : "";
  const fallbackText = normalizedText || "已收到模型返回的媒体结果，请查看以下链接。";

  const normalizedSessionId = String(sessionId ?? "").trim() || buildWecomBotSessionId(fromUser);
  const inlineResponseUrl = String(responseUrl ?? "").trim();
  if (inlineResponseUrl) {
    upsertBotResponseUrlCache({
      sessionId: normalizedSessionId,
      responseUrl: inlineResponseUrl,
    });
  }
  const cachedResponseUrl = getBotResponseUrlCache(normalizedSessionId);
  const traceId = createDeliveryTraceId("wecom-bot");
  const router = createWecomDeliveryRouter({
    logger: api.logger,
    fallbackConfig: fallbackPolicy,
    observability: observabilityPolicy,
    handlers: {
      active_stream: async ({ text: content }) => {
        if (normalizedMediaUrls.length > 0) {
          return { ok: false, reason: "stream-media-unsupported" };
        }
        if (!streamId || !hasBotStream(streamId)) {
          return { ok: false, reason: "stream-missing" };
        }
        finishBotStream(streamId, content);
        return {
          ok: true,
          meta: {
            streamId,
          },
        };
      },
      response_url: async ({ text: content }) => {
        const targetUrl = inlineResponseUrl || cachedResponseUrl?.url || "";
        if (!targetUrl) {
          return { ok: false, reason: "response-url-missing" };
        }
        if (cachedResponseUrl?.used) {
          return { ok: false, reason: "response-url-used" };
        }
        const payload = mixedPayload || {
          msgtype: "text",
          text: {
            content: content || fallbackText,
          },
        };
        const result = await sendWecomBotPayloadViaResponseUrl({
          responseUrl: targetUrl,
          payload,
          logger: api.logger,
          proxyUrl: botProxyUrl,
          timeoutMs: webhookBotPolicy.timeoutMs,
        });
        markBotResponseUrlUsed(normalizedSessionId);
        return {
          ok: true,
          meta: {
            status: result.status,
            errcode: result.errcode ?? 0,
          },
        };
      },
      webhook_bot: async ({ text: content }) => {
        if (!webhookBotPolicy.enabled) {
          return { ok: false, reason: "webhook-bot-disabled" };
        }
        const sendUrl = resolveWebhookBotSendUrl({
          url: webhookBotPolicy.url,
          key: webhookBotPolicy.key,
        });
        if (!sendUrl) {
          return { ok: false, reason: "webhook-bot-url-missing" };
        }
        await webhookSendText({
          url: webhookBotPolicy.url,
          key: webhookBotPolicy.key,
          content: `${content || fallbackText}${mediaFallbackSuffix}`.trim(),
          timeoutMs: webhookBotPolicy.timeoutMs,
        });
        return { ok: true };
      },
      agent_push: async ({ text: content }) => {
        const account = getWecomConfig(api, "default") ?? getWecomConfig(api);
        if (!account?.corpId || !account?.corpSecret || !account?.agentId) {
          return { ok: false, reason: "agent-config-missing" };
        }
        await sendWecomText({
          corpId: account.corpId,
          corpSecret: account.corpSecret,
          agentId: account.agentId,
          toUser: fromUser,
          text: `${content || fallbackText}${mediaFallbackSuffix}`.trim(),
          logger: api.logger,
          proxyUrl: account.outboundProxy,
        });
        return {
          ok: true,
          meta: {
            accountId: account.accountId || "default",
          },
        };
      },
    },
  });

  return router.deliverText({
    text: normalizedText || fallbackText,
    traceId,
    meta: {
      reason,
      fromUser,
      sessionId: normalizedSessionId,
      streamId: streamId || "",
      hasResponseUrl: Boolean(inlineResponseUrl || cachedResponseUrl?.url),
      mediaCount: normalizedMediaUrls.length,
    },
  });
}

function buildTextDebounceBufferKey({ accountId, fromUser, chatId, isGroupChat }) {
  const account = String(accountId ?? "default").trim().toLowerCase() || "default";
  const user = String(fromUser ?? "").trim().toLowerCase();
  const group = String(chatId ?? "").trim().toLowerCase();
  if (isGroupChat) {
    return `${account}:group:${group || "unknown"}:user:${user || "unknown"}`;
  }
  return `${account}:dm:${user || "unknown"}`;
}

function dispatchTextPayload(api, payload, reason = "direct") {
  const sessionId = buildWecomSessionId(payload?.fromUser);
  messageProcessLimiter
    .execute(() =>
      executeInboundTaskWithSessionQueue({
        api,
        sessionId,
        isBot: false,
        task: () => processInboundMessage(payload),
      }),
    )
    .catch((err) => {
      api.logger.error?.(`wecom: async text processing failed (${reason}): ${err.message}`);
    });
}

function flushTextDebounceBuffer(api, debounceKey, reason = "timer") {
  const buffered = TEXT_MESSAGE_DEBOUNCE_BUFFERS.get(debounceKey);
  if (!buffered) return;

  TEXT_MESSAGE_DEBOUNCE_BUFFERS.delete(debounceKey);
  if (buffered.timer) clearTimeout(buffered.timer);
  const mergedContent = buffered.messages.join("\n").trim();
  if (!mergedContent) return;

  api.logger.info?.(
    `wecom: flushing debounced text buffer key=${debounceKey} count=${buffered.messages.length} reason=${reason}`,
  );
  dispatchTextPayload(
    api,
    {
      ...buffered.basePayload,
      msgType: "text",
      content: mergedContent,
      msgId: buffered.msgIds[0] ?? buffered.basePayload.msgId ?? "",
    },
    `debounce:${reason}`,
  );
}

function scheduleTextInboundProcessing(api, basePayload, content) {
  const text = String(content ?? "");
  let commandProbeText = text;
  if (basePayload?.isGroupChat) {
    const groupPolicy = resolveWecomGroupChatPolicy(api);
    if (shouldStripWecomGroupMentions(groupPolicy)) {
      commandProbeText = stripWecomGroupMentions(commandProbeText, groupPolicy.mentionPatterns);
    }
  }
  const command = extractLeadingSlashCommand(commandProbeText);
  const debounceConfig = resolveWecomTextDebouncePolicy(api);
  const debounceKey = buildTextDebounceBufferKey(basePayload);

  if (command) {
    flushTextDebounceBuffer(api, debounceKey, "command-priority");
    dispatchTextPayload(api, { ...basePayload, content: text, msgType: "text" }, "command");
    return;
  }

  if (!debounceConfig.enabled) {
    dispatchTextPayload(api, { ...basePayload, content: text, msgType: "text" }, "direct");
    return;
  }

  const existing = TEXT_MESSAGE_DEBOUNCE_BUFFERS.get(debounceKey);
  if (!existing) {
    const timer = setTimeout(() => {
      flushTextDebounceBuffer(api, debounceKey, "window-expired");
    }, debounceConfig.windowMs);
    timer.unref?.();

    TEXT_MESSAGE_DEBOUNCE_BUFFERS.set(debounceKey, {
      basePayload,
      messages: [text],
      msgIds: [basePayload.msgId ?? ""],
      timer,
      updatedAt: Date.now(),
    });
    api.logger.info?.(
      `wecom: buffered text message key=${debounceKey} count=1 windowMs=${debounceConfig.windowMs}`,
    );
    return;
  }

  if (existing.timer) clearTimeout(existing.timer);
  existing.messages.push(text);
  existing.msgIds.push(basePayload.msgId ?? "");
  existing.updatedAt = Date.now();

  if (existing.messages.length >= debounceConfig.maxBatch) {
    flushTextDebounceBuffer(api, debounceKey, "max-batch");
    return;
  }

  existing.timer = setTimeout(() => {
    flushTextDebounceBuffer(api, debounceKey, "window-expired");
  }, debounceConfig.windowMs);
  existing.timer.unref?.();
  TEXT_MESSAGE_DEBOUNCE_BUFFERS.set(debounceKey, existing);
}

function registerWecomBotWebhookRoute(api) {
  const botConfig = resolveWecomBotConfig(api);
  if (!botConfig.enabled) return false;
  if (!botConfig.token || !botConfig.encodingAesKey) {
    api.logger.warn?.(
      "wecom(bot): enabled but missing token/encodingAesKey; route not registered",
    );
    return false;
  }

  const normalizedPath =
    normalizePluginHttpPath(botConfig.webhookPath ?? "/wecom/bot/callback", "/wecom/bot/callback") ??
    "/wecom/bot/callback";
  ensureBotStreamCleanupTimer(botConfig.streamExpireMs, api.logger);
  cleanupExpiredBotStreams(botConfig.streamExpireMs);

  api.registerHttpRoute({
    path: normalizedPath,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const msg_signature = url.searchParams.get("msg_signature") ?? "";
        const timestamp = url.searchParams.get("timestamp") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        const echostr = url.searchParams.get("echostr") ?? "";

        if (req.method === "GET" && !echostr) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("wecom bot webhook ok");
          return;
        }

        if (req.method === "GET") {
          if (!msg_signature || !timestamp || !nonce || !echostr) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Missing query params");
            return;
          }
          const expected = computeMsgSignature({
            token: botConfig.token,
            timestamp,
            nonce,
            encrypt: echostr,
          });
          if (expected !== msg_signature) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Invalid signature");
            return;
          }
          const { msg: plainEchostr } = decryptWecom({
            aesKey: botConfig.encodingAesKey,
            cipherTextBase64: echostr,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(plainEchostr);
          api.logger.info?.(`wecom(bot): verified callback URL at ${normalizedPath}`);
          return;
        }

        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, POST");
          res.end();
          return;
        }

        let encryptedBody = "";
        try {
          const rawBody = await readRequestBody(req);
          const parsedBody = parseIncomingJson(rawBody);
          encryptedBody = String(parsedBody?.encrypt ?? "").trim();
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid request body");
          api.logger.warn?.(`wecom(bot): failed to parse callback body: ${String(err?.message || err)}`);
          return;
        }

        if (!msg_signature || !timestamp || !nonce || !encryptedBody) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing required params");
          return;
        }

        const expected = computeMsgSignature({
          token: botConfig.token,
          timestamp,
          nonce,
          encrypt: encryptedBody,
        });
        if (expected !== msg_signature) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid signature");
          return;
        }

        let incomingPayload = null;
        try {
          const { msg: decryptedPayload } = decryptWecom({
            aesKey: botConfig.encodingAesKey,
            cipherTextBase64: encryptedBody,
          });
          incomingPayload = parseIncomingJson(decryptedPayload);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Decrypt failed");
          api.logger.warn?.(`wecom(bot): failed to decrypt payload: ${String(err?.message || err)}`);
          return;
        }

        const parsed = parseWecomBotInboundMessage(incomingPayload);
        api.logger.info?.(`wecom(bot): inbound ${describeWecomBotParsedMessage(parsed)}`);
        if (!parsed) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("success");
          return;
        }

        if (parsed.kind === "stream-refresh") {
          cleanupExpiredBotStreams(botConfig.streamExpireMs);
          const streamId = parsed.streamId || `stream-${Date.now()}`;
          const stream = getBotStream(streamId);
          const plainPayload = {
            msgtype: "stream",
            stream: {
              id: streamId,
              content: stream?.content ?? "会话已过期",
              finish: stream ? stream.finished === true : true,
            },
          };
          const encryptedResponse = buildWecomBotEncryptedResponse({
            token: botConfig.token,
            aesKey: botConfig.encodingAesKey,
            timestamp,
            nonce,
            plainPayload,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(encryptedResponse);
          return;
        }

        if (parsed.kind === "event") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("success");
          return;
        }

        if (parsed.kind === "unsupported" || parsed.kind === "invalid") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("success");
          return;
        }

        if (parsed.kind === "message") {
          const dedupeStub = {
            MsgId: parsed.msgId,
            FromUserName: parsed.fromUser,
            MsgType: parsed.msgType,
            Content: parsed.content,
            CreateTime: String(Math.floor(Date.now() / 1000)),
          };
          if (!markInboundMessageSeen(dedupeStub, "bot")) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("success");
            return;
          }

          const streamId = `stream_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`}`;
          createBotStream(streamId, botConfig.placeholderText);
          const botSessionId = buildWecomBotSessionId(parsed.fromUser);
          if (parsed.responseUrl) {
            upsertBotResponseUrlCache({
              sessionId: botSessionId,
              responseUrl: parsed.responseUrl,
            });
          }
          const encryptedResponse = buildWecomBotEncryptedResponse({
            token: botConfig.token,
            aesKey: botConfig.encodingAesKey,
            timestamp,
            nonce,
            plainPayload: {
              msgtype: "stream",
              stream: {
                id: streamId,
                content: botConfig.placeholderText,
                finish: false,
              },
            },
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(encryptedResponse);

          messageProcessLimiter
            .execute(() =>
              executeInboundTaskWithSessionQueue({
                api,
                sessionId: botSessionId,
                isBot: true,
                task: () =>
                  processBotInboundMessage({
                    api,
                    streamId,
                    fromUser: parsed.fromUser,
                    content: parsed.content,
                    msgType: parsed.msgType,
                    msgId: parsed.msgId,
                    chatId: parsed.chatId,
                    isGroupChat: parsed.isGroupChat,
                    imageUrls: parsed.imageUrls,
                    responseUrl: parsed.responseUrl,
                  }),
              }),
            )
            .catch((err) => {
              api.logger.error?.(`wecom(bot): async message processing failed: ${String(err?.message || err)}`);
              deliverBotReplyText({
                api,
                fromUser: parsed.fromUser,
                sessionId: botSessionId,
                streamId,
                responseUrl: parsed.responseUrl,
                text: `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
                reason: "bot-async-processing-error",
              }).catch((deliveryErr) => {
                api.logger.warn?.(`wecom(bot): failed to deliver async error reply: ${String(deliveryErr?.message || deliveryErr)}`);
                finishBotStream(
                  streamId,
                  `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
                );
              });
            });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("success");
      } catch (err) {
        api.logger.error?.(`wecom(bot): webhook handler failed: ${String(err?.message || err)}`);
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal error");
        }
      }
    },
  });

  api.logger.info?.(`wecom(bot): registered webhook at ${normalizedPath}`);
  return true;
}

export default function register(api) {
  // 保存 runtime 引用
  gatewayRuntime = api.runtime;
  const streamManagerPolicy = syncWecomSessionQueuePolicy(api);
  const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
  const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
  const observabilityPolicy = resolveWecomObservabilityPolicy(api);
  const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);

  // 初始化配置
  const botModeConfig = resolveWecomBotConfig(api);
  const cfg = getWecomConfig(api);
  if (cfg) {
    api.logger.info?.(
      `wecom: config loaded (corpId=${cfg.corpId?.slice(0, 8)}..., proxy=${cfg.outboundProxy ? "on" : "off"})`,
    );
  } else if (botModeConfig.enabled) {
    api.logger.info?.(
      `wecom(bot): config loaded (webhook=${botModeConfig.webhookPath}, streamExpireMs=${botModeConfig.streamExpireMs})`,
    );
  } else {
    api.logger.warn?.("wecom: no configuration found (check channels.wecom in openclaw.json)");
  }
  api.logger.info?.(
    `wecom: stream.manager ${streamManagerPolicy.enabled ? "on" : "off"} (timeoutMs=${streamManagerPolicy.timeoutMs}, perSession=${streamManagerPolicy.maxConcurrentPerSession})`,
  );
  api.logger.info?.(
    `wecom: delivery.fallback ${fallbackPolicy.enabled ? "on" : "off"} (order=${fallbackPolicy.order.join(">")})`,
  );
  if (webhookBotPolicy.enabled) {
    api.logger.info?.(
      `wecom: webhookBot fallback enabled (${webhookBotPolicy.url || webhookBotPolicy.key ? "configured" : "missing-url"})`,
    );
  }
  if (observabilityPolicy.enabled) {
    api.logger.info?.(`wecom: observability enabled (payloadMeta=${observabilityPolicy.logPayloadMeta ? "on" : "off"})`);
  }
  if (dynamicAgentPolicy.enabled) {
    api.logger.info?.(
      `wecom: dynamic-agent on (mode=${dynamicAgentPolicy.mode}, userMap=${Object.keys(dynamicAgentPolicy.userMap || {}).length}, groupMap=${Object.keys(dynamicAgentPolicy.groupMap || {}).length}, mentionMap=${Object.keys(dynamicAgentPolicy.mentionMap || {}).length})`,
    );
  }

  api.registerChannel({ plugin: WecomChannelPlugin });
  const botRouteRegistered = registerWecomBotWebhookRoute(api);

  const webhookGroups = groupAccountsByWebhookPath(api);
  if (webhookGroups.size === 0 && !botRouteRegistered) {
    api.logger.warn?.("wecom: no enabled account with valid config found; webhook route not registered");
    return;
  }

  for (const [normalizedPath, accounts] of webhookGroups.entries()) {
    api.registerHttpRoute({
      path: normalizedPath,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const msg_signature = url.searchParams.get("msg_signature") ?? "";
          const timestamp = url.searchParams.get("timestamp") ?? "";
          const nonce = url.searchParams.get("nonce") ?? "";
          const echostr = url.searchParams.get("echostr") ?? "";
          const signedAccounts = accounts.filter((a) => a.callbackToken && a.callbackAesKey);

          // Health check
          if (req.method === "GET" && !echostr) {
            res.statusCode = signedAccounts.length > 0 ? 200 : 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(signedAccounts.length > 0 ? "wecom webhook ok" : "wecom webhook not configured");
            return;
          }

          if (signedAccounts.length === 0) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("WeCom plugin not configured (missing callbackToken/callbackAesKey)");
            return;
          }

          if (req.method === "GET") {
            const matchedAccount = pickAccountBySignature({
              accounts: signedAccounts,
              msgSignature: msg_signature,
              timestamp,
              nonce,
              encrypt: echostr,
            });
            if (!matchedAccount) {
              res.statusCode = 401;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("Invalid signature");
              return;
            }

            const { msg: plainEchostr } = decryptWecom({
              aesKey: matchedAccount.callbackAesKey,
              cipherTextBase64: echostr,
            });
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(plainEchostr);
            api.logger.info?.(`wecom: verified callback URL for account=${matchedAccount.accountId}`);
            return;
          }

          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET, POST");
            res.end();
            return;
          }

          let encrypt = "";
          try {
            const rawXml = await readRequestBody(req);
            const incoming = parseIncomingXml(rawXml);
            encrypt = String(incoming?.Encrypt ?? "");
          } catch (err) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Invalid request body");
            api.logger.warn?.(`wecom: failed to parse callback body: ${String(err?.message || err)}`);
            return;
          }

          if (!encrypt) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Missing Encrypt");
            return;
          }

          const matchedAccount = pickAccountBySignature({
            accounts: signedAccounts,
            msgSignature: msg_signature,
            timestamp,
            nonce,
            encrypt,
          });
          if (!matchedAccount) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Invalid signature");
            return;
          }

          // ACK quickly (WeCom expects fast response within 5 seconds)
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("success");

          let msgObj;
          try {
            const { msg: decryptedXml } = decryptWecom({
              aesKey: matchedAccount.callbackAesKey,
              cipherTextBase64: encrypt,
            });
            msgObj = parseIncomingXml(decryptedXml);
          } catch (err) {
            api.logger.error?.(`wecom: failed to decrypt payload for account=${matchedAccount.accountId}: ${String(err?.message || err)}`);
            return;
          }

          if (!markInboundMessageSeen(msgObj, matchedAccount.accountId)) {
            api.logger.info?.(`wecom: duplicate inbound skipped msgId=${msgObj?.MsgId ?? "n/a"}`);
            return;
          }

          const inbound = extractWecomXmlInboundEnvelope(msgObj);
          if (!inbound?.msgType) {
            api.logger.warn?.("wecom: inbound message missing MsgType, dropped");
            return;
          }

          const chatId = inbound.chatId || null;
          const isGroupChat = Boolean(chatId);
          const fromUser = inbound.fromUser;
          const msgType = inbound.msgType;
          const msgId = inbound.msgId;

          api.logger.info?.(
            `wecom inbound: account=${matchedAccount.accountId} from=${fromUser} msgType=${msgType} chatId=${chatId || "N/A"} content=${(inbound?.content ?? "").slice?.(0, 80)}`,
          );

          if (!fromUser) {
            api.logger.warn?.("wecom: inbound message missing FromUserName, dropped");
            return;
          }

          const basePayload = {
            api,
            accountId: matchedAccount.accountId,
            fromUser,
            chatId,
            isGroupChat,
            msgId,
          };
          const inboundSessionId = buildWecomSessionId(fromUser);

          // 异步处理消息，不阻塞响应
          if (msgType === "text" && inbound.content) {
            scheduleTextInboundProcessing(api, basePayload, inbound.content);
          } else if (msgType === "image" && inbound.mediaId) {
            messageProcessLimiter
              .execute(() =>
                executeInboundTaskWithSessionQueue({
                  api,
                  sessionId: inboundSessionId,
                  isBot: false,
                  task: () =>
                    processInboundMessage({
                      ...basePayload,
                      mediaId: inbound.mediaId,
                      msgType: "image",
                      picUrl: inbound.picUrl,
                    }),
                }),
              )
              .catch((err) => {
                api.logger.error?.(`wecom: async image processing failed: ${err.message}`);
              });
          } else if (msgType === "voice" && inbound.mediaId) {
            messageProcessLimiter
              .execute(() =>
                executeInboundTaskWithSessionQueue({
                  api,
                  sessionId: inboundSessionId,
                  isBot: false,
                  task: () =>
                    processInboundMessage({
                      ...basePayload,
                      mediaId: inbound.mediaId,
                      msgType: "voice",
                      recognition: inbound.recognition,
                    }),
                }),
              )
              .catch((err) => {
                api.logger.error?.(`wecom: async voice processing failed: ${err.message}`);
              });
          } else if (msgType === "video" && inbound.mediaId) {
            messageProcessLimiter
              .execute(() =>
                executeInboundTaskWithSessionQueue({
                  api,
                  sessionId: inboundSessionId,
                  isBot: false,
                  task: () =>
                    processInboundMessage({
                      ...basePayload,
                      mediaId: inbound.mediaId,
                      msgType: "video",
                      thumbMediaId: inbound.thumbMediaId,
                    }),
                }),
              )
              .catch((err) => {
                api.logger.error?.(`wecom: async video processing failed: ${err.message}`);
              });
          } else if (msgType === "file" && inbound.mediaId) {
            messageProcessLimiter
              .execute(() =>
                executeInboundTaskWithSessionQueue({
                  api,
                  sessionId: inboundSessionId,
                  isBot: false,
                  task: () =>
                    processInboundMessage({
                      ...basePayload,
                      mediaId: inbound.mediaId,
                      msgType: "file",
                      fileName: inbound.fileName,
                      fileSize: inbound.fileSize,
                    }),
                }),
              )
              .catch((err) => {
                api.logger.error?.(`wecom: async file processing failed: ${err.message}`);
              });
          } else if (msgType === "link") {
            messageProcessLimiter
              .execute(() =>
                executeInboundTaskWithSessionQueue({
                  api,
                  sessionId: inboundSessionId,
                  isBot: false,
                  task: () =>
                    processInboundMessage({
                      ...basePayload,
                      msgType: "link",
                      linkTitle: inbound.linkTitle,
                      linkDescription: inbound.linkDescription,
                      linkUrl: inbound.linkUrl,
                      linkPicUrl: inbound.linkPicUrl,
                    }),
                }),
              )
              .catch((err) => {
                api.logger.error?.(`wecom: async link processing failed: ${err.message}`);
              });
          } else {
            api.logger.info?.(`wecom: ignoring unsupported message type=${msgType}`);
          }
        } catch (err) {
          api.logger.error?.(`wecom: webhook handler failed: ${String(err?.message || err)}`);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Internal error");
          }
        }
      },
    });

    const accountIds = accounts.map((a) => a.accountId).join(", ");
    api.logger.info?.(`wecom: registered webhook at ${normalizedPath} (accounts=${accountIds})`);
  }
}

// 下载企业微信媒体文件
async function downloadWecomMedia({ corpId, corpSecret, mediaId, proxyUrl, logger }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
  const mediaUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetchWithRetry(mediaUrl, {}, 3, 1000, { proxyUrl, logger });
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // 如果返回 JSON，说明有错误
  if (contentType.includes("application/json")) {
    const json = await res.json();
    throw new Error(`WeCom media download failed: ${JSON.stringify(json)}`);
  }

  const buffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(buffer),
    contentType,
  };
}

// 命令处理函数
async function handleHelpCommand({ api, fromUser, corpId, corpSecret, agentId, proxyUrl }) {
  const helpText = `🤖 AI 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 重置会话（等价于 /reset）
/status - 查看系统状态

直接发送消息即可与 AI 对话。
支持发送图片，AI 会分析图片内容。`;

  await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: helpText, proxyUrl, logger: api.logger });
  return true;
}

async function handleStatusCommand({ api, fromUser, corpId, corpSecret, agentId, accountId, proxyUrl }) {
  const config = getWecomConfig(api, accountId);
  const accountIds = listWecomAccountIds(api);
  const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
  const commandPolicy = resolveWecomCommandPolicy(api);
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, config?.accountId, config);
  const groupPolicy = resolveWecomGroupChatPolicy(api);
  const debouncePolicy = resolveWecomTextDebouncePolicy(api);
  const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
  const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
  const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
  const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
  const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
  const proxyEnabled = Boolean(config?.outboundProxy);
  const voiceStatusLine = voiceConfig.enabled
    ? `✅ 语音消息转写（本地 ${voiceConfig.provider}，模型: ${voiceConfig.modelPath || voiceConfig.model}）`
    : "⚠️ 语音消息转写回退未启用（仅使用企业微信 Recognition）";
  const commandPolicyLine = commandPolicy.enabled
    ? `✅ 指令白名单已启用（${commandPolicy.allowlist.length} 条，管理员 ${commandPolicy.adminUsers.length} 人）`
    : "ℹ️ 指令白名单未启用";
  const allowFromPolicyLine =
    allowFromPolicy.allowFrom.length === 0 || allowFromPolicy.allowFrom.includes("*")
      ? "ℹ️ 发送者授权：未限制（allowFrom 未配置）"
      : `✅ 发送者授权：已限制 ${allowFromPolicy.allowFrom.length} 个用户`;
  const groupPolicyLine = groupPolicy.enabled
    ? groupPolicy.triggerMode === "mention"
      ? "✅ 群聊触发：仅 @ 命中后处理"
      : groupPolicy.triggerMode === "keyword"
        ? `✅ 群聊触发：关键词模式（${(groupPolicy.triggerKeywords || []).join(" / ") || "未配置关键词"}）`
        : "✅ 群聊触发：无需 @（全部处理）"
    : "⚠️ 群聊处理未启用";
  const debouncePolicyLine = debouncePolicy.enabled
    ? `✅ 文本防抖合并已启用（${debouncePolicy.windowMs}ms / 最多 ${debouncePolicy.maxBatch} 条）`
    : "ℹ️ 文本防抖合并未启用";
  const streamingPolicyLine = streamingPolicy.enabled
    ? `✅ Agent 增量回包已启用（最小片段 ${streamingPolicy.minChars} 字符 / 最短间隔 ${streamingPolicy.minIntervalMs}ms）`
    : "ℹ️ Agent 增量回包未启用";
  const fallbackPolicyLine = deliveryFallbackPolicy.enabled
    ? `✅ 回包兜底链路已启用（${deliveryFallbackPolicy.order.join(" > ")}）`
    : "ℹ️ 回包兜底链路未启用（仅 active_stream）";
  const streamManagerPolicyLine = streamManagerPolicy.enabled
    ? `✅ 会话串行队列已启用（每会话并发 ${streamManagerPolicy.maxConcurrentPerSession}）`
    : "ℹ️ 会话串行队列未启用";
  const webhookBotPolicyLine = webhookBotPolicy.enabled
    ? "✅ Webhook Bot 回包已启用"
    : "ℹ️ Webhook Bot 回包未启用";
  const dynamicAgentPolicyLine = dynamicAgentPolicy.enabled
    ? `✅ 动态 Agent 路由已启用（mode=${dynamicAgentPolicy.mode}，用户映射 ${Object.keys(dynamicAgentPolicy.userMap || {}).length}，群映射 ${Object.keys(dynamicAgentPolicy.groupMap || {}).length}）`
    : "ℹ️ 动态 Agent 路由未启用";

  const statusText = `📊 系统状态

渠道：企业微信 (WeCom)
会话ID：wecom:${fromUser}
账户ID：${config?.accountId || "default"}
已配置账户：${accountIds.join(", ")}
插件版本：${PLUGIN_VERSION}

功能状态：
✅ 文本消息
✅ 图片发送/接收
✅ 消息分段 (2048字符)
✅ 命令系统
✅ Markdown 转换
✅ API 限流
✅ 多账户支持
${commandPolicyLine}
${allowFromPolicyLine}
${groupPolicyLine}
${debouncePolicyLine}
${streamingPolicyLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${dynamicAgentPolicyLine}
${proxyEnabled ? "✅ WeCom 出站代理已启用" : "ℹ️ WeCom 出站代理未启用"}
${voiceStatusLine}`;

  await sendWecomText({
    corpId,
    corpSecret,
    agentId,
    toUser: fromUser,
    text: statusText,
    logger: api.logger,
    proxyUrl,
  });
  return true;
}

const COMMANDS = {
  "/help": handleHelpCommand,
  "/status": handleStatusCommand,
};

function buildWecomBotHelpText() {
  return `🤖 AI 助手使用帮助（Bot 流式模式）

可用命令：
/help - 显示帮助信息
/status - 查看系统状态
/clear - 重置会话（等价于 /reset）

直接发送消息即可与 AI 对话。`;
}

function buildWecomBotStatusText(api, fromUser) {
  const commandPolicy = resolveWecomCommandPolicy(api);
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, "default", {});
  const groupPolicy = resolveWecomGroupChatPolicy(api);
  const botConfig = resolveWecomBotConfig(api);
  const deliveryFallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
  const streamManagerPolicy = resolveWecomStreamManagerPolicy(api);
  const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
  const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
  const commandPolicyLine = commandPolicy.enabled
    ? `✅ 指令白名单已启用（${commandPolicy.allowlist.length} 条，管理员 ${commandPolicy.adminUsers.length} 人）`
    : "ℹ️ 指令白名单未启用";
  const allowFromPolicyLine =
    allowFromPolicy.allowFrom.length === 0 || allowFromPolicy.allowFrom.includes("*")
      ? "ℹ️ 发送者授权：未限制（allowFrom 未配置）"
      : `✅ 发送者授权：已限制 ${allowFromPolicy.allowFrom.length} 个用户`;
  const groupPolicyLine = groupPolicy.enabled
    ? groupPolicy.triggerMode === "mention"
      ? "✅ 群聊触发：仅 @ 命中后处理"
      : groupPolicy.triggerMode === "keyword"
        ? `✅ 群聊触发：关键词模式（${(groupPolicy.triggerKeywords || []).join(" / ") || "未配置关键词"}）`
        : "✅ 群聊触发：无需 @（全部处理）"
    : "⚠️ 群聊处理未启用";
  const fallbackPolicyLine = deliveryFallbackPolicy.enabled
    ? `✅ 回包兜底链路已启用（${deliveryFallbackPolicy.order.join(" > ")}）`
    : "ℹ️ 回包兜底链路未启用（仅 active_stream）";
  const streamManagerPolicyLine = streamManagerPolicy.enabled
    ? `✅ 会话串行队列已启用（每会话并发 ${streamManagerPolicy.maxConcurrentPerSession}）`
    : "ℹ️ 会话串行队列未启用";
  const webhookBotPolicyLine = webhookBotPolicy.enabled
    ? "✅ Webhook Bot 回包已启用"
    : "ℹ️ Webhook Bot 回包未启用";
  const dynamicAgentPolicyLine = dynamicAgentPolicy.enabled
    ? `✅ 动态 Agent 路由已启用（mode=${dynamicAgentPolicy.mode}，用户映射 ${Object.keys(dynamicAgentPolicy.userMap || {}).length}，群映射 ${Object.keys(dynamicAgentPolicy.groupMap || {}).length}）`
    : "ℹ️ 动态 Agent 路由未启用";
  return `📊 系统状态

渠道：企业微信 AI 机器人 (Bot)
会话ID：wecom-bot:${fromUser}
插件版本：${PLUGIN_VERSION}
Bot Webhook：${botConfig.webhookPath}

功能状态：
✅ 原生流式回复（stream）
${commandPolicyLine}
${allowFromPolicyLine}
${groupPolicyLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${dynamicAgentPolicyLine}`;
}

async function processBotInboundMessage({
  api,
  streamId,
  fromUser,
  content,
  msgType = "text",
  msgId,
  chatId,
  isGroupChat = false,
  imageUrls = [],
  responseUrl = "",
}) {
  const runtime = api.runtime;
  const cfg = api.config;
  const baseSessionId = buildWecomBotSessionId(fromUser);
  let sessionId = baseSessionId;
  let routedAgentId = "";
  const fromAddress = `wecom-bot:${fromUser}`;
  const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
  const originalContent = String(content ?? "");
  let commandBody = originalContent;
  const dispatchStartedAt = Date.now();
  const tempPathsToCleanup = [];
  const botModeConfig = resolveWecomBotConfig(api);
  const botProxyUrl = resolveWecomBotProxyConfig(api);
  const normalizedImageUrls = Array.from(
    new Set(
      (Array.isArray(imageUrls) ? imageUrls : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
  const groupChatPolicy = resolveWecomGroupChatPolicy(api);
  const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);

  const safeFinishStream = (text) => {
    if (!hasBotStream(streamId)) return;
    finishBotStream(streamId, String(text ?? ""));
  };
  const safeDeliverReply = async (reply, reason = "reply") => {
    const normalizedReply =
      typeof reply === "string"
        ? { text: reply }
        : reply && typeof reply === "object"
          ? reply
          : { text: "" };
    const contentText = String(normalizedReply.text ?? "").trim();
    const replyMediaUrls = normalizeWecomBotOutboundMediaUrls(normalizedReply);
    if (!contentText && replyMediaUrls.length === 0) return false;
    const result = await deliverBotReplyText({
      api,
      fromUser,
      sessionId,
      streamId,
      responseUrl,
      text: contentText,
      mediaUrls: replyMediaUrls,
      reason,
    });
    if (!result?.ok && hasBotStream(streamId)) {
      finishBotStream(streamId, contentText || "已收到模型返回的媒体结果，请稍后刷新。");
    }
    return result?.ok === true;
  };
  let startLateReplyWatcher = () => false;

  try {
    if (isGroupChat && msgType === "text") {
      if (!groupChatPolicy.enabled) {
        safeFinishStream("当前群聊消息处理未启用。");
        return;
      }
      if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
        const hint =
          groupChatPolicy.triggerMode === "mention"
            ? "请先 @ 机器人后再发送消息。"
            : groupChatPolicy.triggerMode === "keyword"
              ? "当前消息未命中群聊触发关键词。"
              : "当前消息不满足群聊触发条件。";
        safeFinishStream(hint);
        return;
      }
      if (shouldStripWecomGroupMentions(groupChatPolicy)) {
        commandBody = stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns);
      }
    }

    const commandPolicy = resolveWecomCommandPolicy(api);
    const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, "default", {});
    const senderAllowed = isAdminUser || isWecomSenderAllowed({
      senderId: normalizedFromUser,
      allowFrom: allowFromPolicy.allowFrom,
    });
    if (!senderAllowed) {
      safeFinishStream(allowFromPolicy.rejectMessage || "当前账号未授权，请联系管理员。");
      return;
    }

    if (msgType === "text") {
      let commandKey = extractLeadingSlashCommand(commandBody);
      if (commandKey === "/clear") {
        commandBody = commandBody.replace(/^\/clear\b/i, "/reset");
        commandKey = "/reset";
      }
      if (commandKey) {
        const commandAllowed =
          commandPolicy.allowlist.includes(commandKey) ||
          (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
        if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
          safeFinishStream(commandPolicy.rejectMessage);
          return;
        }
        if (commandKey === "/help") {
          safeFinishStream(buildWecomBotHelpText());
          return;
        }
        if (commandKey === "/status") {
          safeFinishStream(buildWecomBotStatusText(api, fromUser));
          return;
        }
      }
    }

    let messageText = String(commandBody ?? "").trim();
    if (normalizedImageUrls.length > 0) {
      const fetchedImagePaths = [];
      const imageUrlsToFetch = normalizedImageUrls.slice(0, 3);
      const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
      await mkdir(tempDir, { recursive: true });
      for (const imageUrl of imageUrlsToFetch) {
        try {
          const { buffer, contentType } = await fetchMediaFromUrl(imageUrl, {
            proxyUrl: botProxyUrl,
            logger: api.logger,
            forceProxy: Boolean(botProxyUrl),
            maxBytes: 8 * 1024 * 1024,
          });
          const normalizedType = String(contentType ?? "")
            .trim()
            .toLowerCase()
            .split(";")[0]
            .trim();
          let effectiveBuffer = buffer;
          let effectiveImageType =
            normalizedType.startsWith("image/") ? normalizedType : detectImageContentTypeFromBuffer(buffer);
          if (!effectiveImageType && botModeConfig?.encodingAesKey) {
            try {
              const decryptedBuffer = decryptWecomMediaBuffer({
                aesKey: botModeConfig.encodingAesKey,
                encryptedBuffer: buffer,
              });
              const decryptedImageType = detectImageContentTypeFromBuffer(decryptedBuffer);
              if (decryptedImageType) {
                effectiveBuffer = decryptedBuffer;
                effectiveImageType = decryptedImageType;
                api.logger.info?.(
                  `wecom(bot): decrypted media buffer from content-type=${normalizedType || "unknown"} to ${decryptedImageType}`,
                );
              }
            } catch (decryptErr) {
              api.logger.warn?.(`wecom(bot): media decrypt attempt failed: ${String(decryptErr?.message || decryptErr)}`);
            }
          }
          if (!effectiveImageType) {
            const headerHex = buffer.subarray(0, 16).toString("hex");
            throw new Error(`unexpected content-type: ${normalizedType || "unknown"} header=${headerHex}`);
          }
          const ext = pickImageFileExtension({ contentType: effectiveImageType, sourceUrl: imageUrl });
          const imageTempPath = join(
            tempDir,
            `bot-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`,
          );
          await writeFile(imageTempPath, effectiveBuffer);
          fetchedImagePaths.push(imageTempPath);
          tempPathsToCleanup.push(imageTempPath);
          api.logger.info?.(
            `wecom(bot): downloaded image from url, size=${effectiveBuffer.length} bytes, path=${imageTempPath}`,
          );
        } catch (imageErr) {
          api.logger.warn?.(`wecom(bot): failed to fetch image url: ${String(imageErr?.message || imageErr)}`);
        }
      }

      if (fetchedImagePaths.length > 0) {
        const intro = fetchedImagePaths.length > 1 ? "[用户发送了多张图片]" : "[用户发送了一张图片]";
        const parts = [];
        if (messageText) parts.push(messageText);
        parts.push(intro);
        for (let i = 0; i < fetchedImagePaths.length; i += 1) {
          parts.push(`图片${i + 1}: ${fetchedImagePaths[i]}`);
        }
        parts.push("请使用 Read 工具查看图片并基于图片内容回复用户。");
        messageText = parts.join("\n").trim();
      } else if (!messageText || messageText === "[图片]") {
        safeFinishStream("图片接收失败（下载失败或链接失效），请重新发送原图后重试。");
        return;
      } else {
        messageText = `${messageText}\n\n[附加说明] 用户还发送了图片，但插件下载失败。`;
      }
    }

    if (!messageText) {
      safeFinishStream("消息内容为空，请发送有效文本。");
      return;
    }

    const route = resolveWecomAgentRoute({
      runtime,
      cfg,
      channel: "wecom",
      accountId: "bot",
      sessionKey: baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      content: commandBody || messageText,
      mentionPatterns: groupChatPolicy.mentionPatterns,
      dynamicConfig: dynamicAgentPolicy,
      isAdminUser,
      logger: api.logger,
    });
    routedAgentId = String(route?.agentId ?? "").trim();
    sessionId = String(route?.sessionKey ?? "").trim() || baseSessionId;
    api.logger.info?.(
      `wecom(bot): routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
    );
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = runtime.channel.reply.formatInboundEnvelope({
      channel: "WeCom Bot",
      from: isGroupChat && chatId ? `${fromUser} (group:${chatId})` : fromUser,
      timestamp: Date.now(),
      body: messageText,
      chatType: isGroupChat ? "group" : "direct",
      sender: {
        name: fromUser,
        id: fromUser,
      },
      ...envelopeOptions,
    });
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: messageText,
      RawBody: originalContent,
      CommandBody: commandBody,
      From: fromAddress,
      To: fromAddress,
      SessionKey: sessionId,
      AccountId: "bot",
      ChatType: isGroupChat ? "group" : "direct",
      ConversationLabel: isGroupChat && chatId ? `group:${chatId}` : fromUser,
      SenderName: fromUser,
      SenderId: fromUser,
      Provider: "wecom",
      Surface: "wecom-bot",
      MessageSid: msgId || `wecom-bot-${Date.now()}`,
      Timestamp: Date.now(),
      OriginatingChannel: "wecom",
      OriginatingTo: fromAddress,
    });
    const sessionRuntimeId = String(ctxPayload.SessionId ?? "").trim();

    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "wecom",
        to: fromUser,
        accountId: "bot",
      },
      onRecordError: (err) => {
        api.logger.warn?.(`wecom(bot): failed to record session: ${err}`);
      },
    });

    runtime.channel.activity.record({
      channel: "wecom",
      accountId: "bot",
      direction: "inbound",
    });

    let blockText = "";
    let streamFinished = false;
    let lateReplyWatcherPromise = null;
    const replyTimeoutMs = Math.max(15000, Number(botModeConfig?.replyTimeoutMs) || 90000);
    const lateReplyWatchMs = Math.max(30000, Number(botModeConfig?.lateReplyWatchMs) || 180000);
    const lateReplyPollMs = Math.max(500, Number(botModeConfig?.lateReplyPollMs) || 2000);
    const tryFinishFromTranscript = async (minTimestamp = dispatchStartedAt) => {
      try {
        const transcriptPath = await resolveSessionTranscriptFilePath({
          storePath,
          sessionKey: sessionId,
          sessionId: sessionRuntimeId || sessionId,
          logger: api.logger,
        });
        const { chunk } = await readTranscriptAppendedChunk(transcriptPath, 0);
        if (!chunk) return false;
        const lines = chunk.split("\n");
        let latestReply = null;
        for (const line of lines) {
          const parsedReply = parseLateAssistantReplyFromTranscriptLine(line, minTimestamp);
          if (!parsedReply) continue;
          if (hasTranscriptReplyBeenDelivered(sessionId, parsedReply.transcriptMessageId)) continue;
          latestReply = parsedReply;
        }
        if (!latestReply?.text) return false;
        const transcriptText = markdownToWecomText(latestReply.text).trim();
        if (!transcriptText) return false;
        streamFinished = await safeDeliverReply(transcriptText, "transcript-fallback");
        if (streamFinished) {
          markTranscriptReplyDelivered(sessionId, latestReply.transcriptMessageId);
        }
        api.logger.info?.(
          `wecom(bot): filled reply from transcript session=${sessionId} messageId=${latestReply.transcriptMessageId}`,
        );
        return true;
      } catch (err) {
        api.logger.warn?.(`wecom(bot): transcript fallback failed: ${String(err?.message || err)}`);
        return false;
      }
    };
    startLateReplyWatcher = (reason = "dispatch-timeout", minTimestamp = dispatchStartedAt) => {
      if (streamFinished || lateReplyWatcherPromise) return false;
      const watchStartedAt = Date.now();
      const watchId = `wecom-bot:${sessionId}:${msgId || watchStartedAt}:${Math.random().toString(36).slice(2, 8)}`;
      ACTIVE_LATE_REPLY_WATCHERS.set(watchId, {
        sessionId,
        sessionKey: sessionId,
        accountId: "bot",
        startedAt: watchStartedAt,
        reason,
      });
      lateReplyWatcherPromise = (async () => {
        try {
          api.logger.info?.(
            `wecom(bot): late reply watcher started session=${sessionId} reason=${reason} timeoutMs=${lateReplyWatchMs}`,
          );
          const deadline = watchStartedAt + lateReplyWatchMs;
          while (Date.now() < deadline) {
            if (streamFinished) return;
            const delivered = await tryFinishFromTranscript(minTimestamp);
            if (delivered || streamFinished) return;
            await sleep(lateReplyPollMs);
          }
          if (!streamFinished) {
            api.logger.warn?.(
              `wecom(bot): late reply watcher timed out session=${sessionId} timeoutMs=${lateReplyWatchMs}`,
            );
            await safeDeliverReply("抱歉，当前模型请求超时或网络不稳定，请稍后重试。", "late-timeout-fallback");
          }
        } catch (watchErr) {
          api.logger.warn?.(`wecom(bot): late reply watcher failed: ${String(watchErr?.message || watchErr)}`);
          if (!streamFinished) {
            await safeDeliverReply(
              `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${String(watchErr?.message || watchErr).slice(0, 160)}`,
              "late-watcher-error",
            );
          }
        } finally {
          ACTIVE_LATE_REPLY_WATCHERS.delete(watchId);
          lateReplyWatcherPromise = null;
        }
      })();
      return true;
    };

    await withTimeout(
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        replyOptions: {
          disableBlockStreaming: false,
          routeOverrides:
            routedAgentId && sessionId
              ? {
                  sessionKey: sessionId,
                  agentId: routedAgentId,
                  accountId: "bot",
                }
              : undefined,
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (!hasBotStream(streamId)) return;
            if (info.kind === "block") {
              if (!payload?.text) return;
              const incomingBlock = String(payload.text);
              if (incomingBlock.startsWith(blockText)) {
                blockText = incomingBlock;
              } else if (!blockText.endsWith(incomingBlock)) {
                blockText += incomingBlock;
              }
              updateBotStream(streamId, markdownToWecomText(blockText), { append: false, finished: false });
              return;
            }
            if (info.kind !== "final") return;
            if (payload?.text) {
              if (isAgentFailureText(payload.text)) {
                streamFinished = await safeDeliverReply(`抱歉，请求失败：${payload.text}`, "upstream-failure");
                return;
              }
              const finalText = markdownToWecomText(payload.text).trim();
              if (finalText) {
                streamFinished = await safeDeliverReply(finalText, "final");
                return;
              }
            }
            if (payload?.mediaUrl || (payload?.mediaUrls?.length ?? 0) > 0) {
              streamFinished = await safeDeliverReply(
                {
                  text: "已收到模型返回的媒体结果。",
                  mediaUrl: payload.mediaUrl,
                  mediaUrls: payload.mediaUrls,
                },
                "final-media",
              );
              return;
            }
          },
          onError: async (err, info) => {
            api.logger.error?.(`wecom(bot): ${info.kind} reply failed: ${String(err)}`);
            streamFinished = await safeDeliverReply(
              `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
              `dispatch-${info.kind}-error`,
            );
          },
        },
      }),
      replyTimeoutMs,
      `dispatch timed out after ${replyTimeoutMs}ms`,
    );

    if (!streamFinished) {
      const filledFromTranscript = await tryFinishFromTranscript(dispatchStartedAt);
      if (filledFromTranscript) return;
      const fallback = markdownToWecomText(blockText).trim();
      if (fallback) {
        await safeDeliverReply(fallback, "block-fallback");
      } else {
        const watcherStarted = startLateReplyWatcher("dispatch-finished-without-final", dispatchStartedAt);
        if (watcherStarted) return;
        api.logger.warn?.(
          `wecom(bot): dispatch finished without deliverable content; late watcher unavailable, fallback to timeout text session=${sessionId}`,
        );
        await safeDeliverReply("抱歉，当前模型请求超时或网络不稳定，请稍后重试。", "timeout-fallback");
      }
    }
  } catch (err) {
    api.logger.warn?.(`wecom(bot): processing failed: ${String(err?.message || err)}`);
    if (isDispatchTimeoutError(err)) {
      const watcherStarted = (() => {
        try {
          return startLateReplyWatcher("dispatch-timeout", dispatchStartedAt);
        } catch {
          return false;
        }
      })();
      if (watcherStarted) return;
    }
    try {
      const fallbackFromTranscript = await (async () => {
        try {
          const runtimeSessionId = sessionId || buildWecomBotSessionId(fromUser);
          const runtimeStorePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: routedAgentId || "main",
          });
          const transcriptPath = await resolveSessionTranscriptFilePath({
            storePath: runtimeStorePath,
            sessionKey: runtimeSessionId,
            sessionId: runtimeSessionId,
            logger: api.logger,
          });
          const { chunk } = await readTranscriptAppendedChunk(transcriptPath, 0);
          if (!chunk) return "";
          const lines = chunk.split("\n");
          let latestReply = null;
          for (const line of lines) {
            const parsedReply = parseLateAssistantReplyFromTranscriptLine(line, dispatchStartedAt);
            if (!parsedReply) continue;
            if (hasTranscriptReplyBeenDelivered(runtimeSessionId, parsedReply.transcriptMessageId)) continue;
            latestReply = parsedReply;
          }
          const text = latestReply?.text ? markdownToWecomText(latestReply.text).trim() : "";
          if (text && latestReply?.transcriptMessageId) {
            markTranscriptReplyDelivered(runtimeSessionId, latestReply.transcriptMessageId);
          }
          return text || "";
        } catch {
          return "";
        }
      })();
      if (fallbackFromTranscript) {
        await safeDeliverReply(fallbackFromTranscript, "catch-transcript-fallback");
        return;
      }
    } catch {
      // ignore transcript fallback errors in catch block
    }
    await safeDeliverReply(
      `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
      "catch-timeout-fallback",
    );
  } finally {
    for (const filePath of tempPathsToCleanup) {
      scheduleTempFileCleanup(filePath, api.logger);
    }
  }
}

// 异步处理入站消息 - 使用 gateway 内部 agent runtime API
async function processInboundMessage({
  api,
  accountId,
  fromUser,
  content,
  msgType,
  mediaId,
  picUrl,
  recognition,
  thumbMediaId,
  fileName,
  fileSize,
  linkTitle,
  linkDescription,
  linkUrl,
  linkPicUrl,
  chatId,
  isGroupChat,
  msgId,
}) {
  const config = getWecomConfig(api, accountId);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
    api.logger.warn?.("wecom: not configured (check channels.wecom in openclaw.json)");
    return;
  }

  const { corpId, corpSecret, agentId, outboundProxy: proxyUrl } = config;

  try {
    // 一用户一会话：群聊和私聊统一归并到 wecom:<userid>
    const baseSessionId = buildWecomSessionId(fromUser);
    let sessionId = baseSessionId;
    let routedAgentId = "";
    const fromAddress = `wecom:${fromUser}`;
    const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
    const originalContent = content || "";
    let commandBody = originalContent;
    const groupChatPolicy = resolveWecomGroupChatPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`);

    // 群聊触发策略（仅对文本消息）
    if (msgType === "text" && isGroupChat) {
      if (!groupChatPolicy.enabled) {
        api.logger.info?.(`wecom: group chat processing disabled, skipped chatId=${chatId || "unknown"}`);
        return;
      }
      if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
        api.logger.info?.(
          `wecom: group message skipped by trigger policy chatId=${chatId || "unknown"} mode=${groupChatPolicy.triggerMode || "direct"}`,
        );
        return;
      }
      if (shouldStripWecomGroupMentions(groupChatPolicy)) {
        commandBody = stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns);
      }
      if (!commandBody.trim()) {
        api.logger.info?.(`wecom: group message became empty after mention strip chatId=${chatId || "unknown"}`);
        return;
      }
    }

    const commandPolicy = resolveWecomCommandPolicy(api);
    const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, config.accountId || accountId || "default", config);
    const senderAllowed = isAdminUser || isWecomSenderAllowed({
      senderId: normalizedFromUser,
      allowFrom: allowFromPolicy.allowFrom,
    });
    if (!senderAllowed) {
      api.logger.warn?.(
        `wecom: sender blocked by allowFrom account=${config.accountId || "default"} user=${normalizedFromUser}`,
      );
      if (allowFromPolicy.rejectMessage) {
        await sendWecomText({
          corpId,
          corpSecret,
          agentId,
          toUser: fromUser,
          text: allowFromPolicy.rejectMessage,
          logger: api.logger,
          proxyUrl,
        });
      }
      return;
    }

    // 命令检测（仅对文本消息）
    if (msgType === "text") {
      let commandKey = extractLeadingSlashCommand(commandBody);
      if (commandKey === "/clear") {
        api.logger.info?.("wecom: translating /clear to native /reset command");
        commandBody = commandBody.replace(/^\/clear\b/i, "/reset");
        commandKey = "/reset";
      }
      if (commandKey) {
        const commandAllowed =
          commandPolicy.allowlist.includes(commandKey) ||
          (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
        if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
          api.logger.info?.(`wecom: command blocked by allowlist user=${fromUser} command=${commandKey}`);
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: commandPolicy.rejectMessage,
            logger: api.logger,
            proxyUrl,
          });
          return;
        }
        const handler = COMMANDS[commandKey];
        if (handler) {
          api.logger.info?.(`wecom: handling command ${commandKey}`);
          await handler({
            api,
            fromUser,
            corpId,
            corpSecret,
            agentId,
            accountId: config.accountId || "default",
            proxyUrl,
            chatId,
            isGroupChat,
          });
          return; // 命令已处理，不再调用 AI
        }
      }
    }

    let messageText = msgType === "text" ? commandBody : originalContent;
    const tempPathsToCleanup = [];

    // 处理图片消息 - 真正的 Vision 能力
    let imageBase64 = null;
    let imageMimeType = null;

    if (msgType === "image" && mediaId) {
      api.logger.info?.(`wecom: downloading image mediaId=${mediaId}`);

      try {
        // 优先使用 mediaId 下载原图
        const { buffer, contentType } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        imageBase64 = buffer.toString("base64");
        imageMimeType = contentType || "image/jpeg";
        messageText = "[用户发送了一张图片]";
        api.logger.info?.(`wecom: image downloaded, size=${buffer.length} bytes, type=${imageMimeType}`);
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download image via mediaId: ${downloadErr.message}`);

        // 降级：尝试通过 PicUrl 下载
        if (picUrl) {
          try {
            const { buffer, contentType } = await fetchMediaFromUrl(picUrl);
            imageBase64 = buffer.toString("base64");
            imageMimeType = contentType || "image/jpeg";
            messageText = "[用户发送了一张图片]";
            api.logger.info?.(`wecom: image downloaded via PicUrl, size=${buffer.length} bytes`);
          } catch (picUrlErr) {
            api.logger.warn?.(`wecom: failed to download image via PicUrl: ${picUrlErr.message}`);
            messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
          }
        } else {
          messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
        }
      }
    }

    // 处理语音消息
    if (msgType === "voice" && mediaId) {
      api.logger.info?.(`wecom: received voice message mediaId=${mediaId}`);
      const recognizedText = String(recognition ?? "").trim();
      if (recognizedText) {
        api.logger.info?.(`wecom: voice recognition result from WeCom: ${recognizedText.slice(0, 50)}...`);
        messageText = `[语音消息转写]\n${recognizedText}`;
      } else {
        const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
        if (!voiceConfig.enabled) {
          api.logger.info?.("wecom: voice transcription fallback disabled; asking user to send text");
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: "语音识别未启用，请先开启企业微信语音识别，或直接发送文字消息。",
            logger: api.logger,
            proxyUrl,
          });
          return;
        }

        try {
          const { buffer, contentType } = await downloadWecomMedia({
            corpId,
            corpSecret,
            mediaId,
            proxyUrl,
            logger: api.logger,
          });
          api.logger.info?.(
            `wecom: downloaded voice media for transcription, size=${buffer.length}, type=${contentType || "unknown"}`,
          );
          const transcript = await transcribeInboundVoice({
            api,
            buffer,
            contentType,
            mediaId,
            voiceConfig,
          });
          messageText = `[语音消息转写]\n${transcript}`;
          api.logger.info?.(`wecom: voice transcribed via ${voiceConfig.model}: ${transcript.slice(0, 80)}...`);
        } catch (voiceErr) {
          api.logger.warn?.(`wecom: voice transcription failed: ${String(voiceErr?.message || voiceErr)}`);
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text:
              "语音识别失败，请稍后重试。\n" +
              "如持续失败，请确认本地 whisper 命令可用、模型路径已配置，并已安装 ffmpeg。",
            logger: api.logger,
            proxyUrl,
          });
          return;
        }
      }
    }

    // 处理视频消息
    if (msgType === "video" && mediaId) {
      api.logger.info?.(`wecom: received video message mediaId=${mediaId}`);
      try {
        const { buffer, contentType } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
        await mkdir(tempDir, { recursive: true });
        const videoTempPath = join(tempDir, `video-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
        await writeFile(videoTempPath, buffer);
        tempPathsToCleanup.push(videoTempPath);
        api.logger.info?.(`wecom: saved video to ${videoTempPath}, size=${buffer.length} bytes`);
        messageText = `[用户发送了一个视频文件，已保存到: ${videoTempPath}]\n\n请告知用户您已收到视频。`;
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download video: ${downloadErr.message}`);
        messageText = "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。";
      }
    }

    // 处理文件消息
    if (msgType === "file" && mediaId) {
      api.logger.info?.(`wecom: received file message mediaId=${mediaId}, fileName=${fileName}, size=${fileSize}`);
      try {
        const { buffer, contentType } = await downloadWecomMedia({
          corpId,
          corpSecret,
          mediaId,
          proxyUrl,
          logger: api.logger,
        });
        const ext = fileName ? fileName.split(".").pop() : "bin";
        const safeFileName = fileName || `file-${Date.now()}.${ext}`;
        const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
        await mkdir(tempDir, { recursive: true });
        const fileTempPath = join(tempDir, `${Date.now()}-${safeFileName}`);
        await writeFile(fileTempPath, buffer);
        tempPathsToCleanup.push(fileTempPath);
        api.logger.info?.(`wecom: saved file to ${fileTempPath}, size=${buffer.length} bytes`);

        const readableTypes = [".txt", ".md", ".json", ".xml", ".csv", ".log", ".pdf"];
        const isReadable = readableTypes.some((t) => safeFileName.toLowerCase().endsWith(t));

        if (isReadable) {
          messageText = `[用户发送了一个文件: ${safeFileName}，已保存到: ${fileTempPath}]\n\n请使用 Read 工具查看这个文件的内容。`;
        } else {
          messageText = `[用户发送了一个文件: ${safeFileName}，大小: ${fileSize || buffer.length} 字节，已保存到: ${fileTempPath}]\n\n请告知用户您已收到文件。`;
        }
      } catch (downloadErr) {
        api.logger.warn?.(`wecom: failed to download file: ${downloadErr.message}`);
        messageText = `[用户发送了一个文件${fileName ? `: ${fileName}` : ""}，但下载失败]\n\n请告诉用户文件处理暂时不可用。`;
      }
    }

    // 处理链接分享消息
    if (msgType === "link") {
      api.logger.info?.(`wecom: received link message title=${linkTitle}, url=${linkUrl}`);
      messageText = `[用户分享了一个链接]\n标题: ${linkTitle || '(无标题)'}\n描述: ${linkDescription || '(无描述)'}\n链接: ${linkUrl || '(无链接)'}\n\n请根据链接内容回复用户。如需要，可以使用 WebFetch 工具获取链接内容。`;
    }

    if (!messageText) {
      api.logger.warn?.("wecom: empty message content");
      return;
    }

    // 如果有图片，保存到临时文件供 AI 读取
    let imageTempPath = null;
    if (imageBase64 && imageMimeType) {
      try {
        const ext = imageMimeType.includes("png") ? "png" : imageMimeType.includes("gif") ? "gif" : "jpg";
        const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
        await mkdir(tempDir, { recursive: true });
        imageTempPath = join(tempDir, `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        await writeFile(imageTempPath, Buffer.from(imageBase64, "base64"));
        tempPathsToCleanup.push(imageTempPath);
        api.logger.info?.(`wecom: saved image to ${imageTempPath}`);
        // 更新消息文本，告知 AI 图片位置
        messageText = `[用户发送了一张图片，已保存到: ${imageTempPath}]\n\n请使用 Read 工具查看这张图片并描述内容。`;
      } catch (saveErr) {
        api.logger.warn?.(`wecom: failed to save image: ${saveErr.message}`);
        messageText = "[用户发送了一张图片，但保存失败]\n\n请告诉用户图片处理暂时不可用。";
        imageTempPath = null;
      }
    }

    // 获取路由信息
    const route = resolveWecomAgentRoute({
      runtime,
      cfg,
      channel: "wecom",
      accountId: config.accountId || "default",
      sessionKey: baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      content: commandBody || messageText,
      mentionPatterns: groupChatPolicy.mentionPatterns,
      dynamicConfig: dynamicAgentPolicy,
      isAdminUser,
      logger: api.logger,
    });
    routedAgentId = String(route?.agentId ?? "").trim();
    sessionId = String(route?.sessionKey ?? "").trim() || baseSessionId;
    api.logger.info?.(
      `wecom: routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
    );

    // 获取 storePath
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    // 格式化消息体
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = runtime.channel.reply.formatInboundEnvelope({
      channel: "WeCom",
      from: isGroupChat && chatId ? `${fromUser} (group:${chatId})` : fromUser,
      timestamp: Date.now(),
      body: messageText,
      chatType: isGroupChat ? "group" : "direct",
      sender: {
        name: fromUser,
        id: fromUser,
      },
      ...envelopeOptions,
    });

    // 构建 Session 上下文对象
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: messageText,
      RawBody: originalContent,
      CommandBody: commandBody,
      From: fromAddress,
      To: fromAddress,
      SessionKey: sessionId,
      AccountId: config.accountId || "default",
      ChatType: isGroupChat ? "group" : "direct",
      ConversationLabel: isGroupChat && chatId ? `group:${chatId}` : fromUser,
      SenderName: fromUser,
      SenderId: fromUser,
      Provider: "wecom",
      Surface: "wecom",
      MessageSid: msgId || `wecom-${Date.now()}`,
      Timestamp: Date.now(),
      OriginatingChannel: "wecom",
      OriginatingTo: fromAddress,
    });

    // 注册会话到 Sessions UI
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "wecom",
        to: fromUser,
        accountId: config.accountId || "default",
      },
      onRecordError: (err) => {
        api.logger.warn?.(`wecom: failed to record session: ${err}`);
      },
    });
    api.logger.info?.(`wecom: session registered for ${sessionId}`);

    // 记录渠道活动
    runtime.channel.activity.record({
      channel: "wecom",
      accountId: config.accountId || "default",
      direction: "inbound",
    });

    api.logger.info?.(`wecom: dispatching message via agent runtime for session ${sessionId}`);

    // 使用 gateway 内部 agent runtime API 调用 AI
    // 对标 Telegram 的 dispatchReplyWithBufferedBlockDispatcher

    let hasDeliveredReply = false;
    let hasDeliveredPartialReply = false;
    let hasSentProgressNotice = false;
    let blockTextFallback = "";
    let streamChunkBuffer = "";
    let streamChunkLastSentAt = 0;
    let streamChunkSentCount = 0;
    let streamChunkSendChain = Promise.resolve();
    let suppressLateDispatcherDeliveries = false;
    let progressNoticeTimer = null;
    let lateReplyWatcherPromise = null;
    const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
    const streamingEnabled = streamingPolicy.enabled === true;
    const replyTimeoutMs = Math.max(
      15000,
      asNumber(cfg?.env?.vars?.WECOM_REPLY_TIMEOUT_MS ?? requireEnv("WECOM_REPLY_TIMEOUT_MS"), 90000),
    );
    const progressNoticeDelayMs = Math.max(
      0,
      asNumber(cfg?.env?.vars?.WECOM_PROGRESS_NOTICE_MS ?? requireEnv("WECOM_PROGRESS_NOTICE_MS"), 0),
    );
    const lateReplyWatchMs = Math.max(
      30000,
      Math.min(
        10 * 60 * 1000,
        asNumber(
          cfg?.env?.vars?.WECOM_LATE_REPLY_WATCH_MS ?? requireEnv("WECOM_LATE_REPLY_WATCH_MS"),
          Math.max(replyTimeoutMs, 180000),
        ),
      ),
    );
    const lateReplyPollMs = Math.max(
      500,
      Math.min(
        10000,
        asNumber(cfg?.env?.vars?.WECOM_LATE_REPLY_POLL_MS ?? requireEnv("WECOM_LATE_REPLY_POLL_MS"), 2000),
      ),
    );
    // 自建应用模式默认不发送“处理中”提示，避免打扰用户。
    const processingNoticeText = "";
    const queuedNoticeText = "";
    const enqueueStreamingChunk = async (text, reason = "stream") => {
      const chunkText = String(text ?? "").trim();
      if (!chunkText || hasDeliveredReply) return;
      hasDeliveredPartialReply = true;
      streamChunkSendChain = streamChunkSendChain
        .then(async () => {
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: chunkText,
            logger: api.logger,
            proxyUrl,
          });
          streamChunkLastSentAt = Date.now();
          streamChunkSentCount += 1;
          api.logger.info?.(
            `wecom: streamed block chunk ${streamChunkSentCount} (${reason}), bytes=${getByteLength(chunkText)}`,
          );
        })
        .catch((streamErr) => {
          api.logger.warn?.(`wecom: failed to send streaming block chunk: ${String(streamErr)}`);
        });
      await streamChunkSendChain;
    };
    const flushStreamingBuffer = async ({ force = false, reason = "stream" } = {}) => {
      if (!streamingEnabled || hasDeliveredReply) return false;
      const pendingText = String(streamChunkBuffer ?? "");
      const candidate = markdownToWecomText(pendingText).trim();
      if (!candidate) return false;

      const minChars = Math.max(20, Number(streamingPolicy.minChars || 120));
      const minIntervalMs = Math.max(200, Number(streamingPolicy.minIntervalMs || 1200));
      if (!force) {
        if (candidate.length < minChars) return false;
        if (Date.now() - streamChunkLastSentAt < minIntervalMs) return false;
      }

      streamChunkBuffer = "";
      await enqueueStreamingChunk(candidate, reason);
      return true;
    };
    const sendProgressNotice = async (text = processingNoticeText) => {
      const noticeText = String(text ?? "").trim();
      if (!noticeText) return;
      if (hasDeliveredReply || hasDeliveredPartialReply || hasSentProgressNotice) return;
      hasSentProgressNotice = true;
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text: noticeText,
        logger: api.logger,
        proxyUrl,
      });
    };
    const sendFailureFallback = async (reason) => {
      if (hasDeliveredReply) return;
      hasDeliveredReply = true;
      const reasonText = String(reason ?? "unknown").slice(0, 160);
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text: `抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${reasonText}`,
        logger: api.logger,
        proxyUrl,
      });
    };
    const startLateReplyWatcher = async (reason = "pending-final") => {
      if (hasDeliveredReply || hasDeliveredPartialReply || lateReplyWatcherPromise) return;

      const watchStartedAt = Date.now();
      const watchId = `${sessionId}:${msgId || watchStartedAt}:${Math.random().toString(36).slice(2, 8)}`;
      ACTIVE_LATE_REPLY_WATCHERS.set(watchId, {
        sessionId,
        sessionKey: sessionId,
        accountId: config.accountId || "default",
        startedAt: watchStartedAt,
        reason,
      });

      lateReplyWatcherPromise = (async () => {
        try {
          const transcriptPath = await resolveSessionTranscriptFilePath({
            storePath,
            sessionKey: sessionId,
            sessionId: ctxPayload.SessionId || sessionId,
            logger: api.logger,
          });
          let offset = 0;
          let remainder = "";
          try {
            const fileStat = await stat(transcriptPath);
            offset = Number(fileStat.size ?? 0);
          } catch {
            offset = 0;
          }

          const deadline = watchStartedAt + lateReplyWatchMs;
          api.logger.info?.(
            `wecom: late reply watcher started session=${sessionId} reason=${reason} timeoutMs=${lateReplyWatchMs}`,
          );

          while (Date.now() < deadline) {
            if (hasDeliveredReply) return;
            await sleep(lateReplyPollMs);
            if (hasDeliveredReply) return;

            const { nextOffset, chunk } = await readTranscriptAppendedChunk(transcriptPath, offset);
            offset = nextOffset;
            if (!chunk) continue;

            const combined = remainder + chunk;
            const lines = combined.split("\n");
            remainder = lines.pop() ?? "";

            for (const line of lines) {
              const parsed = parseLateAssistantReplyFromTranscriptLine(line, watchStartedAt);
              if (!parsed) continue;
              if (hasTranscriptReplyBeenDelivered(sessionId, parsed.transcriptMessageId)) continue;
              if (hasDeliveredReply) return;

              const formattedReply = markdownToWecomText(parsed.text);
              if (!formattedReply) continue;

              await sendWecomText({
                corpId,
                corpSecret,
                agentId,
                toUser: fromUser,
                text: formattedReply,
                logger: api.logger,
                proxyUrl,
              });
              markTranscriptReplyDelivered(sessionId, parsed.transcriptMessageId);
              hasDeliveredReply = true;
              api.logger.info?.(
                `wecom: delivered async late reply session=${sessionId} transcriptMessageId=${parsed.transcriptMessageId}`,
              );
              return;
            }
          }

          if (!hasDeliveredReply) {
            api.logger.warn?.(
              `wecom: late reply watcher timed out session=${sessionId} timeoutMs=${lateReplyWatchMs}`,
            );
            await sendFailureFallback(`late reply watcher timed out after ${lateReplyWatchMs}ms`);
          }
        } catch (err) {
          api.logger.warn?.(`wecom: late reply watcher failed: ${String(err?.message || err)}`);
          if (!hasDeliveredReply) {
            await sendFailureFallback(err);
          }
        } finally {
          ACTIVE_LATE_REPLY_WATCHERS.delete(watchId);
          lateReplyWatcherPromise = null;
        }
      })();
    };

    try {
      if (progressNoticeDelayMs > 0) {
        progressNoticeTimer = setTimeout(() => {
          sendProgressNotice().catch((noticeErr) => {
            api.logger.warn?.(`wecom: failed to send progress notice: ${String(noticeErr)}`);
          });
        }, progressNoticeDelayMs);
      }

      let dispatchResult = null;
      api.logger.info?.(`wecom: waiting for agent reply (timeout=${replyTimeoutMs}ms)`);
      dispatchResult = await withTimeout(
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (payload, info) => {
              if (suppressLateDispatcherDeliveries) {
                api.logger.info?.("wecom: suppressed late dispatcher delivery after timeout handoff");
                return;
              }
              if (hasDeliveredReply) {
                api.logger.info?.("wecom: ignoring late reply because a reply was already delivered");
                return;
              }
              if (info.kind === "block") {
                if (payload.text) {
                  if (blockTextFallback) blockTextFallback += "\n";
                  blockTextFallback += payload.text;
                  if (streamingEnabled) {
                    streamChunkBuffer += payload.text;
                    await flushStreamingBuffer({ force: false, reason: "block" });
                  }
                }
                return;
              }
              if (info.kind !== "final") return;
              // 发送回复到企业微信
              if (payload.text) {
                if (isAgentFailureText(payload.text)) {
                  api.logger.warn?.(`wecom: upstream returned failure-like payload: ${payload.text}`);
                  await sendFailureFallback(payload.text);
                  return;
                }

                api.logger.info?.(`wecom: delivering ${info.kind} reply, length=${payload.text.length}`);
                if (streamingEnabled) {
                  await flushStreamingBuffer({ force: true, reason: "final" });
                  await streamChunkSendChain;
                  if (streamChunkSentCount > 0) {
                    const finalText = markdownToWecomText(payload.text).trim();
                    const streamedText = markdownToWecomText(blockTextFallback).trim();
                    const tailText =
                      finalText && streamedText && finalText.startsWith(streamedText)
                        ? finalText.slice(streamedText.length).trim()
                        : "";
                    if (tailText) {
                      await sendWecomText({
                        corpId,
                        corpSecret,
                        agentId,
                        toUser: fromUser,
                        text: tailText,
                        logger: api.logger,
                        proxyUrl,
                      });
                    }
                    hasDeliveredReply = true;
                    api.logger.info?.(
                      `wecom: streaming reply completed for ${fromUser}, chunks=${streamChunkSentCount}${tailText ? " +tail" : ""}`,
                    );
                    return;
                  }
                }

                // 应用 Markdown 转换
                const formattedReply = markdownToWecomText(payload.text);
                await sendWecomText({
                  corpId,
                  corpSecret,
                  agentId,
                  toUser: fromUser,
                  text: formattedReply,
                  logger: api.logger,
                  proxyUrl,
                });
                hasDeliveredReply = true;
                api.logger.info?.(`wecom: sent AI reply to ${fromUser}: ${formattedReply.slice(0, 50)}...`);
              } else if (payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0) {
                // 当前插件只稳定支持文本回包；若上游仅返回媒体，先给用户明确提示避免无响应。
                await sendWecomText({
                  corpId,
                  corpSecret,
                  agentId,
                  toUser: fromUser,
                  text: "已收到模型返回的媒体结果，但当前版本暂不支持直接回传该媒体，请稍后重试文本请求。",
                  logger: api.logger,
                  proxyUrl,
                });
                hasDeliveredReply = true;
              }
            },
            onError: async (err, info) => {
              if (suppressLateDispatcherDeliveries) return;
              api.logger.error?.(`wecom: ${info.kind} reply failed: ${String(err)}`);
              try {
                await sendFailureFallback(err);
              } catch (fallbackErr) {
                api.logger.error?.(`wecom: failed to send fallback reply: ${fallbackErr.message}`);
              }
            },
          },
          replyOptions: {
            // 企业微信不支持编辑消息；开启流式时会以“多条文本消息”模拟增量输出。
            disableBlockStreaming: !streamingEnabled,
            routeOverrides:
              routedAgentId && sessionId
                ? {
                    sessionKey: sessionId,
                    agentId: routedAgentId,
                    accountId: config.accountId || "default",
                  }
                : undefined,
          },
        }),
        replyTimeoutMs,
        `dispatch timed out after ${replyTimeoutMs}ms`,
      );

      if (streamingEnabled) {
        await flushStreamingBuffer({ force: true, reason: "post-dispatch" });
        await streamChunkSendChain;
      }

      if (!hasDeliveredReply && !hasDeliveredPartialReply) {
        const blockText = String(blockTextFallback || "").trim();
        if (blockText) {
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: markdownToWecomText(blockText),
            logger: api.logger,
            proxyUrl,
          });
          hasDeliveredReply = true;
          api.logger.info?.("wecom: delivered accumulated block reply as final fallback");
        }
      }

      if (!hasDeliveredReply && !hasDeliveredPartialReply) {
        const counts = dispatchResult?.counts ?? {};
        const queuedFinal = dispatchResult?.queuedFinal === true;
        const deliveredCount = Number(counts.final ?? 0) + Number(counts.block ?? 0) + Number(counts.tool ?? 0);
        if (!queuedFinal && deliveredCount === 0) {
          // 常见于同一会话已有活跃 run：当前消息被排队，暂无可立即发送的最终回复
          api.logger.warn?.("wecom: no immediate deliverable reply (likely queued behind active run)");
          await sendProgressNotice(queuedNoticeText);
          await startLateReplyWatcher("queued-no-final");
        } else {
          // 进入这里说明 dispatcher 有输出或已排队，但当前回调还没有拿到可立即下发的 final。
          // 自建应用不主动发处理中提示，仅转入异步补发观察。
          api.logger.warn?.(
            "wecom: dispatch finished without direct final delivery; waiting via late watcher",
          );
          await sendProgressNotice(processingNoticeText);
          await startLateReplyWatcher("dispatch-finished-without-final");
        }
      }
    } catch (dispatchErr) {
      api.logger.warn?.(`wecom: dispatch failed: ${String(dispatchErr)}`);
      if (isDispatchTimeoutError(dispatchErr)) {
        suppressLateDispatcherDeliveries = true;
        await sendProgressNotice(queuedNoticeText);
        await startLateReplyWatcher("dispatch-timeout");
      } else {
        await sendFailureFallback(dispatchErr);
      }
    } finally {
      if (progressNoticeTimer) clearTimeout(progressNoticeTimer);
      for (const filePath of tempPathsToCleanup) {
        scheduleTempFileCleanup(filePath, api.logger);
      }
    }

  } catch (err) {
    api.logger.error?.(`wecom: failed to process message: ${err.message}`);
    api.logger.error?.(`wecom: stack trace: ${err.stack}`);

    // 发送错误提示给用户
    try {
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text: `抱歉，处理您的消息时出现错误，请稍后重试。\n错误: ${err.message?.slice(0, 100) || "未知错误"}`,
        logger: api.logger,
        proxyUrl,
      });
    } catch (sendErr) {
      api.logger.error?.(`wecom: failed to send error message: ${sendErr.message}`);
      api.logger.error?.(`wecom: send error stack: ${sendErr.stack}`);
      api.logger.error?.(`wecom: original error was: ${err.message}`);
    }
  }
}

export const __internal = {
  buildWecomSessionId,
  buildInboundDedupeKey,
  markInboundMessageSeen,
  resetInboundMessageDedupeForTests,
  splitWecomText,
  getByteLength,
  computeMsgSignature,
  pickAccountBySignature,
};
