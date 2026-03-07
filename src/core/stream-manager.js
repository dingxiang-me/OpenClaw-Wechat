const DEFAULT_STREAM_MAX_BYTES = 20480;
const DEFAULT_STREAM_EXPIRE_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_STREAM_MSG_ITEM_LIMIT = 10;

function normalizeStreamText(text) {
  return String(text ?? "");
}

function normalizeThinkingContent(text, maxBytes = DEFAULT_STREAM_MAX_BYTES) {
  return enforceUtf8ByteLimit(String(text ?? ""), maxBytes);
}

function enforceUtf8ByteLimit(text, maxBytes = DEFAULT_STREAM_MAX_BYTES) {
  const normalized = normalizeStreamText(text);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return normalized;
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes <= maxBytes) return normalized;
  return Buffer.from(normalized, "utf8").subarray(0, maxBytes).toString("utf8");
}

function normalizeSessionKey(sessionKey) {
  const normalized = String(sessionKey ?? "").trim();
  return normalized || "unknown";
}

function normalizeMediaType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "image") return "image";
  if (normalized === "video") return "video";
  if (normalized === "voice" || normalized === "audio") return "voice";
  if (normalized === "file") return "file";
  return normalized;
}

function normalizeStreamMsgItems(msgItems, maxItems = DEFAULT_STREAM_MSG_ITEM_LIMIT) {
  if (!Array.isArray(msgItems) || msgItems.length === 0) return [];
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : DEFAULT_STREAM_MSG_ITEM_LIMIT;
  const normalized = [];
  for (const rawItem of msgItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const msgType = String(rawItem.msgtype ?? "").trim().toLowerCase();
    if (msgType !== "image") continue;
    const base64 = String(rawItem?.image?.base64 ?? "").trim();
    const md5 = String(rawItem?.image?.md5 ?? "").trim().toLowerCase();
    if (!base64) continue;
    if (!/^[a-f0-9]{32}$/.test(md5)) continue;
    normalized.push({
      msgtype: "image",
      image: { base64, md5 },
    });
    if (normalized.length >= limit) break;
  }
  return normalized;
}

export class WecomStreamManager {
  constructor({ expireMs = DEFAULT_STREAM_EXPIRE_MS, maxBytes = DEFAULT_STREAM_MAX_BYTES } = {}) {
    this.expireMs = Number.isFinite(expireMs) && expireMs > 0 ? Math.floor(expireMs) : DEFAULT_STREAM_EXPIRE_MS;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_STREAM_MAX_BYTES;
    this.streams = new Map();
    this.cleanupTimer = null;
  }

  setExpireMs(expireMs) {
    if (Number.isFinite(expireMs) && expireMs > 0) {
      this.expireMs = Math.floor(expireMs);
    }
  }

  create(streamId, initialContent = "", { feedbackId = "" } = {}) {
    const id = String(streamId ?? "").trim();
    if (!id) return null;
    const now = Date.now();
    const content = enforceUtf8ByteLimit(initialContent, this.maxBytes);
    const stream = {
      id,
      content,
      thinkingContent: "",
      finished: false,
      feedbackId: String(feedbackId ?? "").trim() || null,
      msgItem: [],
      queuedMedia: [],
      createdAt: now,
      updatedAt: now,
    };
    this.streams.set(id, stream);
    return stream;
  }

  queueMedia(streamId, mediaUrl, { mediaType = "" } = {}) {
    const id = String(streamId ?? "").trim();
    const url = String(mediaUrl ?? "").trim();
    if (!id || !url) return false;
    const existing = this.streams.get(id);
    if (!existing) return false;

    const normalizedType = normalizeMediaType(mediaType);
    const queued = Array.isArray(existing.queuedMedia) ? existing.queuedMedia : [];
    const deduped = queued.filter((item) => String(item?.url ?? "").trim() !== url);
    deduped.push({
      url,
      mediaType: normalizedType || undefined,
      queuedAt: Date.now(),
    });
    existing.queuedMedia = deduped;
    existing.updatedAt = Date.now();
    this.streams.set(id, existing);
    return true;
  }

