function normalizeReplyFormatMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "text" || normalized === "markdown" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function normalizeDirectiveTarget(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const unwrapped = trimmed
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(/[.,;:!?。，；：！？）》」』\]]+$/, "")
    .trim();
  if (!unwrapped) return "";
  if (
    unwrapped.startsWith("/workspace/") ||
    unwrapped.startsWith("/") ||
    /^https?:\/\//i.test(unwrapped) ||
    /^file:\/\//i.test(unwrapped) ||
    /^sandbox:/i.test(unwrapped)
  ) {
    return unwrapped;
  }
  return "";
}

export function normalizeWecomReplyFormatPolicy(policy = {}) {
  return {
    mode: normalizeReplyFormatMode(policy?.mode),
  };
}

export function extractWecomReplyDirectives(text = "") {
  const raw = String(text ?? "");
  if (!raw) {
    return {
      text: "",
      mediaItems: [],
    };
  }

  const mediaItems = [];
  const cleanedLines = [];
  const dedupe = new Set();

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*•]\s*)?(MEDIA|FILE)\s*:\s*(.+?)\s*$/i);
    if (!match) {
      cleanedLines.push(line);
      continue;
    }
    const url = normalizeDirectiveTarget(match[2]);
    if (!url) continue;
    const mediaType = String(match[1] ?? "").trim().toUpperCase() === "FILE" ? "file" : undefined;
    const dedupeKey = `${mediaType || ""}:${url}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);
    mediaItems.push({
      url,
      mediaType,
      source: "directive",
    });
  }

  return {
    text: cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    mediaItems,
  };
}

export function resolveWecomReplyDirectiveMediaItems({
  mediaItems = [],
  routeAgentId = "",
  resolveWorkspacePathToHost = () => "",
} = {}) {
  const normalizedRouteAgentId = String(routeAgentId ?? "").trim();
  const out = [];
  const dedupe = new Set();

  for (const item of Array.isArray(mediaItems) ? mediaItems : []) {
    const rawUrl = String(item?.url ?? "").trim();
    if (!rawUrl) continue;
    let resolvedUrl = rawUrl;
    if (rawUrl.startsWith("/workspace/") && normalizedRouteAgentId) {
      const hostPath = resolveWorkspacePathToHost({
        workspacePath: rawUrl,
        agentId: normalizedRouteAgentId,
      });
      if (hostPath) {
        resolvedUrl = String(hostPath).trim() || rawUrl;
      }
    }
    const mediaType = String(item?.mediaType ?? "").trim().toLowerCase() || undefined;
    const dedupeKey = `${mediaType || ""}:${resolvedUrl}`;
    if (!resolvedUrl || dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);
    out.push({
      url: resolvedUrl,
      mediaType,
      source: item?.source || "",
    });
  }

  return out;
}

export function mergeWecomReplyMediaItems({
  mediaUrl,
  mediaUrls,
  mediaItems,
  mediaType,
  extraMediaItems = [],
} = {}) {
  const out = [];
  const dedupe = new Set();

  const pushItem = (url, forcedType, source = "") => {
    const normalizedUrl = String(url ?? "").trim();
    if (!normalizedUrl) return;
    const normalizedType = String(forcedType ?? "").trim().toLowerCase() || undefined;
    const dedupeKey = `${normalizedType || ""}:${normalizedUrl}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);
    out.push({
      url: normalizedUrl,
      mediaType: normalizedType,
      source,
    });
  };

  pushItem(mediaUrl, mediaType, "payload");
  for (const url of Array.isArray(mediaUrls) ? mediaUrls : []) {
    pushItem(url, mediaType, "payload");
  }
  for (const item of Array.isArray(mediaItems) ? mediaItems : []) {
    pushItem(item?.url, item?.mediaType, item?.source || "payload");
  }
  for (const item of Array.isArray(extraMediaItems) ? extraMediaItems : []) {
    pushItem(item?.url, item?.mediaType, item?.source || "directive");
  }

  return out;
}

export function selectWecomReplyTextVariant({
  plainText = "",
  richText = "",
  policy = {},
  supportsMarkdown = false,
} = {}) {
  const normalizedPolicy = normalizeWecomReplyFormatPolicy(policy);
  const fallbackPlainText = String(plainText ?? "").trim();
  const candidateRichText = String(richText ?? "").trim();
  if (normalizedPolicy.mode === "markdown" && supportsMarkdown && candidateRichText) {
    return {
      text: candidateRichText,
      format: "markdown",
      policyMode: normalizedPolicy.mode,
    };
  }
  return {
    text: fallbackPlainText,
    format: "text",
    policyMode: normalizedPolicy.mode,
  };
}
