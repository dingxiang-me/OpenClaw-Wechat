import crypto from "node:crypto";

export const WECOM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeMode(mode) {
  return String(mode ?? "").trim().toLowerCase() === "bot" ? "bot" : "agent";
}

function normalizeAccountId(accountId) {
  return String(accountId ?? "default").trim().toLowerCase() || "default";
}

function normalizeSessionId(sessionId) {
  return String(sessionId ?? "").trim();
}

function normalizeUserId(fromUser) {
  return String(fromUser ?? "").trim();
}

function buildSessionStoreKey({ mode, accountId, sessionId } = {}) {
  return `${normalizeMode(mode)}:${normalizeAccountId(accountId)}:${normalizeSessionId(sessionId)}`;
}

function buildPendingEntryId(prefix = "pending") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNow(nowFn) {
  try {
    return Number(nowFn?.() || Date.now());
  } catch {
    return Date.now();
  }
}

function trimText(value, maxLength = 240) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizePayloadForPending(payload = {}) {
  const mediaUrls = toArray(payload.mediaUrls)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return {
    text: String(payload.text ?? "").trim(),
    thinkingContent: String(payload.thinkingContent ?? "").trim(),
    mediaUrls,
    mediaType: String(payload.mediaType ?? "").trim().toLowerCase() || undefined,
  };
}

function buildPendingDedupeKey({
  mode,
  accountId,
  sessionId,
  fromUser,
  payload,
} = {}) {
  const normalizedPayload = normalizePayloadForPending(payload);
  const raw = JSON.stringify({
    mode: normalizeMode(mode),
    accountId: normalizeAccountId(accountId),
    sessionId: normalizeSessionId(sessionId),
    fromUser: normalizeUserId(fromUser).toLowerCase(),
    payload: normalizedPayload,
  });
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function normalizeWecomDeliveryStatus(value, fallback = "rejected_unknown") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "delivered" ||
    normalized === "rejected_window" ||
    normalized === "rejected_quota" ||
    normalized === "rejected_transport" ||
    normalized === "rejected_target" ||
    normalized === "rejected_unknown"
  ) {
    return normalized;
  }
  return fallback;
}

export function inferWecomDeliveryStatus({ reason = "", layer = "", meta = {}, errcode = null } = {}) {
  const normalizedReason = String(reason ?? "").trim().toLowerCase();
  const normalizedLayer = String(layer ?? "").trim().toLowerCase();
  const normalizedErrcode =
    typeof errcode === "number" && Number.isFinite(errcode) ? errcode : Number.parseInt(String(errcode ?? ""), 10);
  const extra = `${normalizedReason} ${String(meta?.errmsg ?? "").trim().toLowerCase()}`.trim();

  if (
    includesAny(extra, [
      "24h",
      "24 h",
      "24-hour",
      "24 hour",
      "24小时",
      "24 小时",
      "reply window",
      "window expired",
      "outside response window",
    ])
  ) {
    return "rejected_window";
  }

  if (
    includesAny(extra, [
      "quota",
      "rate limit",
      "out of limit",
      "limit reached",
      "limit exceeded",
      "额度",
      "频次",
      "超过上限",
      "超出上限",
    ])
  ) {
    return "rejected_quota";
  }

  if (
    normalizedErrcode === 45009 ||
    normalizedErrcode === 45011 ||
    normalizedErrcode === 45047 ||
    normalizedErrcode === 50002
  ) {
    return "rejected_quota";
  }

  if (
    includesAny(extra, [
      "agent-config-missing",
      "response-url-missing",
      "response-url-used",
      "webhook-bot-url-missing",
      "missing response_url",
      "missing webhook bot url",
      "invalid webhook bot url",
      "stream-missing",
      "url-missing",
      "used",
      "no-handler",
      "config-missing",
      "target invalid",
      "invalid signature",
    ]) ||
    (normalizedLayer === "response_url" && includesAny(extra, ["rejected", "missing", "used"]))
  ) {
    return "rejected_target";
  }

  if (
    includesAny(extra, [
      "fetch failed",
      "network",
      "socket",
      "timeout",
      "timed out",
      "proxy",
      "connection reset",
      "connection refused",
      "econn",
      "enotfound",
      "eai_again",
      "503",
      "502",
      "504",
      "closed",
      "aborted",
    ])
  ) {
    return "rejected_transport";
  }

  return "rejected_unknown";
}

