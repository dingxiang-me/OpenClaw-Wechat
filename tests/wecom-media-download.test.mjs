import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTinyFileFallbackText,
  buildMediaFetchErrorMessage,
  detectMagicFileExtension,
  extractWorkspacePathsFromText,
  inferFilenameFromMediaDownload,
  resolveWorkspacePathToHost,
  smartDecryptWecomFileBuffer,
} from "../src/wecom/media-download.js";

test("inferFilenameFromMediaDownload prefers content-disposition filename*", () => {
  const name = inferFilenameFromMediaDownload({
    explicitName: "",
    contentDisposition: "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.pdf",
    sourceUrl: "https://example.com/download?id=1",
    contentType: "application/pdf",
  });
  assert.equal(name, "测试文档.pdf");
});

test("inferFilenameFromMediaDownload falls back to url and content-type extension", () => {
  const name = inferFilenameFromMediaDownload({
    explicitName: "",
    contentDisposition: "",
    sourceUrl: "https://example.com/api/export?name=report",
    contentType: "text/csv; charset=utf-8",
  });
  assert.equal(name, "report.csv");
});

test("detectMagicFileExtension recognizes png magic bytes", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectMagicFileExtension(png), ".png");
});

test("smartDecryptWecomFileBuffer keeps plain file bytes", () => {
  const plainPdf = Buffer.from("%PDF-1.7\nhello");
  let decryptCalled = false;
  const result = smartDecryptWecomFileBuffer({
    buffer: plainPdf,
    aesKey: "ignored",
    contentType: "application/pdf",
    sourceUrl: "https://example.com/f.pdf",
    decryptFn: () => {
      decryptCalled = true;
      return Buffer.from("never");
    },
  });
  assert.equal(result.decrypted, false);
  assert.equal(result.reason, "plain-buffer");
  assert.equal(decryptCalled, false);
  assert.equal(result.buffer.equals(plainPdf), true);
});

test("smartDecryptWecomFileBuffer uses decrypted bytes when decrypted content looks plain", () => {
  const encryptedLike = Buffer.from([0x03, 0x6a, 0x90, 0xfe, 0x44, 0x11, 0x00, 0xaa]);
  const decryptedPdf = Buffer.from("%PDF-1.4\ncontent");
  const result = smartDecryptWecomFileBuffer({
    buffer: encryptedLike,
    aesKey: "dummy-aes-key",
    contentType: "application/octet-stream",
    sourceUrl: "https://example.com/file",
    decryptFn: () => decryptedPdf,
  });
  assert.equal(result.decrypted, true);
  assert.equal(result.reason, "decrypt-plain-detected");
  assert.equal(result.buffer.equals(decryptedPdf), true);
});

test("smartDecryptWecomFileBuffer falls back to raw when decrypt throws", () => {
  const encryptedLike = Buffer.from([0x02, 0x11, 0x38, 0x77, 0x42, 0xa9, 0x11, 0x29]);
  const result = smartDecryptWecomFileBuffer({
    buffer: encryptedLike,
    aesKey: "dummy-aes-key",
    contentType: "application/octet-stream",
    sourceUrl: "https://example.com/file",
    decryptFn: () => {
      throw new Error("decrypt failed");
    },
    logger: {
      warn() {},
    },
  });
  assert.equal(result.decrypted, false);
  assert.equal(result.reason, "decrypt-failed");
  assert.equal(result.buffer.equals(encryptedLike), true);
});

test("buildMediaFetchErrorMessage includes status and metadata", () => {
  const message = buildMediaFetchErrorMessage({
    url: "https://example.com/file",
    status: 403,
    statusText: "Forbidden",
    contentType: "application/json",
    bodyPreview: "{\"errcode\": 123}",
  });
  assert.match(message, /download media failed/);
  assert.match(message, /403/);
  assert.match(message, /Forbidden/);
  assert.match(message, /content-type=application\/json/);
  assert.match(message, /url=https:\/\/example.com\/file/);
});

test("extractWorkspacePathsFromText finds and dedupes workspace paths", () => {
  const paths = extractWorkspacePathsFromText(
    "请发送 /workspace/out/report.pdf 和 MEDIA:/workspace/out/report.pdf，还有 FILE:/workspace/logs/run.txt。",
  );
  assert.deepEqual(paths, ["/workspace/out/report.pdf", "/workspace/logs/run.txt"]);
});

test("resolveWorkspacePathToHost maps sandbox path to host workspace", () => {
  const host = resolveWorkspacePathToHost({
    workspacePath: "/workspace/output/result.csv",
    agentId: "wecom-dm-sales-alice",
    homeDir: "/Users/dingxiang",
  });
  assert.equal(host, "/Users/dingxiang/.openclaw/workspace-wecom-dm-sales-alice/output/result.csv");
});

test("buildTinyFileFallbackText renders tiny text file content", () => {
  const text = buildTinyFileFallbackText({
    fileName: "tiny.txt",
    buffer: Buffer.from("ok", "utf8"),
  });
  assert.match(text, /tiny\.txt/);
  assert.match(text, /2 bytes/);
  assert.match(text, /ok/);
});
