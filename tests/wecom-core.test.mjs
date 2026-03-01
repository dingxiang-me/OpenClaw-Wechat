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

test("resolveWecomProxyConfig prefers account config over channel/env", () => {
  const proxy = core.resolveWecomProxyConfig({
    channelConfig: {
      outboundProxy: "http://channel-proxy:7890",
    },
    accountConfig: {
      outboundProxy: "http://account-proxy:8899",
    },
    envVars: {
      WECOM_PROXY: "http://env-proxy:7890",
    },
    processEnv: {},
    accountId: "default",
  });
  assert.equal(proxy, "http://account-proxy:8899");
});

test("resolveWecomProxyConfig supports account-specific env fallback", () => {
  const proxy = core.resolveWecomProxyConfig({
    channelConfig: {},
    accountConfig: {},
    envVars: {
      WECOM_SALES_PROXY: "http://sales-proxy:8080",
      WECOM_PROXY: "http://global-proxy:7890",
    },
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(proxy, "http://sales-proxy:8080");
});

test("extractLeadingSlashCommand normalizes command key", () => {
  assert.equal(core.extractLeadingSlashCommand("/STATUS"), "/status");
  assert.equal(core.extractLeadingSlashCommand(" /new  test"), "/new");
  assert.equal(core.extractLeadingSlashCommand("hello"), "");
});

test("resolveWecomCommandPolicyConfig reads admin and allowlist", () => {
  const policy = core.resolveWecomCommandPolicyConfig({
    channelConfig: {
      adminUsers: ["Alice", "Bob"],
      commands: {
        enabled: true,
        allowlist: ["status", "/new", " /compact "],
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.allowlist.sort(), ["/compact", "/new", "/status"].sort());
  assert.deepEqual(policy.adminUsers.sort(), ["alice", "bob"]);
});

test("allowFrom policy resolves account override and env fallback", () => {
  const accountPolicy = core.resolveWecomAllowFromPolicyConfig({
    channelConfig: {
      allowFrom: ["wecom:global_user"],
      allowFromRejectMessage: "全局拦截",
    },
    accountConfig: {
      allowFrom: ["user:Alice", "wecom:Bob"],
      allowFromRejectMessage: "账户拦截",
    },
    envVars: {
      WECOM_ALLOW_FROM: "*",
    },
    processEnv: {},
    accountId: "sales",
  });
  assert.deepEqual(accountPolicy.allowFrom.sort(), ["alice", "bob"]);
  assert.equal(accountPolicy.rejectMessage, "账户拦截");

  const envPolicy = core.resolveWecomAllowFromPolicyConfig({
    channelConfig: {},
    accountConfig: {},
    envVars: {
      WECOM_SALES_ALLOW_FROM: "wecom:Tom,user:Jerry",
      WECOM_ALLOW_FROM: "*",
      WECOM_SALES_ALLOW_FROM_REJECT_MESSAGE: "销售账号未授权",
    },
    processEnv: {},
    accountId: "sales",
  });
  assert.deepEqual(envPolicy.allowFrom.sort(), ["jerry", "tom"]);
  assert.equal(envPolicy.rejectMessage, "销售账号未授权");
});

test("isWecomSenderAllowed matches normalized sender ids", () => {
  assert.equal(core.isWecomSenderAllowed({ senderId: "wecom:Alice", allowFrom: ["user:alice"] }), true);
  assert.equal(core.isWecomSenderAllowed({ senderId: "Bob", allowFrom: ["alice"] }), false);
  assert.equal(core.isWecomSenderAllowed({ senderId: "Tom", allowFrom: [] }), true);
  assert.equal(core.isWecomSenderAllowed({ senderId: "Tom", allowFrom: ["*"] }), true);
});

test("group mention helpers trigger and strip correctly", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupChat: {
        enabled: true,
        requireMention: true,
        mentionPatterns: ["@", "@AI助手"],
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(core.shouldTriggerWecomGroupResponse("@AI助手 /status", groupCfg), true);
  assert.equal(core.shouldTriggerWecomGroupResponse("请看下 test@example.com", groupCfg), false);
  assert.equal(core.shouldTriggerWecomGroupResponse("你好@AI助手 帮我看下", groupCfg), true);
  assert.equal(core.shouldTriggerWecomGroupResponse("普通文本", groupCfg), false);
  assert.equal(core.stripWecomGroupMentions("@AI助手 /status", groupCfg.mentionPatterns), "/status");
  assert.equal(
    core.stripWecomGroupMentions("邮箱 test@example.com @AI助手 /status", groupCfg.mentionPatterns),
    "邮箱 test@example.com /status",
  );
});

test("resolveWecomDebounceConfig applies bounds and defaults", () => {
  const debounce = core.resolveWecomDebounceConfig({
    channelConfig: {
      debounce: {
        enabled: true,
        windowMs: 20,
        maxBatch: 99,
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(debounce.enabled, true);
  assert.equal(debounce.windowMs, 100);
  assert.equal(debounce.maxBatch, 50);
});

test("resolveWecomStreamingConfig applies bounds and env fallback", () => {
  const fromConfig = core.resolveWecomStreamingConfig({
    channelConfig: {
      streaming: {
        enabled: true,
        minChars: 1,
        minIntervalMs: 999999,
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(fromConfig.enabled, true);
  assert.equal(fromConfig.minChars, 20);
  assert.equal(fromConfig.minIntervalMs, 10000);

  const fromEnv = core.resolveWecomStreamingConfig({
    channelConfig: {},
    envVars: {
      WECOM_STREAMING_ENABLED: "true",
      WECOM_STREAMING_MIN_CHARS: "180",
      WECOM_STREAMING_MIN_INTERVAL_MS: "1500",
    },
    processEnv: {},
  });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.minChars, 180);
  assert.equal(fromEnv.minIntervalMs, 1500);
});
