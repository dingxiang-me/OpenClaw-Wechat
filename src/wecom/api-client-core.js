export function createWecomApiClientCore({
  fetchImpl = fetch,
  proxyAgentCtor,
  sleep,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createWecomApiClientCore: fetchImpl is required");
  if (typeof proxyAgentCtor !== "function") throw new Error("createWecomApiClientCore: proxyAgentCtor is required");
  if (typeof sleep !== "function") throw new Error("createWecomApiClientCore: sleep is required");

  const accessTokenCaches = new Map();
  const proxyDispatcherCache = new Map();
  const invalidProxyCache = new Set();
  const DEFAULT_WECOM_API_BASE_URL = "https://qyapi.weixin.qq.com";

  function resolveWecomApiBaseUrl(apiProxy) {
    const raw = String(apiProxy ?? "").trim();
    if (!raw) return DEFAULT_WECOM_API_BASE_URL;
    try {
      const parsed = new URL(raw);
      if (!/^https?:$/i.test(parsed.protocol)) return DEFAULT_WECOM_API_BASE_URL;
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return DEFAULT_WECOM_API_BASE_URL;
    }
  }

  function buildWecomApiUrl(pathnameWithQuery, apiProxy) {
    const normalizedPath = String(pathnameWithQuery ?? "");
    if (!normalizedPath) return resolveWecomApiBaseUrl(apiProxy);
    return `${resolveWecomApiBaseUrl(apiProxy)}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
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
    if (proxyDispatcherCache.has(normalized)) {
      return proxyDispatcherCache.get(normalized);
    }
    if (!isLikelyHttpProxyUrl(normalized)) {
      if (!invalidProxyCache.has(normalized)) {
        invalidProxyCache.add(normalized);
        logger?.warn?.(`wecom: outboundProxy ignored (invalid url): ${printableProxy}`);
      }
      return null;
    }
    try {
      const dispatcher = new proxyAgentCtor(normalized);
      proxyDispatcherCache.set(normalized, dispatcher);
      logger?.info?.(`wecom: outbound proxy enabled (${printableProxy})`);
      return dispatcher;
    } catch (err) {
      if (!invalidProxyCache.has(normalized)) {
        invalidProxyCache.add(normalized);
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

  async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 1000, requestContext = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const requestOptions = attachWecomProxyDispatcher(url, options, requestContext);
        const res = await fetchImpl(url, requestOptions);

        if (!res.ok && attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = await res.clone().json();
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

  async function getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger }) {
    const cacheKey = `${corpId}:${corpSecret}`;
    let cache = accessTokenCaches.get(cacheKey);

    if (!cache) {
      cache = { token: null, expiresAt: 0, refreshPromise: null };
      accessTokenCaches.set(cacheKey, cache);
    }

    const now = Date.now();
    if (cache.token && cache.expiresAt > now + 60000) {
      return cache.token;
    }

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

  function buildWecomMessageSendRequest({
    accessToken,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    msgType,
    payload,
    apiProxy,
  }) {
    const isAppChat = Boolean(chatId);
    if (!isAppChat && !toUser && !toParty && !toTag) {
      throw new Error("missing WeCom target: need toUser/toParty/toTag/chatId");
    }
    if (isAppChat) {
      return {
        sendUrl: buildWecomApiUrl(
          `/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`,
          apiProxy,
        ),
        body: {
          chatid: chatId,
          msgtype: msgType,
          ...payload,
          safe: 0,
        },
        isAppChat,
      };
    }
    return {
      sendUrl: buildWecomApiUrl(
        `/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
        apiProxy,
      ),
      body: {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype: msgType,
        agentid: agentId,
        ...payload,
        safe: 0,
      },
      isAppChat,
    };
  }

  return {
    attachWecomProxyDispatcher,
    fetchWithRetry,
    getWecomAccessToken,
    buildWecomMessageSendRequest,
  };
}
