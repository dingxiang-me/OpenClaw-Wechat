const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought)\b/i;
const THINK_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi;

function isInsideRegion(pos, regions) {
  for (const [start, end] of regions) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

function findCodeRegions(text) {
  const regions = [];
  const blockRe = /```[\s\S]*?```/g;
  for (const match of text.matchAll(blockRe)) {
    regions.push([match.index, match.index + match[0].length]);
  }
  const inlineRe = /`[^`\n]+`/g;
  for (const match of text.matchAll(inlineRe)) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push([match.index, match.index + match[0].length]);
    }
  }
  return regions;
}

export function parseThinkingContent(text) {
  if (!text) {
    return { visibleContent: "", thinkingContent: "", isThinking: false };
  }

  const input = String(text);
  if (!QUICK_TAG_RE.test(input)) {
    return { visibleContent: input, thinkingContent: "", isThinking: false };
  }

  const codeRegions = findCodeRegions(input);
  const visibleParts = [];
  const thinkingParts = [];
  let lastIndex = 0;
  let inThinking = false;

  THINK_TAG_RE.lastIndex = 0;
  for (const match of input.matchAll(THINK_TAG_RE)) {
    const idx = match.index;
    const isClose = match[1] === "/";
    if (isInsideRegion(idx, codeRegions)) continue;

    const segment = input.slice(lastIndex, idx);
    if (!inThinking) {
      visibleParts.push(segment);
      if (!isClose) {
        inThinking = true;
      }
    } else if (isClose) {
      thinkingParts.push(segment);
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  const remaining = input.slice(lastIndex);
  if (inThinking) {
    thinkingParts.push(remaining);
  } else {
    visibleParts.push(remaining);
  }

  return {
    visibleContent: visibleParts.join("").replace(/\n{3,}/g, "\n\n").trim(),
    thinkingContent: thinkingParts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    isThinking: inThinking,
  };
}
