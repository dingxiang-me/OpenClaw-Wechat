import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { normalizePluginHttpPath } from "openclaw/plugin-sdk";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WECOM_TEXT_BYTE_LIMIT,
  buildWecomSessionId,
  buildInboundDedupeKey,
  markInboundMessageSeen,
  resetInboundMessageDedupeForTests,
  computeMsgSignature,
  getByteLength,
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
const PLUGIN_VERSION = "0.4.1";
const WECOM_TEMP_DIR_NAME = "openclaw-wechat";
const WECOM_TEMP_FILE_RETENTION_MS = 30 * 60 * 1000;

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

function parseIncomingXml(xml) {
  const obj = xmlParser.parse(xml);
  const root = obj?.xml ?? obj;
  return root;
}

function requireEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v;
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

async function getWecomAccessToken({ corpId, corpSecret }) {
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
      const tokenRes = await fetchWithRetry(tokenUrl);
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

// 带重试机制的 fetch 包装函数
async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 1000) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      
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
async function sendWecomTextSingle({ corpId, corpSecret, agentId, toUser, text, logger }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });

    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "text",
      agentid: agentId,
      text: { content: text },
      safe: 0,
    };
    const sendRes = await fetchWithRetry(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom message/send failed: ${JSON.stringify(sendJson)}`);
    }
    logger?.info?.(`wecom: message sent ok (to=${toUser}, msgid=${sendJson?.msgid || "n/a"})`);
    return sendJson;
  });
}

// 发送文本消息（支持自动分段）
async function sendWecomText({ corpId, corpSecret, agentId, toUser, text, logger }) {
  const chunks = splitWecomText(text);

  logger?.info?.(`wecom: splitting message into ${chunks.length} chunks, total bytes=${getByteLength(text)}`);

  for (let i = 0; i < chunks.length; i++) {
    logger?.info?.(`wecom: sending chunk ${i + 1}/${chunks.length}, bytes=${getByteLength(chunks[i])}`);
    await sendWecomTextSingle({ corpId, corpSecret, agentId, toUser, text: chunks[i], logger });
    // 分段发送时添加间隔，避免触发限流
    if (i < chunks.length - 1) {
      await sleep(300);
    }
  }
}

// 上传临时素材到企业微信
async function uploadWecomMedia({ corpId, corpSecret, type, buffer, filename }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret });
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

  const res = await fetchWithRetry(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const json = await res.json();
  if (json.errcode !== 0) {
    throw new Error(`WeCom media upload failed: ${JSON.stringify(json)}`);
  }

  return json.media_id;
}

// 发送图片消息（带限流）
async function sendWecomImage({ corpId, corpSecret, agentId, toUser, mediaId }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

    const body = {
      touser: toUser,
      msgtype: "image",
      agentid: agentId,
      image: { media_id: mediaId },
      safe: 0,
    };

    const sendRes = await fetchWithRetry(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom image send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送视频消息（带限流）
async function sendWecomVideo({ corpId, corpSecret, agentId, toUser, mediaId, title, description }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
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
    const sendRes = await fetchWithRetry(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom video send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 发送文件消息（带限流）
async function sendWecomFile({ corpId, corpSecret, agentId, toUser, mediaId }) {
  return apiLimiter.execute(async () => {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret });
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "file",
      agentid: agentId,
      file: { media_id: mediaId },
      safe: 0,
    };
    const sendRes = await fetchWithRetry(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode !== 0) {
      throw new Error(`WeCom file send failed: ${JSON.stringify(sendJson)}`);
    }
    return sendJson;
  });
}

// 从 URL 下载媒体文件
async function fetchMediaFromUrl(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch media from URL: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
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
      await sendWecomText({ corpId: config.corpId, corpSecret: config.corpSecret, agentId: config.agentId, toUser: to, text });
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
      const { corpId, corpSecret, agentId } = config;
      // to 格式为 "wecom:userid"，需要提取 userid
      const userId = to.startsWith("wecom:") ? to.slice(6) : to;

      // 如果有媒体附件，先发送媒体
      if (mediaUrl && mediaType === "image") {
        try {
          const { buffer } = await fetchMediaFromUrl(mediaUrl);
          const mediaId = await uploadWecomMedia({
            corpId, corpSecret,
            type: "image",
            buffer,
            filename: "image.jpg",
          });
          await sendWecomImage({ corpId, corpSecret, agentId, toUser: userId, mediaId });
        } catch (mediaErr) {
          // 媒体发送失败不阻止文本发送，只记录警告
          gatewayRuntime?.logger?.warn?.(`wecom: failed to send media: ${mediaErr.message}`);
        }
      }

      // 发送文本消息
      if (text) {
        await sendWecomText({ corpId, corpSecret, agentId, toUser: userId, text });
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

export default function register(api) {
  // 保存 runtime 引用
  gatewayRuntime = api.runtime;

  // 初始化配置
  const cfg = getWecomConfig(api);
  if (cfg) {
    api.logger.info?.(`wecom: config loaded (corpId=${cfg.corpId?.slice(0, 8)}...)`);
  } else {
    api.logger.warn?.("wecom: no configuration found (check channels.wecom in openclaw.json)");
  }

  api.registerChannel({ plugin: WecomChannelPlugin });

  const webhookGroups = groupAccountsByWebhookPath(api);
  if (webhookGroups.size === 0) {
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

          // 检测是否为群聊消息
          const chatId = msgObj.ChatId || null;
          const isGroupChat = !!chatId;
          const fromUser = msgObj.FromUserName;
          const msgType = msgObj.MsgType;
          const msgId = String(msgObj.MsgId ?? "").trim();

          api.logger.info?.(
            `wecom inbound: account=${matchedAccount.accountId} from=${msgObj?.FromUserName} msgType=${msgType} chatId=${chatId || "N/A"} content=${(msgObj?.Content ?? "").slice?.(0, 80)}`,
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

          // 异步处理消息，不阻塞响应
          if (msgType === "text" && msgObj?.Content) {
            messageProcessLimiter.execute(() =>
              processInboundMessage({ ...basePayload, content: msgObj.Content, msgType: "text" })
            ).catch((err) => {
              api.logger.error?.(`wecom: async text processing failed: ${err.message}`);
            });
          } else if (msgType === "image" && msgObj?.MediaId) {
            messageProcessLimiter.execute(() =>
              processInboundMessage({
                ...basePayload,
                mediaId: msgObj.MediaId,
                msgType: "image",
                picUrl: msgObj.PicUrl,
              })
            ).catch((err) => {
              api.logger.error?.(`wecom: async image processing failed: ${err.message}`);
            });
          } else if (msgType === "voice" && msgObj?.MediaId) {
            messageProcessLimiter.execute(() =>
              processInboundMessage({
                ...basePayload,
                mediaId: msgObj.MediaId,
                msgType: "voice",
                recognition: msgObj.Recognition,
              })
            ).catch((err) => {
              api.logger.error?.(`wecom: async voice processing failed: ${err.message}`);
            });
          } else if (msgType === "video" && msgObj?.MediaId) {
            messageProcessLimiter.execute(() =>
              processInboundMessage({
                ...basePayload,
                mediaId: msgObj.MediaId,
                msgType: "video",
                thumbMediaId: msgObj.ThumbMediaId,
              })
            ).catch((err) => {
              api.logger.error?.(`wecom: async video processing failed: ${err.message}`);
            });
          } else if (msgType === "file" && msgObj?.MediaId) {
            messageProcessLimiter.execute(() =>
              processInboundMessage({
                ...basePayload,
                mediaId: msgObj.MediaId,
                msgType: "file",
                fileName: msgObj.FileName,
                fileSize: msgObj.FileSize,
              })
            ).catch((err) => {
              api.logger.error?.(`wecom: async file processing failed: ${err.message}`);
            });
          } else if (msgType === "link") {
            messageProcessLimiter.execute(() =>
              processInboundMessage({
                ...basePayload,
                msgType: "link",
                linkTitle: msgObj.Title,
                linkDescription: msgObj.Description,
                linkUrl: msgObj.Url,
                linkPicUrl: msgObj.PicUrl,
              })
            ).catch((err) => {
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
async function downloadWecomMedia({ corpId, corpSecret, mediaId }) {
  const accessToken = await getWecomAccessToken({ corpId, corpSecret });
  const mediaUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetchWithRetry(mediaUrl);
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
async function handleHelpCommand({ api, fromUser, corpId, corpSecret, agentId }) {
  const helpText = `🤖 AI 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 重置会话（等价于 /reset）
/status - 查看系统状态

直接发送消息即可与 AI 对话。
支持发送图片，AI 会分析图片内容。`;

  await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: helpText });
  return true;
}

async function handleStatusCommand({ api, fromUser, corpId, corpSecret, agentId, accountId }) {
  const config = getWecomConfig(api, accountId);
  const accountIds = listWecomAccountIds(api);

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
✅ 多账户支持`;

  await sendWecomText({ corpId, corpSecret, agentId, toUser: fromUser, text: statusText });
  return true;
}

