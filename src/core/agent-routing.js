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

function resolveDynamicAgentSelection({
  cfg,
  dynamicConfig,
  fromUser,
  chatId,
  isGroupChat,
  content,
  mentionPatterns,
  isAdminUser,
}) {
  if (dynamicConfig?.enabled !== true) return { agentId: "", matchedBy: "" };

  const userKey = normalizeToken(fromUser);
  const groupKey = normalizeToken(chatId);

  if (isAdminUser && dynamicConfig.adminAgentId) {
    const resolved = resolveMappedAgentId(cfg, dynamicConfig.adminAgentId);
    if (resolved) return { agentId: resolved, matchedBy: "dynamic.admin" };
  }

  if (isGroupChat && groupKey) {
    const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig.groupMap, groupKey));
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.group" };
  }

  if (isGroupChat && dynamicConfig.preferMentionMap !== false) {
    const mentionCandidates = extractWecomMentionCandidates(content, mentionPatterns);
    for (const candidate of mentionCandidates) {
      const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig.mentionMap, candidate));
      if (mapped) return { agentId: mapped, matchedBy: "dynamic.mention" };
    }
  }

  if (userKey) {
    const mapped = resolveMappedAgentId(cfg, pickMapValue(dynamicConfig.userMap, userKey));
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.user" };
  }

  if (dynamicConfig.defaultAgentId) {
    const mapped = resolveMappedAgentId(cfg, dynamicConfig.defaultAgentId);
    if (mapped) return { agentId: mapped, matchedBy: "dynamic.default" };
  }

  return { agentId: "", matchedBy: "" };
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
  const peerId = isGroupChat ? normalizeSessionKey(chatId) || normalizeSessionKey(fromUser) || "unknown" : normalizeSessionKey(fromUser) || "unknown";
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
    fromUser,
    chatId,
    isGroupChat,
    content,
    mentionPatterns,
    isAdminUser,
  });
  const selectedAgentId = normalizeAgentId(dynamicSelection.agentId);
  const matchedBy = dynamicSelection.matchedBy || String(baseRoute?.matchedBy ?? "default");

  if (selectedAgentId && !isKnownAgentId(cfg, selectedAgentId)) {
    logger?.warn?.(`wecom: dynamic route ignored unknown agentId=${selectedAgentId}`);
  }

  const finalAgentId = selectedAgentId && isKnownAgentId(cfg, selectedAgentId) ? selectedAgentId : normalizedBaseAgentId;
  const shouldBindAgentSessionKey =
    Boolean(dynamicConfig?.forceAgentSessionKey) || Boolean(finalAgentId && finalAgentId !== normalizedBaseAgentId);
  const finalSessionKey = shouldBindAgentSessionKey
    ? bindSessionKeyToAgent(normalizedBaseSessionKey, finalAgentId)
    : normalizedBaseSessionKey;

  return {
    ...baseRoute,
    agentId: finalAgentId || normalizedBaseAgentId,
    sessionKey: finalSessionKey || normalizedBaseSessionKey,
    matchedBy,
    dynamicMatchedBy: dynamicSelection.matchedBy || "",
    dynamicApplied: Boolean(dynamicSelection.matchedBy),
  };
}