export function resolveWecomReplyWindowState(lastInboundAt, { now = Date.now(), replyWindowMs = WECOM_REPLY_WINDOW_MS } = {}) {
  const at = Number(lastInboundAt);
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  return now - at <= replyWindowMs ? "reply_window_open" : "reply_window_expired";
}

export function formatWecomReplyWindowState(state) {
  if (state === "reply_window_open") return "open";
  if (state === "reply_window_expired") return "expired";
  return "unknown";
}

export function formatWecomQuotaState(state) {
  if (state === "proactive_quota_available") return "available";
  if (state === "proactive_quota_exhausted") return "exhausted";
  return "unknown";
}

export function createWecomReliableDeliveryStore({
  now = () => Date.now(),
  replyWindowMs = WECOM_REPLY_WINDOW_MS,
  maxPendingEntries = 200,
} = {}) {
  const sessionState = new Map();
  const accountState = new Map();
  const pendingEntries = new Map();

  function ensureAccount(accountId = "default") {
    const normalizedAccountId = normalizeAccountId(accountId);
    const existing = accountState.get(normalizedAccountId);
    if (existing) return existing;
    const created = {
      accountId: normalizedAccountId,
      lastInboundAt: 0,
      lastDeliveryAt: 0,
      lastDeliveryStatus: "unknown",
      lastFailureReason: "",
      lastDeliveryLayer: "",
      proactiveQuotaState: "unknown",
      lastQuotaFailureAt: 0,
      lastProactiveSuccessAt: 0,
      pendingCount: 0,
      lastPendingReason: "",
      lastPendingAt: 0,
      lastPendingResolvedAt: 0,
    };
    accountState.set(normalizedAccountId, created);
    return created;
  }

  function ensureSession({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
  } = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = buildSessionStoreKey({ mode, accountId, sessionId: normalizedSessionId });
    const existing = sessionState.get(key);
    if (existing) {
      if (fromUser) existing.fromUser = normalizeUserId(fromUser);
      return existing;
    }
    const created = {
      key,
      mode: normalizeMode(mode),
      accountId: normalizeAccountId(accountId),
      sessionId: normalizedSessionId,
      fromUser: normalizeUserId(fromUser),
      lastInboundAt: 0,
      lastDeliveryAt: 0,
      lastDeliveryStatus: "unknown",
      lastFailureReason: "",
      lastDeliveryLayer: "",
      pendingCount: 0,
      lastPendingReason: "",
      lastPendingAt: 0,
      lastPendingResolvedAt: 0,
    };
    sessionState.set(key, created);
    return created;
  }

  function syncPendingCount(entry, delta) {
    const nextDelta = Number(delta) || 0;
    if (!nextDelta) return;
    const session = ensureSession(entry);
    const account = ensureAccount(entry.accountId);
    session.pendingCount = Math.max(0, Number(session.pendingCount || 0) + nextDelta);
    account.pendingCount = Math.max(0, Number(account.pendingCount || 0) + nextDelta);
  }

  function markInboundActivity({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
    at = safeNow(now),
  } = {}) {
    const occurredAt = Number(at) || safeNow(now);
    const session = ensureSession({ mode, accountId, sessionId, fromUser });
    const account = ensureAccount(accountId);
    session.lastInboundAt = Math.max(Number(session.lastInboundAt || 0), occurredAt);
    account.lastInboundAt = Math.max(Number(account.lastInboundAt || 0), occurredAt);
    return getDeliverySnapshot({ mode, accountId, sessionId });
  }

  function recordDeliveryOutcome({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
    deliveryStatus = "rejected_unknown",
    layer = "",
    reason = "",
    at = safeNow(now),
  } = {}) {
    const occurredAt = Number(at) || safeNow(now);
    const session = ensureSession({ mode, accountId, sessionId, fromUser });
    const account = ensureAccount(accountId);
    const normalizedStatus = normalizeWecomDeliveryStatus(deliveryStatus);
    const normalizedReason = trimText(reason);
    const windowState = resolveWecomReplyWindowState(session.lastInboundAt, {
      now: occurredAt,
      replyWindowMs,
    });

    session.lastDeliveryAt = occurredAt;
    session.lastDeliveryStatus = normalizedStatus;
    session.lastFailureReason = normalizedStatus === "delivered" ? "" : normalizedReason;
    session.lastDeliveryLayer = String(layer ?? "").trim().toLowerCase();

    account.lastDeliveryAt = occurredAt;
    account.lastDeliveryStatus = normalizedStatus;
    account.lastFailureReason = normalizedStatus === "delivered" ? "" : normalizedReason;
    account.lastDeliveryLayer = String(layer ?? "").trim().toLowerCase();

    if (normalizedStatus === "rejected_window") {
      session.lastInboundAt = session.lastInboundAt || 0;
    }
    if (normalizedStatus === "rejected_quota") {
      account.proactiveQuotaState = "proactive_quota_exhausted";
      account.lastQuotaFailureAt = occurredAt;
    }
    if (normalizedStatus === "delivered" && windowState === "reply_window_expired") {
      account.proactiveQuotaState = "proactive_quota_available";
      account.lastProactiveSuccessAt = occurredAt;
    }
    return getDeliverySnapshot({ mode, accountId, sessionId });
  }

  function dropPendingEntry(entry, resolvedAt = safeNow(now)) {
    if (!entry) return;
    pendingEntries.delete(entry.id);
    syncPendingCount(entry, -1);
    const session = ensureSession(entry);
    const account = ensureAccount(entry.accountId);
    session.lastPendingResolvedAt = resolvedAt;
    account.lastPendingResolvedAt = resolvedAt;
  }

  function enqueuePendingReply({
    mode = "agent",
    accountId = "default",
    sessionId = "",
    fromUser = "",
    payload = {},
    reason = "",
    deliveryStatus = "rejected_unknown",
    maxRetries = 3,
    retryBackoffMs = 15000,
    expireMs = 10 * 60 * 1000,
  } = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedFromUser = normalizeUserId(fromUser);
    if (!normalizedSessionId || !normalizedFromUser) return null;

    const createdAt = safeNow(now);
    const normalizedPayload = normalizePayloadForPending(payload);
    if (!normalizedPayload.text && normalizedPayload.mediaUrls.length === 0 && !normalizedPayload.thinkingContent) {
      return null;
    }

    const dedupeKey = buildPendingDedupeKey({
      mode,
      accountId,
      sessionId: normalizedSessionId,
      fromUser: normalizedFromUser,
      payload: normalizedPayload,
    });
    for (const pending of pendingEntries.values()) {
      if (pending.dedupeKey !== dedupeKey) continue;
      pending.nextRetryAt = Math.min(Number(pending.nextRetryAt || createdAt), createdAt + Math.max(1000, retryBackoffMs));
      pending.lastPendingReason = trimText(reason);
      return { ...pending, enqueued: false };
    }

    if (pendingEntries.size >= maxPendingEntries) {
      const oldest = Array.from(pendingEntries.values()).sort((left, right) => left.createdAt - right.createdAt)[0];
      dropPendingEntry(oldest, createdAt);
    }

    const entry = {
      id: buildPendingEntryId(),
      dedupeKey,
      mode: normalizeMode(mode),
      accountId: normalizeAccountId(accountId),
      sessionId: normalizedSessionId,
      fromUser: normalizedFromUser,
      payload: normalizedPayload,
      deliveryStatus: normalizeWecomDeliveryStatus(deliveryStatus),
      createdAt,
      updatedAt: createdAt,
      nextRetryAt: createdAt + Math.max(1000, Number(retryBackoffMs) || 15000),
      expireAt: createdAt + Math.max(30000, Number(expireMs) || 10 * 60 * 1000),
      retryCount: 0,
      maxRetries: Math.max(1, Number(maxRetries) || 1),
      retryBackoffMs: Math.max(1000, Number(retryBackoffMs) || 15000),
      lastError: "",
      lastPendingReason: trimText(reason),
    };
    pendingEntries.set(entry.id, entry);
    syncPendingCount(entry, 1);

    const session = ensureSession(entry);
    const account = ensureAccount(entry.accountId);
    session.lastPendingReason = entry.lastPendingReason;
    session.lastPendingAt = createdAt;
    account.lastPendingReason = entry.lastPendingReason;
    account.lastPendingAt = createdAt;
    return { ...entry, enqueued: true };
  }

  function listDuePendingReplies({ at = safeNow(now), limit = 20 } = {}) {
    const nowAt = Number(at) || safeNow(now);
    return Array.from(pendingEntries.values())
      .filter((entry) => Number(entry.nextRetryAt || 0) <= nowAt && Number(entry.expireAt || 0) > nowAt)
      .sort((left, right) => left.nextRetryAt - right.nextRetryAt || left.createdAt - right.createdAt)
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((entry) => ({ ...entry, payload: { ...entry.payload, mediaUrls: [...entry.payload.mediaUrls] } }));
  }

  function listPendingRepliesForSession({ mode = "agent", accountId = "default", sessionId = "" } = {}) {
    const key = buildSessionStoreKey({ mode, accountId, sessionId });
    return Array.from(pendingEntries.values())
      .filter((entry) => buildSessionStoreKey(entry) === key)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((entry) => ({ ...entry, payload: { ...entry.payload, mediaUrls: [...entry.payload.mediaUrls] } }));
  }

  function markPendingDelivered({ id, at = safeNow(now) } = {}) {
    const entry = pendingEntries.get(String(id ?? "").trim());
    if (!entry) return false;
    dropPendingEntry(entry, Number(at) || safeNow(now));
    return true;
  }

  function reschedulePendingReply({ id, reason = "", at = safeNow(now) } = {}) {
    const entry = pendingEntries.get(String(id ?? "").trim());
    if (!entry) return { removed: false, rescheduled: false };
    const nowAt = Number(at) || safeNow(now);
    const nextRetryCount = Number(entry.retryCount || 0) + 1;
    entry.updatedAt = nowAt;
    entry.retryCount = nextRetryCount;
    entry.lastError = trimText(reason);
    if (nextRetryCount >= entry.maxRetries || nowAt >= entry.expireAt) {
      dropPendingEntry(entry, nowAt);
      return { removed: true, rescheduled: false };
    }
    const backoffFactor = Math.min(8, 2 ** Math.max(0, nextRetryCount - 1));
    entry.nextRetryAt = nowAt + entry.retryBackoffMs * backoffFactor;
    pendingEntries.set(entry.id, entry);
    const session = ensureSession(entry);
    const account = ensureAccount(entry.accountId);
    session.lastPendingReason = entry.lastError || session.lastPendingReason;
    account.lastPendingReason = entry.lastError || account.lastPendingReason;
    return { removed: false, rescheduled: true, entry: { ...entry } };
  }

  function dropExpiredPendingReplies({ at = safeNow(now) } = {}) {
    const nowAt = Number(at) || safeNow(now);
    let removed = 0;
    for (const entry of Array.from(pendingEntries.values())) {
      if (Number(entry.expireAt || 0) > nowAt) continue;
      dropPendingEntry(entry, nowAt);
      removed += 1;
    }
    return removed;
  }

  function getDeliverySnapshot({
    mode = "agent",
    accountId = "default",
    sessionId = "",
  } = {}) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const account = ensureAccount(normalizedAccountId);
    const session =
      sessionId != null && sessionId !== ""
        ? ensureSession({ mode, accountId: normalizedAccountId, sessionId })
        : null;
    const currentAt = safeNow(now);
    const accountWindowState = resolveWecomReplyWindowState(account.lastInboundAt, {
      now: currentAt,
      replyWindowMs,
    });
    const sessionWindowState = session
      ? resolveWecomReplyWindowState(session.lastInboundAt, {
          now: currentAt,
          replyWindowMs,
        })
      : "unknown";
    return {
      account: {
        accountId: normalizedAccountId,
        replyWindowState: accountWindowState,
        proactiveQuotaState: account.proactiveQuotaState || "unknown",
        pendingCount: Number(account.pendingCount || 0),
        lastFailureReason: account.lastFailureReason || account.lastPendingReason || "",
        lastDeliveryStatus: account.lastDeliveryStatus || "unknown",
        lastDeliveryLayer: account.lastDeliveryLayer || "",
        lastInboundAt: Number(account.lastInboundAt || 0),
      },
      session: session
        ? {
            mode: session.mode,
            accountId: session.accountId,
            sessionId: session.sessionId,
            fromUser: session.fromUser,
            replyWindowState: sessionWindowState,
            pendingCount: Number(session.pendingCount || 0),
            lastFailureReason: session.lastFailureReason || session.lastPendingReason || "",
            lastDeliveryStatus: session.lastDeliveryStatus || "unknown",
            lastDeliveryLayer: session.lastDeliveryLayer || "",
            lastInboundAt: Number(session.lastInboundAt || 0),
          }
        : null,
    };
  }

  function countPendingReplies() {
    return pendingEntries.size;
  }

  function exportState({ at = safeNow(now) } = {}) {
    return {
      version: 1,
      persistedAt: Number(at) || safeNow(now),
      accounts: Array.from(accountState.values()).map((entry) => ({ ...entry })),
      sessions: Array.from(sessionState.values()).map((entry) => ({ ...entry })),
      pending: Array.from(pendingEntries.values()).map((entry) => ({
        ...entry,
        payload: {
          ...entry.payload,
          mediaUrls: [...toArray(entry.payload?.mediaUrls)],
        },
      })),
    };
  }

  function hydrateState(snapshot = {}, { at = safeNow(now) } = {}) {
    sessionState.clear();
    accountState.clear();
    pendingEntries.clear();

    for (const rawAccount of toArray(snapshot?.accounts)) {
      const accountId = normalizeAccountId(rawAccount?.accountId);
      if (!accountId) continue;
      accountState.set(accountId, {
        ...ensureAccount(accountId),
        ...rawAccount,
        accountId,
        pendingCount: 0,
      });
    }

    for (const rawSession of toArray(snapshot?.sessions)) {
      const normalizedSessionId = normalizeSessionId(rawSession?.sessionId);
      if (!normalizedSessionId) continue;
      const entry = {
        ...ensureSession({
          mode: rawSession?.mode,
          accountId: rawSession?.accountId,
          sessionId: normalizedSessionId,
          fromUser: rawSession?.fromUser,
        }),
        ...rawSession,
        key: buildSessionStoreKey(rawSession),
        mode: normalizeMode(rawSession?.mode),
        accountId: normalizeAccountId(rawSession?.accountId),
        sessionId: normalizedSessionId,
        fromUser: normalizeUserId(rawSession?.fromUser),
        pendingCount: 0,
      };
      sessionState.set(entry.key, entry);
    }

    const nowAt = Number(at) || safeNow(now);
    for (const rawEntry of toArray(snapshot?.pending)) {
      const normalizedSessionId = normalizeSessionId(rawEntry?.sessionId);
      const normalizedFromUser = normalizeUserId(rawEntry?.fromUser);
      if (!normalizedSessionId || !normalizedFromUser) continue;
      if (Number(rawEntry?.expireAt || 0) <= nowAt) continue;
      const entry = {
        id: String(rawEntry?.id ?? buildPendingEntryId()).trim() || buildPendingEntryId(),
        dedupeKey: String(rawEntry?.dedupeKey ?? "").trim(),
        mode: normalizeMode(rawEntry?.mode),
        accountId: normalizeAccountId(rawEntry?.accountId),
        sessionId: normalizedSessionId,
        fromUser: normalizedFromUser,
        payload: normalizePayloadForPending(rawEntry?.payload),
        deliveryStatus: normalizeWecomDeliveryStatus(rawEntry?.deliveryStatus),
        createdAt: Number(rawEntry?.createdAt || nowAt),
        updatedAt: Number(rawEntry?.updatedAt || rawEntry?.createdAt || nowAt),
        nextRetryAt: Number(rawEntry?.nextRetryAt || nowAt),
        expireAt: Number(rawEntry?.expireAt || nowAt + 10 * 60 * 1000),
        retryCount: Math.max(0, Number(rawEntry?.retryCount || 0)),
        maxRetries: Math.max(1, Number(rawEntry?.maxRetries || 1)),
        retryBackoffMs: Math.max(1000, Number(rawEntry?.retryBackoffMs || 15000)),
        lastError: trimText(rawEntry?.lastError),
        lastPendingReason: trimText(rawEntry?.lastPendingReason),
      };
      if (!entry.dedupeKey) {
        entry.dedupeKey = buildPendingDedupeKey(entry);
      }
      pendingEntries.set(entry.id, entry);
      syncPendingCount(entry, 1);
      const session = ensureSession(entry);
      const account = ensureAccount(entry.accountId);
      session.lastPendingReason = entry.lastPendingReason || session.lastPendingReason;
      session.lastPendingAt = Math.max(Number(session.lastPendingAt || 0), entry.updatedAt || entry.createdAt);
      account.lastPendingReason = entry.lastPendingReason || account.lastPendingReason;
      account.lastPendingAt = Math.max(Number(account.lastPendingAt || 0), entry.updatedAt || entry.createdAt);
    }

    return exportState({ at: nowAt });
  }

  return {
    markInboundActivity,
    recordDeliveryOutcome,
    enqueuePendingReply,
    listDuePendingReplies,
    listPendingRepliesForSession,
    markPendingDelivered,
    reschedulePendingReply,
    dropExpiredPendingReplies,
    getDeliverySnapshot,
    countPendingReplies,
    exportState,
    hydrateState,
  };
}
