import assert from "node:assert/strict";
import test from "node:test";

import * as core from "../src/core.js";

test("buildWecomSessionId normalizes user id", () => {
  assert.equal(core.buildWecomSessionId(" DingXiang "), "wecom:dingxiang");
  assert.equal(core.buildWecomSessionId(""), "wecom:");
});

test("inbound dedupe keeps first message and rejects duplicate", () => {
  core.resetInboundMessageDedupeForTests();
  const msg = {
    MsgId: "123456",
    FromUserName: "user_a",
    CreateTime: "1700000000",
    MsgType: "text",
    Content: "hello",
  };
  assert.equal(core.markInboundMessageSeen(msg, "default"), true);
  assert.equal(core.markInboundMessageSeen(msg, "default"), false);
  assert.equal(core.markInboundMessageSeen(msg, "other"), true);
});

test("splitWecomText preserves content and stays within byte limit", () => {
  const input = "第一行\n\n第二行 with spaces    \n第三行。".repeat(40);
  const chunks = core.splitWecomText(input, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(core.getByteLength(chunk) <= 200);
  }
  assert.equal(chunks.join(""), input);
});

test("pickAccountBySignature selects account by token", () => {
  const timestamp = "1700000000";
  const nonce = "abc123";
  const encrypt = "cipher_payload";
  const accounts = [
    { accountId: "a", callbackToken: "token-a", callbackAesKey: "aes-a" },
    { accountId: "b", callbackToken: "token-b", callbackAesKey: "aes-b" },
  ];
  const targetSignature = core.computeMsgSignature({
    token: "token-b",
    timestamp,
    nonce,
    encrypt,
  });
  const matched = core.pickAccountBySignature({
    accounts,
    msgSignature: targetSignature,
    timestamp,
    nonce,
    encrypt,
  });
  assert.equal(matched?.accountId, "b");
});

test("resolveVoiceTranscriptionConfig uses defaults", () => {
  const voice = core.resolveVoiceTranscriptionConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(voice.enabled, true);
  assert.equal(voice.provider, "local-whisper-cli");
  assert.equal(voice.model, "base");
  assert.equal(voice.timeoutMs, 120000);
  assert.equal(voice.maxBytes, 10 * 1024 * 1024);
});

test("resolveVoiceTranscriptionConfig reads command/model settings", () => {
  const fromConfig = core.resolveVoiceTranscriptionConfig({
    channelConfig: {
      voiceTranscription: {
        provider: "local-whisper",
        command: "whisper",
        model: "large-v3",
        modelPath: "/models/ggml-base.bin",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(fromConfig.provider, "local-whisper");
  assert.equal(fromConfig.command, "whisper");
  assert.equal(fromConfig.model, "large-v3");
  assert.equal(fromConfig.modelPath, "/models/ggml-base.bin");

  const fromEnv = core.resolveVoiceTranscriptionConfig({
    channelConfig: {
      voiceTranscription: {
        provider: "local-whisper-cli",
      },
    },
    envVars: {
      WECOM_VOICE_TRANSCRIBE_MODEL_PATH: "/models/env.ggml",
      WECOM_VOICE_TRANSCRIBE_COMMAND: "whisper-cli",
    },
    processEnv: {
      WHISPER_MODEL_PATH: "/models/fallback.ggml",
    },
  });
  assert.equal(fromEnv.command, "whisper-cli");
  assert.equal(fromEnv.modelPath, "/models/env.ggml");
});

test("audio content type support helpers work for stt", () => {
  assert.equal(core.isLocalVoiceInputTypeDirectlySupported("audio/wav"), true);
  assert.equal(core.isLocalVoiceInputTypeDirectlySupported("audio/amr"), false);
  assert.equal(core.normalizeAudioContentType(" audio/mpeg; charset=utf-8 "), "audio/mpeg");
  assert.equal(
    core.pickAudioFileExtension({ contentType: "audio/mpeg" }),
    ".mp3",
  );
  assert.equal(
    core.pickAudioFileExtension({ fileName: "voice.amr" }),
    ".amr",
  );
});
