import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWecomVoiceTranscriber } from "../src/wecom/voice-transcription.js";

function createTranscriber(overrides = {}) {
  return createWecomVoiceTranscriber({
    tempDirName: "openclaw-wechat-test",
    resolveVoiceTranscriptionConfig: ({ channelConfig }) => ({
      enabled: Boolean(channelConfig?.voiceTranscription?.enabled),
      provider: "local-whisper-cli",
      command: "whisper-cli",
      maxBytes: 1024,
      transcodeToWav: true,
      ffmpegEnabled: true,
      timeoutMs: 15000,
      requireModelPath: true,
      modelPath: "./model.bin",
      model: "base",
      language: "zh",
      prompt: "",
    }),
    normalizeAudioContentType: (v) => String(v ?? "").trim().toLowerCase(),
    isLocalVoiceInputTypeDirectlySupported: (v) => ["audio/wav", "audio/x-wav", "audio/amr", "audio/mpeg"].includes(v),
    pickAudioFileExtension: ({ contentType }) => {
      const t = String(contentType ?? "");
      if (t.includes("wav")) return ".wav";
      if (t.includes("amr")) return ".amr";
      if (t.includes("mpeg")) return ".mp3";
      return ".bin";
    },
    processEnv: {},
    ...overrides,
  });
}

test("resolveWecomVoiceTranscriptionConfig reads api config", () => {
  const transcriber = createTranscriber();
  const cfg = transcriber.resolveWecomVoiceTranscriptionConfig({
    config: {
      channels: { wecom: { voiceTranscription: { enabled: true } } },
      env: { vars: {} },
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.provider, "local-whisper-cli");
});

test("resolveLocalWhisperCommand falls back when explicit command unavailable", async () => {
  const transcriber = createTranscriber({
    checkCommandAvailableImpl: async (cmd) => cmd === "whisper",
  });

  const command = await transcriber.__internal.resolveLocalWhisperCommand({
    voiceConfig: {
      provider: "local-whisper",
      command: "custom-whisper",
    },
    logger: { warn() {} },
  });
  assert.equal(command, "whisper");
});

test("resolveLocalWhisperCommand discovers macOS user-bin whisper fallback", async () => {
  const transcriber = createTranscriber({
    processEnv: {
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
    },
    checkCommandAvailableImpl: async (cmd) => cmd === "/Users/tester/Library/Python/3.11/bin/whisper",
  });

  const command = await transcriber.__internal.resolveLocalWhisperCommand({
    voiceConfig: {
      provider: "local-whisper",
      command: "whisper",
    },
    logger: { warn() {} },
  });
  assert.equal(command, "/Users/tester/Library/Python/3.11/bin/whisper");
});

test("inspectWecomVoiceTranscriptionRuntime reports missing command and ffmpeg", async () => {
  const transcriber = createTranscriber({
    checkCommandAvailableImpl: async () => false,
    processEnv: {
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
    },
  });

  const info = await transcriber.inspectWecomVoiceTranscriptionRuntime({
    api: { logger: { warn() {} } },
    voiceConfig: {
      enabled: true,
      provider: "local-whisper-cli",
      command: "custom-whisper",
      ffmpegEnabled: true,
      requireModelPath: true,
      modelPath: "",
    },
  });

  assert.equal(info.enabled, true);
  assert.equal(info.resolvedCommand, "");
  assert.equal(info.ffmpegAvailable, false);
  assert.ok(info.commandCandidates.includes("custom-whisper"));
  assert.ok(info.commandCandidates.includes("whisper-cli"));
  assert.ok(info.commandCandidates.includes("/Users/tester/Library/Python/3.11/bin/whisper-cli"));
  assert.match(info.issues.join(" | "), /no available command in PATH/);
  assert.match(info.issues.join(" | "), /modelPath is required/);
  assert.match(info.issues.join(" | "), /ffmpeg not available/);
});

test("transcribeInboundVoice throws when disabled", async () => {
  const transcriber = createTranscriber();
  await assert.rejects(
    transcriber.transcribeInboundVoice({
      api: { logger: { warn() {}, info() {}, error() {} } },
      buffer: Buffer.from("abc"),
      contentType: "audio/wav",
      mediaId: "m1",
      voiceConfig: { enabled: false },
    }),
    /disabled/,
  );
});

test("transcribeInboundVoice enforces maxBytes", async () => {
  const transcriber = createTranscriber();
  await assert.rejects(
    transcriber.transcribeInboundVoice({
      api: { logger: { warn() {}, info() {}, error() {} } },
      buffer: Buffer.alloc(2048, 1),
      contentType: "audio/wav",
      mediaId: "m1",
      voiceConfig: {
        enabled: true,
        maxBytes: 100,
        transcodeToWav: false,
        ffmpegEnabled: true,
        provider: "local-whisper",
        command: "whisper",
        timeoutMs: 1000,
        model: "base",
      },
    }),
    /exceeds maxBytes/,
  );
});

test("transcribeInboundVoice rejects unsupported type when ffmpeg disabled", async () => {
  const transcriber = createTranscriber({
    isLocalVoiceInputTypeDirectlySupported: () => false,
  });
  await assert.rejects(
    transcriber.transcribeInboundVoice({
      api: { logger: { warn() {}, info() {}, error() {} } },
      buffer: Buffer.from("abc"),
      contentType: "audio/ogg",
      mediaId: "m1",
      voiceConfig: {
        enabled: true,
        maxBytes: 1024,
        transcodeToWav: true,
        ffmpegEnabled: false,
        provider: "local-whisper",
        command: "whisper",
        timeoutMs: 1000,
        model: "base",
      },
    }),
    /ffmpegEnabled=false/,
  );
});

test("transcribeInboundVoice keeps temp audio until local whisper cli finishes", async () => {
  const transcriber = createTranscriber({
    checkCommandAvailableImpl: async (cmd) => cmd === "whisper-cli",
    runProcessWithTimeoutImpl: async ({ args }) => {
      const audioPath = args[args.indexOf("-f") + 1];
      const outputBase = args[args.indexOf("-of") + 1];
      await new Promise((resolve) => setTimeout(resolve, 0));
      await access(audioPath);
      const audioBuffer = await readFile(audioPath);
      assert.equal(audioBuffer.length > 0, true);
      await access(join(tmpdir(), "openclaw-wechat-test"));
      await writeFile(`${outputBase}.txt`, "测试转写", "utf8");
      return { stdout: "", stderr: "" };
    },
  });

  const result = await transcriber.transcribeInboundVoice({
    api: { logger: { warn() {}, info() {}, error() {} } },
    buffer: Buffer.from("voice-bytes"),
    contentType: "audio/wav",
    mediaId: "m-temp-1",
    voiceConfig: {
      enabled: true,
      maxBytes: 1024,
      transcodeToWav: false,
      ffmpegEnabled: true,
      provider: "local-whisper-cli",
      command: "whisper-cli",
      timeoutMs: 1000,
      modelPath: "./model.bin",
      requireModelPath: true,
      language: "zh",
    },
  });

  assert.equal(result, "测试转写");
});
