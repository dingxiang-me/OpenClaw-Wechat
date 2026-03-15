function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomPendingReplyManager: ${name} is required`);
  }
}

export function createWecomPendingReplyManager({
  reliableDeliveryStore,
  resolveWecomPendingReplyPolicy,
  deliverPendingReply,
  ensurePersistenceLoaded = async () => true,
  schedulePersistenceFlush = () => {},
  logger,
  now = () => Date.now(),
  sweepIntervalMs = 15000,
} = {}) {
  if (!reliableDeliveryStore || typeof reliableDeliveryStore !== "object") {
    throw new Error("createWecomPendingReplyManager: reliableDeliveryStore is required");
  }
  assertFunction("resolveWecomPendingReplyPolicy", resolveWecomPendingReplyPolicy);
  assertFunction("deliverPendingReply", deliverPendingReply);
  assertFunction("ensurePersistenceLoaded", ensurePersistenceLoaded);
  assertFunction("schedulePersistenceFlush", schedulePersistenceFlush);
  assertFunction("now", now);

  let sweepTimer = null;
  let sweepPromise = Promise.resolve();

  function ensureSweepTimer() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      void flushDuePendingReplies("timer");
    }, Math.max(5000, Number(sweepIntervalMs) || 15000));
    sweepTimer.unref?.();
  }

  async function initialize(api) {
    await ensurePersistenceLoaded(api);
    if (reliableDeliveryStore.countPendingReplies() > 0) {
      ensureSweepTimer();
    }
    return true;
  }

  function enqueuePendingReply(api, payload = {}) {
    const policy = resolveWecomPendingReplyPolicy(api);
    if (policy?.enabled !== true) return null;
    const entry = reliableDeliveryStore.enqueuePendingReply({
      ...payload,
      maxRetries: policy.maxRetries,
      retryBackoffMs: policy.retryBackoffMs,
      expireMs: policy.expireMs,
    });
    if (entry) {
      ensureSweepTimer();
      schedulePersistenceFlush("pending-enqueue", api);
    }
    return entry;
  }

  async function attemptPendingEntry(entry, trigger = "timer") {
    try {
      const result = await deliverPendingReply(entry, trigger);
      if (result?.ok === true) {
        reliableDeliveryStore.markPendingDelivered({ id: entry.id, at: now() });
        schedulePersistenceFlush("pending-delivered");
        return { delivered: true, result };
      }
      const reason = String(result?.deliveryStatus || result?.finalStatus || result?.error || "pending-retry-failed");
      return {
        delivered: false,
        result,
        rescheduled: reliableDeliveryStore.reschedulePendingReply({
          id: entry.id,
          reason,
          at: now(),
        }),
      };
    } catch (err) {
      const reason = String(err?.message || err || "pending-retry-failed");
      logger?.warn?.(`wecom: pending reply retry failed id=${entry.id} trigger=${trigger} reason=${reason}`);
      return {
        delivered: false,
        error: reason,
        rescheduled: reliableDeliveryStore.reschedulePendingReply({
          id: entry.id,
          reason,
          at: now(),
        }),
      };
    }
  }

  async function flushEntries(entries = [], trigger = "timer") {
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      // Keep retries ordered and deterministic.
      // eslint-disable-next-line no-await-in-loop
      await attemptPendingEntry(entry, trigger);
    }
  }

  function flushDuePendingReplies(trigger = "timer") {
    sweepPromise = sweepPromise
      .then(async () => {
        await initialize();
        reliableDeliveryStore.dropExpiredPendingReplies({ at: now() });
        const entries = reliableDeliveryStore.listDuePendingReplies({ at: now(), limit: 20 });
        await flushEntries(entries, trigger);
        schedulePersistenceFlush(`pending-flush:${trigger}`);
      })
      .catch((err) => {
        logger?.warn?.(`wecom: pending reply sweep failed: ${String(err?.message || err)}`);
      });
    return sweepPromise;
  }

  function flushSessionPendingReplies({ mode = "agent", accountId = "default", sessionId = "" } = {}) {
    return ensurePersistenceLoaded()
      .then(() =>
        reliableDeliveryStore.listPendingRepliesForSession({
          mode,
          accountId,
          sessionId,
        }),
      )
      .then((entries) => {
        if (entries.length === 0) return null;
        return flushEntries(entries, "session-inbound");
      })
      .then(() => {
        schedulePersistenceFlush("pending-session-flush");
      });
  }

  return {
    initialize,
    enqueuePendingReply,
    flushDuePendingReplies,
    flushSessionPendingReplies,
    ensureSweepTimer,
  };
}