  drainQueuedMedia(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) return [];
    const existing = this.streams.get(id);
    if (!existing) return [];
    const queued = Array.isArray(existing.queuedMedia) ? existing.queuedMedia.slice() : [];
    existing.queuedMedia = [];
    existing.updatedAt = Date.now();
    this.streams.set(id, existing);
    return queued;
  }

  update(streamId, content, { append = false, finished = false, msgItem, thinkingContent } = {}) {
    const id = String(streamId ?? "").trim();
    if (!id) return null;
    const existing = this.streams.get(id);
    if (!existing) return null;
    const incoming = normalizeStreamText(content);
    const nextContent = append ? `${existing.content}${incoming}` : incoming;
    existing.content = enforceUtf8ByteLimit(nextContent, this.maxBytes);
    existing.finished = finished ? true : existing.finished;
    if (Array.isArray(msgItem)) {
      existing.msgItem = normalizeStreamMsgItems(msgItem);
    }
    if (thinkingContent !== undefined) {
      existing.thinkingContent = normalizeThinkingContent(thinkingContent, this.maxBytes);
    }
    existing.updatedAt = Date.now();
    this.streams.set(id, existing);
    return existing;
  }

  finish(streamId, content = null, { msgItem, thinkingContent } = {}) {
    const id = String(streamId ?? "").trim();
    if (!id) return null;
    const existing = this.streams.get(id);
    if (!existing) return null;
    if (content != null) {
      existing.content = enforceUtf8ByteLimit(content, this.maxBytes);
    }
    if (Array.isArray(msgItem)) {
      existing.msgItem = normalizeStreamMsgItems(msgItem);
    }
    if (thinkingContent !== undefined) {
      existing.thinkingContent = normalizeThinkingContent(thinkingContent, this.maxBytes);
    }
    existing.queuedMedia = [];
    existing.finished = true;
    existing.updatedAt = Date.now();
    this.streams.set(id, existing);
    return existing;
  }

  get(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) return null;
    return this.streams.get(id) ?? null;
  }

  has(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) return false;
    return this.streams.has(id);
  }

  delete(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) return false;
    return this.streams.delete(id);
  }

  cleanup(expireMs = this.expireMs) {
    const expire = Number.isFinite(expireMs) && expireMs > 0 ? Math.floor(expireMs) : this.expireMs;
    const now = Date.now();
    let removed = 0;
    for (const [streamId, stream] of this.streams.entries()) {
      const ageMs = now - Number(stream?.updatedAt ?? now);
      if (ageMs > expire) {
        this.streams.delete(streamId);
        removed += 1;
      }
    }
    return removed;
  }

  startCleanup({ expireMs, intervalMs = DEFAULT_CLEANUP_INTERVAL_MS, logger } = {}) {
    this.setExpireMs(expireMs);
    if (this.cleanupTimer) return;
    const interval = Number.isFinite(intervalMs) && intervalMs >= 1000 ? Math.floor(intervalMs) : DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        logger?.debug?.(`wecom(stream): cleaned ${removed} expired streams`);
      }
    }, interval);
    this.cleanupTimer.unref?.();
    logger?.info?.(`wecom(stream): cleanup timer started (expireMs=${this.expireMs})`);
  }

  stopCleanup() {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  getStats() {
    return {
      total: this.streams.size,
      expireMs: this.expireMs,
      maxBytes: this.maxBytes,
    };
  }
}

export class WecomSessionTaskQueue {
  constructor({ maxConcurrentPerSession = 1 } = {}) {
    this.maxConcurrentPerSession = Math.max(1, Number(maxConcurrentPerSession) || 1);
    this.states = new Map();
  }

  setMaxConcurrentPerSession(value) {
    const next = Math.max(1, Number(value) || 1);
    this.maxConcurrentPerSession = next;
  }

  getDepth(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    const state = this.states.get(key);
    if (!state) return 0;
    return state.running + state.pending.length;
  }

  enqueue(sessionKey, task) {
    const key = normalizeSessionKey(sessionKey);
    if (typeof task !== "function") {
      return Promise.reject(new Error("task must be a function"));
    }
    let state = this.states.get(key);
    if (!state) {
      state = { running: 0, pending: [] };
      this.states.set(key, state);
    }
    return new Promise((resolve, reject) => {
      state.pending.push({ task, resolve, reject });
      this._drain(key);
    });
  }

  _drain(sessionKey) {
    const state = this.states.get(sessionKey);
    if (!state) return;
    while (state.running < this.maxConcurrentPerSession && state.pending.length > 0) {
      const next = state.pending.shift();
      state.running += 1;
      Promise.resolve()
        .then(() => next.task())
        .then((result) => {
          next.resolve(result);
        })
        .catch((err) => {
          next.reject(err);
        })
        .finally(() => {
          const current = this.states.get(sessionKey);
          if (!current) return;
          current.running = Math.max(0, current.running - 1);
          if (current.running === 0 && current.pending.length === 0) {
            this.states.delete(sessionKey);
          } else {
            this._drain(sessionKey);
          }
        });
    }
  }
}
