import crypto from "node:crypto";

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeAgentId(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function normalizeSessionKey(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function normalizeSlugSegment(value, fallback = "unknown", maxLength = 24) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = normalized || fallback;
  return safe.slice(0, Math.max(1, maxLength));
}

function hashShort(value, length = 10) {
  const digest = crypto.createHash("sha1").update(String(value ?? "")).digest("hex");
  return digest.slice(0, Math.max(4, Math.min(40, length)));
}

function isKnownAgentId(cfg, agentId) {
  const normalized = normalizeToken(agentId);
  if (!normalized) return false;
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  if (agents.length === 0) return true;
  return agents.some((agent) => normalizeToken(agent?.id) === normalized);
}

function resolveMappedAgentId(cfg, rawAgentId) {
  const normalized = normalizeAgentId(rawAgentId);
  if (!normalized) return "";
  if (isKnownAgentId(cfg, normalized)) return normalized;
  return "";
}

function pickMapValue(mapLike, key) {
  if (!mapLike || typeof mapLike !== "object") return "";
  const normalizedKey = normalizeToken(key);
  if (!normalizedKey) return "";
  return normalizeAgentId(mapLike[normalizedKey]);
}

function uniqueList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const token = normalizeToken(value);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function normalizeDynamicMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "mapping" || mode === "deterministic" || mode === "hybrid") {
    return mode;
  }
  return "mapping";
}

export function buildDeterministicWecomAgentId({
  accountId = "default",
  fromUser = "",
  chatId = "",
  isGroupChat = false,
  prefix = "wecom",
  idStrategy = "readable-hash",
} = {}) {
  const normalizedPrefix = normalizeSlugSegment(prefix, "wecom", 20);
  const normalizedAccount = normalizeSlugSegment(accountId, "default", 20);
  const kind = isGroupChat ? "group" : "dm";
  const sourceRaw = String(isGroupChat ? chatId : fromUser).trim();
  const normalizedSource = normalizeSlugSegment(sourceRaw, isGroupChat ? "chat" : "user", 24);
  if (!sourceRaw && !normalizedSource) return "";

  const hashInput = `${normalizedAccount}|${kind}|${normalizeToken(sourceRaw)}`;
  const suffix = idStrategy === "readable-hash" ? hashShort(hashInput, 10) : hashShort(hashInput, 8);
  const agentId = `${normalizedPrefix}-${kind}-${normalizedAccount}-${normalizedSource}-${suffix}`;
  return agentId.slice(0, 64);
}

export function extractWecomMentionCandidates(content, mentionPatterns = ["@"]) {
  const text = String(content ?? "");
  if (!text.trim()) return [];

  const candidates = [];
  const generic = text.matchAll(/@([^\s@,，。！？、；;:：()（）<>《》[\]{}]+)/gu);
  for (const match of generic) {
    const token = normalizeToken(match?.[1]);
    if (token) candidates.push(token);
  }

  const normalizedPatterns = Array.isArray(mentionPatterns) ? mentionPatterns : ["@"];
  for (const rawPattern of normalizedPatterns) {
    const pattern = String(rawPattern ?? "").trim();
    if (!pattern || pattern === "@") continue;
    const cleanPattern = normalizeToken(pattern.replace(/^@+/, ""));
    if (cleanPattern) candidates.push(cleanPattern);
  }

  return uniqueList(candidates);
}

export function bindSessionKeyToAgent(sessionKey, agentId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) return normalizeSessionKey(sessionKey);

  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) return `agent:${normalizedAgentId}:main`;

  if (normalizedSessionKey.startsWith("agent:")) {
    const parts = normalizedSessionKey.split(":");
    if (parts.length >= 2) {
      parts[1] = normalizedAgentId;
      return parts.join(":");
    }
  }

  return `agent:${normalizedAgentId}:${normalizedSessionKey}`;
}

function resolveMappedDynamicSelection({
  cfg,
  dynamicConfig,
  fromUser,
  chatId,
  isGroupChat,
  content,
  mentionPatterns,
  isAdminUser,
}) {
  const userKey = normalizeToken(fromUser);
  const groupKey = normalizeToken(chatId);

  if (isAdminUser && dynamicConfig?.adminAgentId) {
    const resolved = resolveMappedAgentId(cfg, dynamicConfig.adminAgentId);
    if (resolved) return { agentId: resolved, matchedBy: "dynamic.admin", allowUnknown: false };
  }

  if (isGroupChat && groupKey) {
    const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig?.groupMap, groupKey));
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.group", allowUnknown: false };
  }

  if (isGroupChat && dynamicConfig?.preferMentionMap !== false) {
    const mentionCandidates = extractWecomMentionCandidates(content, mentionPatterns);
    for (const candidate of mentionCandidates) {
      const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig?.mentionMap, candidate));
      if (mapped) return { agentId: mapped, matchedBy: "dynamic.mention", allowUnknown: false };
    }
  }

  if (userKey) {
    const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig?.userMap, userKey));
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.user", allowUnknown: false };
  }

  if (dynamicConfig?.defaultAgentId) {
    const mapped = resolveMappedAgentId(cfg, dynamicConfig.defaultAgentId);
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.default", allowUnknown: false };
  }

  return { agentId: "", matchedBy: "", allowUnknown: false };
}

