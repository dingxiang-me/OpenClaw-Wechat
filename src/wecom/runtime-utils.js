export function requireEnv(name, fallback, processEnv = process.env) {
  const value = processEnv?.[name];
  if (value == null || value === "") return fallback;
  return value;
}

export function buildWecomBotSessionId(userId, accountId = "default") {
  const normalizedUserId = String(userId ?? "").trim().toLowerCase();
  const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
  if (normalizedAccountId === "default") {
    return `wecom-bot:${normalizedUserId}`;
  }
  return `wecom-bot:${normalizedAccountId}:${normalizedUserId}`;
}

export function asNumber(value, fallback = null) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isAgentFailureText(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes("request was aborted") || normalized.includes("fetch failed");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, timeoutMs, timeoutMessage) {
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

export function isDispatchTimeoutError(err) {
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return text.includes("dispatch timed out after") || text.includes("operation timed out after");
}

export function createDeliveryTraceId(prefix = "wecom") {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stamp}-${rand}`;
}
