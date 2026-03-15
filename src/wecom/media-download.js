import { join } from "node:path";
import { smartDecryptWecomFileBuffer } from "./media-download-decrypt.js";
import { buildMediaFetchErrorMessage } from "./media-download-errors.js";
import {
  extractFilenameFromContentDisposition,
  extractFilenameFromUrl,
  inferFilenameFromMediaDownload,
  pickExtensionFromContentType,
  sanitizeWecomFileName,
} from "./media-download-filename.js";
import {
  detectMagicFileExtension,
  isLikelyTextContentType,
  isLikelyUtf8TextBuffer,
  looksLikePlainFileBuffer,
} from "./media-download-plain.js";

export {
  buildMediaFetchErrorMessage,
  detectMagicFileExtension,
  extractFilenameFromContentDisposition,
  extractFilenameFromUrl,
  inferFilenameFromMediaDownload,
  isLikelyTextContentType,
  isLikelyUtf8TextBuffer,
  looksLikePlainFileBuffer,
  pickExtensionFromContentType,
  sanitizeWecomFileName,
  smartDecryptWecomFileBuffer,
};

export function extractWorkspacePathsFromText(text, maxCount = 8) {
  const raw = String(text ?? "");
  if (!raw) return [];
  const matches = raw.match(/(?:(?:MEDIA|FILE):\s*)?(\/workspace\/[^\s"'`<>()，。；：！？、]+)/gi) ?? [];
  const dedupe = new Set();
  const out = [];
  for (const chunk of matches) {
    const normalized = String(chunk)
      .replace(/^(?:MEDIA|FILE):\s*/i, "")
      .replace(/[.,;:!?。，；：！？）》」』\]]+$/, "")
      .trim();
    if (!normalized.startsWith("/workspace/")) continue;
    if (dedupe.has(normalized)) continue;
    dedupe.add(normalized);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxCount) || 8)) break;
  }
  return out;
}

export function resolveWorkspacePathToHost({ workspacePath, agentId, homeDir = process.env.HOME } = {}) {
  const rawPath = String(workspacePath ?? "").trim();
  const normalizedAgentId = String(agentId ?? "").trim();
  const normalizedHome = String(homeDir ?? "").trim();
  if (!rawPath.startsWith("/workspace/") || !normalizedAgentId || !normalizedHome) return "";
  const relative = rawPath.slice("/workspace/".length);
  if (!relative) return "";
  const safeSegments = relative
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
  if (safeSegments.length === 0) return "";
  return join(normalizedHome, ".openclaw", `workspace-${normalizedAgentId}`, ...safeSegments);
}

export function buildTinyFileFallbackText({ fileName, buffer, maxBase64Chars = 120 } = {}) {
  const safeName = sanitizeWecomFileName(fileName, "file");
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from([]);
  const size = body.length;
  if (size === 0) {
    return `📄 文件「${safeName}」大小为 0 字节，已按文本回传。`;
  }

  if (isLikelyUtf8TextBuffer(body)) {
    const plainText = body.toString("utf8").trim() || "(空文本)";
    return `📄 文件「${safeName}」内容过小（${size} bytes），已按文本回传：\n${plainText}`;
  }

  const preview = body.toString("base64").slice(0, Math.max(32, Number(maxBase64Chars) || 120));
  return `📄 文件「${safeName}」内容过小（${size} bytes），二进制内容预览(base64)：\n${preview}`;
}
