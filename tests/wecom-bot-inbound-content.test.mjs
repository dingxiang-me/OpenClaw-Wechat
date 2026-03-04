import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotInboundContentBuilder } from "../src/wecom/bot-inbound-content.js";

function createBuilder(overrides = {}) {
  return createWecomBotInboundContentBuilder({
    fetchMediaFromUrl: async () => {
      throw new Error("unexpected fetch");
    },
    detectImageContentTypeFromBuffer: () => "image/png",
    decryptWecomMediaBuffer: ({ encryptedBuffer }) => encryptedBuffer,
    pickImageFileExtension: () => ".png",
    resolveWecomVoiceTranscriptionConfig: () => ({ enabled: false, maxBytes: 10 * 1024 * 1024 }),
    transcribeInboundVoice: async () => "voice text",
    inferFilenameFromMediaDownload: ({ explicitName }) => explicitName || "file.bin",
    smartDecryptWecomFileBuffer: ({ buffer }) => ({ buffer, decrypted: false }),
    basename: (name) => String(name ?? "").split("/").pop(),
    mkdir: async () => {},
    tmpdir: () => "/tmp",
    join: (...parts) => parts.join("/"),
    writeFile: async () => {},
    WECOM_TEMP_DIR_NAME: "openclaw-wecom",
    ...overrides,
  });
}

test("buildBotInboundContent keeps plain text", async () => {
  const build = createBuilder();
  const result = await build({
    api: { logger: {} },
    msgType: "text",
    commandBody: "hello",
    normalizedImageUrls: [],
  });
  assert.equal(result.aborted, false);
  assert.equal(result.abortText, "");
  assert.equal(result.messageText, "hello");
  assert.deepEqual(result.tempPathsToCleanup, []);
});

test("buildBotInboundContent aborts when image download fails and no text", async () => {
  const build = createBuilder({
    fetchMediaFromUrl: async () => {
      throw new Error("download failed");
    },
  });
  const result = await build({
    api: { logger: { warn() {} } },
    msgType: "image",
    commandBody: "",
    normalizedImageUrls: ["https://example.com/a.png"],
  });
  assert.equal(result.aborted, true);
  assert.match(result.abortText, /图片接收失败/);
});

test("buildBotInboundContent prepends quoted message", async () => {
  const build = createBuilder();
  const result = await build({
    api: { logger: {} },
    msgType: "text",
    commandBody: "回复内容",
    normalizedQuote: { msgType: "text", content: "上一条" },
  });
  assert.equal(result.aborted, false);
  assert.equal(result.messageText, "> 上一条\n\n回复内容");
});

test("buildBotInboundContent returns file fallback text when file download fails", async () => {
  const build = createBuilder({
    fetchMediaFromUrl: async () => {
      throw new Error("download failed");
    },
  });
  const result = await build({
    api: { logger: { warn() {} } },
    msgType: "file",
    commandBody: "",
    normalizedFileUrl: "https://example.com/a.pdf",
    normalizedFileName: "a.pdf",
  });
  assert.equal(result.aborted, false);
  assert.match(result.messageText, /下载失败/);
});

test("buildBotInboundContent transcribes voice from downloadable voice url", async () => {
  const calls = [];
  const build = createBuilder({
    fetchMediaFromUrl: async (url, options) => {
      calls.push({ url, options });
      return {
        buffer: Buffer.from("voice-bytes"),
        contentType: "audio/amr",
      };
    },
    resolveWecomVoiceTranscriptionConfig: () => ({
      enabled: true,
      maxBytes: 4 * 1024 * 1024,
    }),
    transcribeInboundVoice: async ({ mediaId, contentType }) => `voice:${mediaId}:${contentType}`,
  });
  const result = await build({
    api: { logger: {} },
    msgType: "voice",
    normalizedVoiceUrl: "https://example.com/voice.amr",
    normalizedVoiceMediaId: "voice-1",
    normalizedVoiceContentType: "audio/amr",
  });
  assert.equal(result.aborted, false);
  assert.match(result.messageText, /\[用户发送了一条语音\]/);
  assert.match(result.messageText, /voice:voice-1:audio\/amr/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/voice.amr");
});

test("buildBotInboundContent aborts when voice transcription fails", async () => {
  const build = createBuilder({
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("voice-bytes"),
      contentType: "audio/amr",
    }),
    resolveWecomVoiceTranscriptionConfig: () => ({
      enabled: true,
      maxBytes: 4 * 1024 * 1024,
    }),
    transcribeInboundVoice: async () => {
      throw new Error("stt failed");
    },
  });
  const result = await build({
    api: { logger: { warn() {} } },
    msgType: "voice",
    normalizedVoiceUrl: "https://example.com/voice.amr",
    normalizedVoiceMediaId: "voice-2",
  });
  assert.equal(result.aborted, true);
  assert.match(result.abortText, /语音识别失败/);
});