function resolveDeterministicDynamicSelection({
  dynamicConfig,
  accountId,
  fromUser,
  chatId,
  isGroupChat,
}) {
  const deterministicAgentId = buildDeterministicWecomAgentId({
    accountId,
    fromUser,
    chatId,
    isGroupChat,
    prefix: dynamicConfig?.deterministicPrefix || "wecom",
    idStrategy: dynamicConfig?.idStrategy || "readable-hash",
  });
  if (!deterministicAgentId) {
    return { agentId: "", matchedBy: "", allowUnknown: false };
  }
  return {
    agentId: deterministicAgentId,
    matchedBy: isGroupChat ? "dynamic.deterministic.group" : "dynamic.deterministic.user",
    allowUnknown: dynamicConfig?.allowUnknownAgentId === true || dynamicConfig?.autoProvision === true,
  };
}

function resolveDynamicAgentSelection({
  cfg,
  dynamicConfig,
  accountId,
  fromUser,
  chatId,
  isGroupChat,
  content,
  mentionPatterns,
  isAdminUser,
}) {
  if (dynamicConfig?.enabled !== true) return { agentId: "", matchedBy: "", allowUnknown: false };

  const mode = normalizeDynamicMode(dynamicConfig?.mode);
  if (mode === "mapping") {
    return resolveMappedDynamicSelection({
      cfg,
      dynamicConfig,
      fromUser,
      chatId,
      isGroupChat,
      content,
      mentionPatterns,
      isAdminUser,
    });
  }

  if (mode === "deterministic") {
    return resolveDeterministicDynamicSelection({
      dynamicConfig,
      accountId,
      fromUser,
      chatId,
      isGroupChat,
    });
  }

  const mapped = resolveMappedDynamicSelection({
    cfg,
    dynamicConfig,
    fromUser,
    chatId,
    isGroupChat,
    content,
    mentionPatterns,
    isAdminUser,
  });
  if (mapped.agentId) return mapped;

  return resolveDeterministicDynamicSelection({
    dynamicConfig,
    accountId,
    fromUser,
    chatId,
    isGroupChat,
  });
}

export function resolveWecomAgentRoute({
  runtime,
  cfg,
  channel = "wecom",
  accountId = "default",
  sessionKey = "",
  fromUser = "",
  chatId = "",
  isGroupChat = false,
  content = "",
  mentionPatterns = ["@"],
  dynamicConfig = null,
  isAdminUser = false,
  logger = null,
} = {}) {
  const peerId = isGroupChat
    ? normalizeSessionKey(chatId) || normalizeSessionKey(fromUser) || "unknown"
    : normalizeSessionKey(fromUser) || "unknown";
  const baseRoute = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel,
    accountId,
    peer: {
      kind: isGroupChat ? "channel" : "direct",
      id: peerId,
    },
  });
  const normalizedBaseSessionKey = normalizeSessionKey(sessionKey) || normalizeSessionKey(baseRoute?.sessionKey);
  const normalizedBaseAgentId = normalizeAgentId(baseRoute?.agentId);

  const dynamicSelection = resolveDynamicAgentSelection({
    cfg,
    dynamicConfig,
    accountId,
    fromUser,
    chatId,
    isGroupChat,
    content,
    mentionPatterns,
    isAdminUser,
  });

  const selectedAgentId = normalizeAgentId(dynamicSelection.agentId);
  const allowUnknownAgentId = dynamicSelection.allowUnknown === true;
  const knownSelectedAgent = selectedAgentId ? isKnownAgentId(cfg, selectedAgentId) : false;
  const canApplySelectedAgent = selectedAgentId && (knownSelectedAgent || allowUnknownAgentId);

  if (selectedAgentId && !canApplySelectedAgent) {
    logger?.warn?.(`wecom: dynamic route ignored unknown agentId=${selectedAgentId}`);
  }

  const finalAgentId = canApplySelectedAgent ? selectedAgentId : normalizedBaseAgentId;
  const shouldBindAgentSessionKey =
    Boolean(dynamicConfig?.forceAgentSessionKey) || Boolean(canApplySelectedAgent && finalAgentId !== normalizedBaseAgentId);
  const finalSessionKey = shouldBindAgentSessionKey
    ? bindSessionKeyToAgent(normalizedBaseSessionKey, finalAgentId)
    : normalizedBaseSessionKey;
  const matchedBy = dynamicSelection.matchedBy || String(baseRoute?.matchedBy ?? "default");

  return {
    ...baseRoute,
    agentId: finalAgentId || normalizedBaseAgentId,
    sessionKey: finalSessionKey || normalizedBaseSessionKey,
    matchedBy,
    dynamicMatchedBy: dynamicSelection.matchedBy || "",
    dynamicApplied: Boolean(dynamicSelection.matchedBy),
    dynamicMode: normalizeDynamicMode(dynamicConfig?.mode),
    allowUnknownAgentId,
  };
}
