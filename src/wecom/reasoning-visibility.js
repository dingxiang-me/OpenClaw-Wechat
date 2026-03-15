function normalizeReasoningMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "append" || normalized === "hidden" || normalized === "separate") {
    return normalized;
  }
  return "separate";
}

function trimReasoningText(value, maxChars = 1200) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const limit = Math.max(64, Number(maxChars) || 1200);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function normalizeWecomReasoningPolicy(policy = {}) {
  const title = String(policy?.title ?? "").trim() || "思考过程";
  const mode = normalizeReasoningMode(policy?.mode);
  const maxChars = Math.max(64, Number(policy?.maxChars) || 1200);
  return {
    mode,
    title,
    maxChars,
    sendThinkingMessage: mode === "separate",
    includeInFinalAnswer: mode === "append",
  };
}

export function buildWecomReasoningMergedText({
  text = "",
  thinkingContent = "",
  title = "思考过程",
} = {}) {
  const visibleText = String(text ?? "").trim();
  const reasoning = String(thinkingContent ?? "").trim();
  if (!reasoning) return visibleText;
  const heading = `${String(title ?? "").trim() || "思考过程"}：`;
  if (!visibleText) {
    return `${heading}\n${reasoning}`.trim();
  }
  return `${heading}\n${reasoning}\n\n${visibleText}`.trim();
}

export function applyWecomReasoningPolicy({
  text = "",
  thinkingContent = "",
  policy = {},
  transport = "bot",
  phase = "final",
} = {}) {
  const normalizedPolicy = normalizeWecomReasoningPolicy(policy);
  const visibleText = String(text ?? "").trim();
  const reasoning = trimReasoningText(thinkingContent, normalizedPolicy.maxChars);
  if (!reasoning) {
    return {
      text: visibleText,
      thinkingContent: "",
      effectiveMode: normalizedPolicy.mode,
    };
  }

  if (phase === "stream") {
    return {
      text: visibleText,
      thinkingContent:
        normalizedPolicy.mode === "separate" && String(transport ?? "").trim().toLowerCase() === "bot" ? reasoning : "",
      effectiveMode:
        normalizedPolicy.mode === "separate" && String(transport ?? "").trim().toLowerCase() === "bot"
          ? "separate"
          : normalizedPolicy.mode === "hidden"
            ? "hidden"
            : "append",
    };
  }

  if (normalizedPolicy.mode === "hidden") {
    return {
      text: visibleText,
      thinkingContent: "",
      effectiveMode: "hidden",
    };
  }

  if (normalizedPolicy.mode === "append" || String(transport ?? "").trim().toLowerCase() === "agent") {
    return {
      text: buildWecomReasoningMergedText({
        text: visibleText,
        thinkingContent: reasoning,
        title: normalizedPolicy.title,
      }),
      thinkingContent: "",
      effectiveMode: normalizedPolicy.mode === "append" ? "append" : "append",
    };
  }

  return {
    text: visibleText,
    thinkingContent: reasoning,
    effectiveMode: "separate",
  };
}
