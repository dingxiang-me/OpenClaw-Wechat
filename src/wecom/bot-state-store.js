import { WecomStreamManager } from "../core/stream-manager.js";

const DEFAULT_BOT_STREAM_EXPIRE_MS = 10 * 60 * 1000;
const DEFAULT_BOT_RESPONSE_URL_TTL_MS = 60 * 60 * 1000;

function normalizeSessionId(sessionId) {
  return String(sessionId ?? "").trim().toLowerCase();
}

export function createWecomBotStateStore({
  streamExpireMs = DEFAULT_BOT_STREAM_EXPIRE_MS,
  responseUrlTtlMs = DEFAULT_BOT_RESPONSE_URL_TTL_MS,
} = {}) {
  const streamManager = new WecomStreamManager({ expireMs: streamExpireMs });
  const responseUrlCache = new Map();
  const activeStreams = new Map();
  const activeStreamHistory = new Map();
  const streamToSession = new Map();

  function registerActiveStream(sessionId, streamId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedSessionId || !normalizedStreamId) return;

    const history = activeStreamHistory.get(normalizedSessionId) ?? [];
    const deduped = history.filter((id) => id !== normalizedStreamId);
    deduped.push(normalizedStreamId);
    activeStreamHistory.set(normalizedSessionId, deduped);
    activeStreams.set(normalizedSessionId, normalizedStreamId);
    streamToSession.set(normalizedStreamId, normalizedSessionId);
  }

  function unregisterActiveStream(sessionId, streamId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedSessionId || !normalizedStreamId) return;

    const history = activeStreamHistory.get(normalizedSessionId) ?? [];
    const remaining = history.filter((id) => id !== normalizedStreamId);
    if (remaining.length > 0) {
      activeStreamHistory.set(normalizedSessionId, remaining);
      activeStreams.set(normalizedSessionId, remaining[remaining.length - 1]);
    } else {
      activeStreamHistory.delete(normalizedSessionId);
      activeStreams.delete(normalizedSessionId);
    }
    streamToSession.delete(normalizedStreamId);
  }

  function hasStream(streamId) {
    return streamManager.has(streamId);
  }

  function resolveActiveStream(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return "";

    const history = activeStreamHistory.get(normalizedSessionId) ?? [];
    if (history.length === 0) {
      activeStreams.delete(normalizedSessionId);
      return "";
    }

    const remaining = history.filter((id) => hasStream(id));
    if (remaining.length === 0) {
      activeStreamHistory.delete(normalizedSessionId);
      activeStreams.delete(normalizedSessionId);
      return "";
    }

    activeStreamHistory.set(normalizedSessionId, remaining);
    const latest = remaining[remaining.length - 1];
    activeStreams.set(normalizedSessionId, latest);
    return latest;
  }

  function createStream(streamId, initialContent = "", options = {}) {
    const stream = streamManager.create(streamId, initialContent, options);
    const normalizedStreamId = String(streamId ?? "").trim();
    const normalizedSessionId = normalizeSessionId(options?.sessionId);
    if (stream && normalizedStreamId && normalizedSessionId) {
      registerActiveStream(normalizedSessionId, normalizedStreamId);
    }
    return stream;
  }

  function updateStream(streamId, content, { append = false, finished = false, msgItem, thinkingContent } = {}) {
    return streamManager.update(streamId, content, { append, finished, msgItem, thinkingContent });
  }

  function finishStream(streamId, content, { msgItem, thinkingContent } = {}) {
    const normalizedStreamId = String(streamId ?? "").trim();
    const stream = streamManager.finish(normalizedStreamId, content, { msgItem, thinkingContent });
    if (stream) {
      const sessionId = streamToSession.get(normalizedStreamId);
      if (sessionId) unregisterActiveStream(sessionId, normalizedStreamId);
    }
    return stream;
  }

  function queueStreamMedia(streamId, mediaUrl, { mediaType } = {}) {
    return streamManager.queueMedia(streamId, mediaUrl, { mediaType });
  }

  function drainStreamMedia(streamId) {
    return streamManager.drainQueuedMedia(streamId);
  }

  function getStream(streamId) {
    return streamManager.get(streamId);
  }

  function upsertResponseUrlCache({ sessionId, responseUrl }) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    const normalizedUrl = String(responseUrl ?? "").trim();
    if (!normalizedSessionId || !normalizedUrl) return;
    responseUrlCache.set(normalizedSessionId, {
      url: normalizedUrl,
      used: false,
      expiresAt: Date.now() + responseUrlTtlMs,
      updatedAt: Date.now(),
    });
  }

  function getResponseUrlCache(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) return null;
    const cached = responseUrlCache.get(normalizedSessionId);
    if (!cached) return null;
    if (Number(cached.expiresAt || 0) <= Date.now()) {
      responseUrlCache.delete(normalizedSessionId);
      return null;
    }
    return cached;
  }

  function markResponseUrlUsed(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) return;
    const cached = responseUrlCache.get(normalizedSessionId);
    if (!cached) return;
    cached.used = true;
    cached.updatedAt = Date.now();
    responseUrlCache.set(normalizedSessionId, cached);
  }

  function cleanupResponseUrlCache(ttlMs = responseUrlTtlMs) {
    const now = Date.now();
    for (const [sessionId, cached] of responseUrlCache.entries()) {
      const expiresAt = Number(cached?.expiresAt ?? now + ttlMs);
      if (expiresAt <= now) {
        responseUrlCache.delete(sessionId);
      }
    }
  }

  function cleanupExpired(expireMs = streamExpireMs) {
    streamManager.cleanup(expireMs);
    cleanupResponseUrlCache();
  }

  function setExpireMs(expireMs) {
    streamManager.setExpireMs(expireMs);
  }

  function startCleanup(expireMs, logger) {
    streamManager.startCleanup({ expireMs, logger });
  }

  return {
    setExpireMs,
    resolveActiveStream,
    createStream,
    updateStream,
    finishStream,
    queueStreamMedia,
    drainStreamMedia,
    getStream,
    hasStream,
    upsertResponseUrlCache,
    getResponseUrlCache,
    markResponseUrlUsed,
    cleanupExpired,
    startCleanup,
  };
}
