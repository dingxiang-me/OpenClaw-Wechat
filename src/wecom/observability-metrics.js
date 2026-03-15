function incrementCounter(map, key, delta = 1) {
  const normalizedKey = String(key ?? "").trim() || "unknown";
  map[normalizedKey] = Number(map[normalizedKey] || 0) + Number(delta || 0);
}

function safeNow(nowFn) {
  try {
    return Number(nowFn?.() || Date.now());
  } catch {
    return Date.now();
  }
}

export function createWecomObservabilityMetricsStore({
  maxRecentFailures = 40,
  now = () => Date.now(),
} = {}) {
  const state = {
    inboundTotal: 0,
    inboundByMode: { agent: 0, bot: 0 },
    inboundByType: {},
    inboundByAccount: {},
    deliveryTotal: 0,
    deliverySuccess: 0,
    deliveryFailed: 0,
    deliveryByLayer: {},
    deliveryByStatus: {},
    errorsTotal: 0,
    errorsByScope: {},
    recentFailures: [],
  };

  function pushRecentFailure(entry = {}) {
    const row = {
      at: safeNow(now),
      scope: String(entry.scope ?? "unknown").trim() || "unknown",
      reason: String(entry.reason ?? "unknown").trim().slice(0, 240) || "unknown",
      accountId: String(entry.accountId ?? "").trim() || undefined,
      layer: String(entry.layer ?? "").trim() || undefined,
    };
    state.recentFailures.push(row);
    if (state.recentFailures.length > maxRecentFailures) {
      state.recentFailures.splice(0, state.recentFailures.length - maxRecentFailures);
    }
  }

  function recordInboundMetric({
    mode = "agent",
    msgType = "",
    accountId = "default",
  } = {}) {
    const normalizedMode = String(mode ?? "agent").trim().toLowerCase() === "bot" ? "bot" : "agent";
    const normalizedType = String(msgType ?? "").trim().toLowerCase() || "unknown";
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    state.inboundTotal += 1;
    state.inboundByMode[normalizedMode] = Number(state.inboundByMode[normalizedMode] || 0) + 1;
    incrementCounter(state.inboundByType, normalizedType, 1);
    incrementCounter(state.inboundByAccount, normalizedAccountId, 1);
  }

  function recordDeliveryMetric({
    layer = "",
    ok = false,
    finalStatus = "",
    deliveryStatus = "",
    accountId = "default",
    attempts = [],
  } = {}) {
    const normalizedLayer = String(layer ?? "").trim().toLowerCase() || "unknown";
    const normalizedStatus =
      String(deliveryStatus ?? "").trim().toLowerCase() ||
      String(finalStatus ?? "").trim().toLowerCase() ||
      (ok ? "ok" : "failed");
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    state.deliveryTotal += 1;
    if (ok) state.deliverySuccess += 1;
    else state.deliveryFailed += 1;
    incrementCounter(state.deliveryByLayer, normalizedLayer, 1);
    incrementCounter(state.deliveryByStatus, normalizedStatus, 1);
    incrementCounter(state.inboundByAccount, normalizedAccountId, 0);

    const normalizedAttempts = Array.isArray(attempts) ? attempts : [];
    for (const attempt of normalizedAttempts) {
      if (attempt?.status === "error" || attempt?.status === "miss") {
        pushRecentFailure({
          scope: "delivery",
          reason: `${String(attempt?.deliveryStatus ?? attempt?.status ?? "unknown")} ${String(
            attempt?.reason ?? "unknown",
          )}`.trim(),
          accountId: normalizedAccountId,
          layer: String(attempt?.layer ?? ""),
        });
      }
    }
  }

  function recordRuntimeErrorMetric({
    scope = "runtime",
    reason = "",
    accountId = "default",
    layer = "",
  } = {}) {
    const normalizedScope = String(scope ?? "runtime").trim().toLowerCase() || "runtime";
    const normalizedReason = String(reason ?? "").trim() || "unknown";
    const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
    state.errorsTotal += 1;
    incrementCounter(state.errorsByScope, normalizedScope, 1);
    pushRecentFailure({
      scope: normalizedScope,
      reason: normalizedReason,
      accountId: normalizedAccountId,
      layer,
    });
  }

  function getWecomObservabilityMetrics() {
    return {
      inboundTotal: state.inboundTotal,
      inboundByMode: { ...state.inboundByMode },
      inboundByType: { ...state.inboundByType },
      inboundByAccount: { ...state.inboundByAccount },
      deliveryTotal: state.deliveryTotal,
      deliverySuccess: state.deliverySuccess,
      deliveryFailed: state.deliveryFailed,
      deliveryByLayer: { ...state.deliveryByLayer },
      deliveryByStatus: { ...state.deliveryByStatus },
      errorsTotal: state.errorsTotal,
      errorsByScope: { ...state.errorsByScope },
      recentFailures: state.recentFailures.slice(-10).map((item) => ({ ...item })),
    };
  }

  return {
    recordInboundMetric,
    recordDeliveryMetric,
    recordRuntimeErrorMetric,
    getWecomObservabilityMetrics,
  };
}