const COMMANDS = {
  "/help": handleHelpCommand,
  "/status": handleStatusCommand,
};

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

  const { corpId, corpSecret, agentId } = config;

  try {
    // 一用户一会话：群聊和私聊统一归并到 wecom:<userid>
    const sessionId = buildWecomSessionId(fromUser);
    const fromAddress = `wecom:${fromUser}`;
    const originalContent = content || "";
    let commandBody = originalContent;
    api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`);

    // 命令检测（仅对文本消息）
    if (msgType === "text" && commandBody.startsWith("/")) {
      const commandKey = commandBody.split(/\s+/)[0].toLowerCase();
      if (commandKey === "/clear") {
        api.logger.info?.("wecom: translating /clear to native /reset command");
        commandBody = "/reset";
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
          chatId,
          isGroupChat,
        });
        return; // 命令已处理，不再调用 AI
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
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
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

      // 企业微信开启语音识别后，Recognition 字段会包含转写结果
      if (recognition) {
        api.logger.info?.(`wecom: voice recognition result: ${recognition.slice(0, 50)}...`);
        messageText = `[语音消息] ${recognition}`;
      } else {
        // 没有开启语音识别，提示用户
        messageText = "[用户发送了一条语音消息]\n\n请告诉用户目前暂不支持语音消息，建议发送文字消息。";
      }
    }

    // 处理视频消息
    if (msgType === "video" && mediaId) {
      api.logger.info?.(`wecom: received video message mediaId=${mediaId}`);
      try {
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
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
        const { buffer, contentType } = await downloadWecomMedia({ corpId, corpSecret, mediaId });
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
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      sessionKey: sessionId,
      channel: "wecom",
      accountId: config.accountId || "default",
    });

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
    let hasSentProgressNotice = false;
    let blockTextFallback = "";
    let progressNoticeTimer = null;
    const replyTimeoutMs = Math.max(15000, asNumber(requireEnv("WECOM_REPLY_TIMEOUT_MS"), 90000));
    const progressNoticeDelayMs = Math.max(0, asNumber(requireEnv("WECOM_PROGRESS_NOTICE_MS"), 8000));
    const processingNoticeText = "消息已收到，正在处理中，请稍等片刻。";
    const queuedNoticeText = "上一条消息仍在处理中，你的新消息已加入队列，请稍等片刻。";
    const sendProgressNotice = async (text = processingNoticeText) => {
      if (hasDeliveredReply || hasSentProgressNotice) return;
      hasSentProgressNotice = true;
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text,
        logger: api.logger,
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
      });
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
              if (hasDeliveredReply) {
                api.logger.info?.("wecom: ignoring late reply because a reply was already delivered");
                return;
              }
              if (info.kind === "block") {
                if (payload.text) {
                  if (blockTextFallback) blockTextFallback += "\n";
                  blockTextFallback += payload.text;
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
                // 应用 Markdown 转换
                const formattedReply = markdownToWecomText(payload.text);
                await sendWecomText({
                  corpId,
                  corpSecret,
                  agentId,
                  toUser: fromUser,
                  text: formattedReply,
                  logger: api.logger,
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
                });
                hasDeliveredReply = true;
              }
            },
            onError: async (err, info) => {
              api.logger.error?.(`wecom: ${info.kind} reply failed: ${String(err)}`);
              try {
                await sendFailureFallback(err);
              } catch (fallbackErr) {
                api.logger.error?.(`wecom: failed to send fallback reply: ${fallbackErr.message}`);
              }
            },
          },
          replyOptions: {
            // 禁用流式响应，因为企业微信不支持编辑消息
            disableBlockStreaming: true,
          },
        }),
        replyTimeoutMs,
        `dispatch timed out after ${replyTimeoutMs}ms`,
      );

      if (!hasDeliveredReply) {
        const blockText = String(blockTextFallback || "").trim();
        if (blockText) {
          await sendWecomText({
            corpId,
            corpSecret,
            agentId,
            toUser: fromUser,
            text: markdownToWecomText(blockText),
            logger: api.logger,
          });
          hasDeliveredReply = true;
          api.logger.info?.("wecom: delivered accumulated block reply as final fallback");
        }
      }

      if (!hasDeliveredReply) {
        const counts = dispatchResult?.counts ?? {};
        const queuedFinal = dispatchResult?.queuedFinal === true;
        const deliveredCount = Number(counts.final ?? 0) + Number(counts.block ?? 0) + Number(counts.tool ?? 0);
        if (!queuedFinal && deliveredCount === 0) {
          // 常见于同一会话已有活跃 run：当前消息被排队，暂无可立即发送的最终回复
          api.logger.warn?.("wecom: no immediate deliverable reply (likely queued behind active run)");
          await sendProgressNotice(queuedNoticeText);
        } else {
          // 进入这里说明 dispatcher 有输出或已排队，但当前回调还没有拿到可立即下发的 final。
          // 发送处理中提示，避免用户感知为“无响应”。
          api.logger.warn?.(
            "wecom: dispatch finished without direct final delivery; sending processing notice",
          );
          await sendProgressNotice(processingNoticeText);
        }
      }
    } catch (dispatchErr) {
      api.logger.warn?.(`wecom: dispatch failed: ${String(dispatchErr)}`);
      await sendFailureFallback(dispatchErr);
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
