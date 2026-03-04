import { buildDefaultAgentWebhookPath } from "./account-paths.js";

export function asNumber(v, fallback = null) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createRequireEnv(processEnv) {
  return function requireEnv(name, fallback) {
    const v = processEnv?.[name];
    if (v == null || v === "") return fallback;
    return v;
  };
}

export function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function normalizeAccountConfig({ raw, accountId, normalizeWecomWebhookTargetMap } = {}) {
  const normalizedId = normalizeAccountId(accountId);
  if (!raw || typeof raw !== "object") return null;
  if (typeof normalizeWecomWebhookTargetMap !== "function") return null;

  const corpId = String(raw.corpId ?? "").trim();
  const corpSecret = String(raw.corpSecret ?? "").trim();
  const agentId = asNumber(raw.agentId);
  const callbackToken = pickFirstNonEmptyString(raw.callbackToken, raw.token);
  const callbackAesKey = pickFirstNonEmptyString(raw.callbackAesKey, raw.encodingAesKey);
  const defaultWebhookPath = buildDefaultAgentWebhookPath(normalizedId);
  const webhookPath = String(raw.webhookPath ?? defaultWebhookPath).trim() || defaultWebhookPath;
  const outboundProxy = String(raw.outboundProxy ?? raw.proxyUrl ?? raw.proxy ?? "").trim();
  const webhooks = normalizeWecomWebhookTargetMap(raw.webhooks);
  const allowFrom = raw.allowFrom;
  const allowFromRejectMessage = String(raw.allowFromRejectMessage ?? raw.rejectUnauthorizedMessage ?? "").trim();

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
    webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined,
    allowFrom,
    allowFromRejectMessage: allowFromRejectMessage || undefined,
    enabled: raw.enabled !== false,
  };
}

export function readAccountConfigFromEnv({
  envVars,
  accountId,
  requireEnv,
  normalizeWecomWebhookTargetMap,
} = {}) {
  if (typeof requireEnv !== "function") return null;
  if (typeof normalizeWecomWebhookTargetMap !== "function") return null;

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
  const callbackToken = pickFirstNonEmptyString(readVar("CALLBACK_TOKEN"), readVar("TOKEN"));
  const callbackAesKey = pickFirstNonEmptyString(readVar("CALLBACK_AES_KEY"), readVar("ENCODING_AES_KEY"));
  const defaultWebhookPath = buildDefaultAgentWebhookPath(normalizedId);
  const webhookPath = String(readVar("WEBHOOK_PATH") ?? defaultWebhookPath).trim() || defaultWebhookPath;
  const outboundProxyRaw =
    readVar("PROXY") ??
    (normalizedId === "default"
      ? requireEnv("HTTPS_PROXY")
      : envVars?.WECOM_PROXY ?? requireEnv("WECOM_PROXY") ?? requireEnv("HTTPS_PROXY"));
  const outboundProxy = String(outboundProxyRaw ?? "").trim();
  const webhooks = normalizeWecomWebhookTargetMap(readVar("WEBHOOK_TARGETS"), readVar("WEBHOOKS"));
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
    webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined,
    allowFrom,
    allowFromRejectMessage: allowFromRejectMessage || undefined,
    enabled,
  };
}

export function collectWecomEnvAccountIds({ envVars = {}, processEnv = {} } = {}) {
  const envAccountIds = new Set(["default"]);
  for (const key of Object.keys(envVars)) {
    const m = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
    if (m && m[1] !== "CORP") envAccountIds.add(m[1].toLowerCase());
  }
  for (const key of Object.keys(processEnv)) {
    const m = key.match(/^WECOM_([A-Z0-9]+)_CORP_ID$/);
    if (m && m[1] !== "CORP") envAccountIds.add(m[1].toLowerCase());
  }
  return envAccountIds;
}
