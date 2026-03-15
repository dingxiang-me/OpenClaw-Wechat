export const DEFAULT_WECOM_API_BASE_URL = "https://qyapi.weixin.qq.com";

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function normalizeHttpBaseUrl(value, fallback = DEFAULT_WECOM_API_BASE_URL) {
  const raw = String(value ?? "").trim() || String(fallback ?? "").trim() || DEFAULT_WECOM_API_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/";
  } else if (parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "/");
  }
  return parsed.toString().replace(/\/$/, "");
}

function readScopedEnvValue({ envVars = {}, processEnv = process.env, accountId = "default", suffix = "" } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const scopedKey = normalizedAccountId === "default" ? null : `WECOM_${normalizedAccountId.toUpperCase()}_${suffix}`;
  return pickFirstNonEmptyString(
    scopedKey ? envVars?.[scopedKey] : undefined,
    scopedKey ? processEnv?.[scopedKey] : undefined,
    envVars?.[`WECOM_${suffix}`],
    processEnv?.[`WECOM_${suffix}`],
  );
}

export function normalizeWecomApiBaseUrl(value, fallback = DEFAULT_WECOM_API_BASE_URL) {
  return normalizeHttpBaseUrl(value, fallback);
}

export function buildWecomApiUrl(path, { apiBaseUrl = DEFAULT_WECOM_API_BASE_URL } = {}) {
  const normalizedBaseUrl = normalizeWecomApiBaseUrl(apiBaseUrl);
  const normalizedPath = String(path ?? "").trim();
  if (!normalizedPath) return normalizedBaseUrl;
  return new URL(normalizedPath.replace(/^\/+/, ""), `${normalizedBaseUrl}/`).toString();
}

export function isWecomApiUrl(url, { apiBaseUrl = DEFAULT_WECOM_API_BASE_URL } = {}) {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  const candidates = [DEFAULT_WECOM_API_BASE_URL, apiBaseUrl]
    .map((value) => {
      try {
        return new URL(`${normalizeWecomApiBaseUrl(value)}/`);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  try {
    const parsed = new URL(raw);
    return candidates.some(
      (baseUrl) => parsed.origin === baseUrl.origin && parsed.pathname.startsWith(baseUrl.pathname),
    );
  } catch {
    return candidates.some((baseUrl) => raw.includes(baseUrl.origin));
  }
}

export function resolveWecomApiBaseUrl({
  channelConfig = {},
  accountConfig = {},
  envVars = {},
  processEnv = process.env,
  accountId = "default",
} = {}) {
  const fromAccount = pickFirstNonEmptyString(accountConfig?.apiBaseUrl, accountConfig?.network?.apiBaseUrl);
  const fromChannel = pickFirstNonEmptyString(channelConfig?.apiBaseUrl, channelConfig?.network?.apiBaseUrl);
  const fromEnv = readScopedEnvValue({
    envVars,
    processEnv,
    accountId,
    suffix: "API_BASE_URL",
  });
  return normalizeWecomApiBaseUrl(pickFirstNonEmptyString(fromAccount, fromChannel, fromEnv));
}
