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
  assert.equal(groupCfg.triggerMode, "mention");
  assert.equal(core.shouldStripWecomGroupMentions(groupCfg), true);
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

test("group trigger mode supports keyword and direct", () => {
  const keywordCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupChat: {
        enabled: true,
        triggerMode: "keyword",
        triggerKeywords: ["机器人", "AI助手"],
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(keywordCfg.triggerMode, "keyword");
  assert.equal(core.shouldStripWecomGroupMentions(keywordCfg), false);
  assert.equal(core.shouldTriggerWecomGroupResponse("请机器人看一下", keywordCfg), true);
  assert.equal(core.shouldTriggerWecomGroupResponse("普通聊天", keywordCfg), false);

  const directCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupChat: {
        enabled: true,
        triggerMode: "direct",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(directCfg.triggerMode, "direct");
  assert.equal(core.shouldTriggerWecomGroupResponse("大家好", directCfg), true);
});

test("resolveWecomTarget parses user/group/party/tag", () => {
  assert.deepEqual(core.resolveWecomTarget("wecom:alice"), { toUser: "alice" });
  assert.deepEqual(core.resolveWecomTarget("group:wr123"), { chatId: "wr123" });
  assert.deepEqual(core.resolveWecomTarget("chat:wc456"), { chatId: "wc456" });
  assert.deepEqual(core.resolveWecomTarget("party:2"), { toParty: "2" });
  assert.deepEqual(core.resolveWecomTarget("dept:3"), { toParty: "3" });
  assert.deepEqual(core.resolveWecomTarget("tag:ops"), { toTag: "ops" });
  assert.deepEqual(core.resolveWecomTarget("user:bob"), { toUser: "bob" });
});

test("resolveWecomTarget parses webhook and heuristics", () => {
  assert.deepEqual(core.resolveWecomTarget("webhook:https://example.com/hook"), {
    webhook: "https://example.com/hook",
  });
  assert.deepEqual(core.resolveWecomTarget("wr-chat-id"), { chatId: "wr-chat-id" });
  assert.deepEqual(core.resolveWecomTarget("1234"), { toParty: "1234" });
  assert.equal(core.resolveWecomTarget(""), null);
});

test("normalizeWecomWebhookTargetMap parses object and env strings", () => {
  const fromObject = core.normalizeWecomWebhookTargetMap({
    Ops: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ops",
    Dev: "key:dev-key",
  });
  assert.deepEqual(fromObject, {
    ops: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ops",
    dev: "key:dev-key",
  });

  const fromEnv = core.normalizeWecomWebhookTargetMap("ops=key:111;dev=https://example.com/hook?key=xyz");
  assert.deepEqual(fromEnv, {
    ops: "key:111",
    dev: "https://example.com/hook?key=xyz",
  });

  const merged = core.normalizeWecomWebhookTargetMap(fromObject, "ops=key:override");
  assert.equal(merged.ops, "key:override");
  assert.equal(merged.dev, "key:dev-key");
});

test("resolveWecomWebhookTargetConfig resolves named webhook target", () => {
  const map = core.normalizeWecomWebhookTargetMap({
    ops: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ops",
    dev: "key:dev-key",
    ci: "dev",
  });

  assert.deepEqual(core.resolveWecomWebhookTargetConfig("ops", map), {
    url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ops",
  });
  assert.deepEqual(core.resolveWecomWebhookTargetConfig("dev", map), {
    key: "dev-key",
  });
  assert.deepEqual(core.resolveWecomWebhookTargetConfig("ci", map), {
    key: "dev-key",
  });
  assert.deepEqual(core.resolveWecomWebhookTargetConfig("key:plain-key", map), {
    key: "plain-key",
  });
  assert.deepEqual(
    core.resolveWecomWebhookTargetConfig("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=direct", map),
    { url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=direct" },
  );
  assert.equal(
    core.resolveWecomWebhookTargetConfig("a", { a: "b", b: "a" }),
    null,
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

test("resolveWecomBotModeConfig reads config and env fallback", () => {
  const fromConfig = core.resolveWecomBotModeConfig({
    channelConfig: {
      bot: {
        enabled: true,
        token: "bot-token",
        encodingAesKey: "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
        webhookPath: "/bot/hook",
        placeholderText: "thinking",
        streamExpireMs: 9999999,
        replyTimeoutMs: 9999999,
        lateReplyWatchMs: 9999999,
        lateReplyPollMs: 10,
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(fromConfig.enabled, true);
  assert.equal(fromConfig.token, "bot-token");
  assert.equal(fromConfig.webhookPath, "/bot/hook");
  assert.equal(fromConfig.placeholderText, "thinking");
  assert.equal(fromConfig.streamExpireMs, 60 * 60 * 1000);
  assert.equal(fromConfig.replyTimeoutMs, 10 * 60 * 1000);
  assert.equal(fromConfig.lateReplyWatchMs, 10 * 60 * 1000);
  assert.equal(fromConfig.lateReplyPollMs, 500);

  const fromEnv = core.resolveWecomBotModeConfig({
    channelConfig: {},
    envVars: {
      WECOM_BOT_ENABLED: "true",
      WECOM_BOT_TOKEN: "env-token",
      WECOM_BOT_ENCODING_AES_KEY: "env-aes-key",
      WECOM_BOT_WEBHOOK_PATH: "/env/bot",
      WECOM_BOT_PLACEHOLDER_TEXT: "处理中",
      WECOM_BOT_STREAM_EXPIRE_MS: "45000",
      WECOM_BOT_REPLY_TIMEOUT_MS: "180000",
      WECOM_BOT_LATE_REPLY_WATCH_MS: "60000",
      WECOM_BOT_LATE_REPLY_POLL_MS: "1500",
    },
    processEnv: {},
  });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.token, "env-token");
  assert.equal(fromEnv.encodingAesKey, "env-aes-key");
  assert.equal(fromEnv.webhookPath, "/env/bot");
  assert.equal(fromEnv.placeholderText, "处理中");
  assert.equal(fromEnv.streamExpireMs, 45000);
  assert.equal(fromEnv.replyTimeoutMs, 180000);
  assert.equal(fromEnv.lateReplyWatchMs, 60000);
  assert.equal(fromEnv.lateReplyPollMs, 1500);

  const fromSharedEnv = core.resolveWecomBotModeConfig({
    channelConfig: {},
    envVars: {
      WECOM_REPLY_TIMEOUT_MS: "70000",
    },
    processEnv: {},
  });
  assert.equal(fromSharedEnv.replyTimeoutMs, 70000);

  const explicitEmpty = core.resolveWecomBotModeConfig({
    channelConfig: {
      bot: {
        enabled: true,
        placeholderText: "",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(explicitEmpty.placeholderText, "");
});

test("resolveWecomBotModeConfig supports account-scoped bot config and legacy keys", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      accounts: {
        sales: {
          bot: {
            enabled: true,
            callbackToken: "sales-callback-token",
            callbackAesKey: "sales-callback-aes",
            webhookPath: "/wecom/sales/bot/callback",
            placeholderText: "sales processing",
          },
        },
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(cfg.accountId, "sales");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.token, "sales-callback-token");
  assert.equal(cfg.encodingAesKey, "sales-callback-aes");
  assert.equal(cfg.webhookPath, "/wecom/sales/bot/callback");
  assert.equal(cfg.placeholderText, "sales processing");
});

test("resolveWecomBotModeAccountsConfig includes config/env scoped bot accounts", () => {
  const configs = core.resolveWecomBotModeAccountsConfig({
    channelConfig: {
      bot: {
        enabled: true,
        token: "default-token",
        encodingAesKey: "default-aes",
      },
      accounts: {
        sales: {
          enabled: true,
          bot: {
            enabled: true,
            token: "sales-token",
            encodingAesKey: "sales-aes",
            webhookPath: "/wecom/sales/bot/callback",
          },
        },
        hr: {
          enabled: true,
          webhookPath: "/wecom/hr/callback",
        },
      },
    },
    envVars: {
      WECOM_OPS_BOT_ENABLED: "true",
      WECOM_OPS_BOT_TOKEN: "ops-token",
      WECOM_OPS_BOT_ENCODING_AES_KEY: "ops-aes",
      WECOM_OPS_BOT_WEBHOOK_PATH: "/wecom/ops/bot/callback",
    },
    processEnv: {},
  });
  const byAccount = new Map(configs.map((item) => [item.accountId, item]));
  assert.equal(byAccount.get("default")?.token, "default-token");
  assert.equal(byAccount.get("sales")?.token, "sales-token");
  assert.equal(byAccount.get("sales")?.webhookPath, "/wecom/sales/bot/callback");
  assert.equal(byAccount.get("ops")?.token, "ops-token");
  assert.equal(byAccount.get("ops")?.webhookPath, "/wecom/ops/bot/callback");
  assert.equal(byAccount.has("hr"), false);
});

test("resolveWecomDeliveryFallbackConfig defaults and normalization", () => {
  const defaults = core.resolveWecomDeliveryFallbackConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.order, ["active_stream", "response_url", "webhook_bot", "agent_push"]);

  const configured = core.resolveWecomDeliveryFallbackConfig({
    channelConfig: {
      delivery: {
        fallback: {
          enabled: true,
          order: ["response-url", "webhook", "agent"],
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(configured.enabled, true);
  assert.deepEqual(configured.order, ["response_url", "webhook_bot", "agent_push"]);
});

test("resolveWecomWebhookBotDeliveryConfig reads config and env", () => {
  const fromConfig = core.resolveWecomWebhookBotDeliveryConfig({
    channelConfig: {
      webhookBot: {
        enabled: true,
        url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=config",
        timeoutMs: 12000,
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(fromConfig.enabled, true);
  assert.equal(fromConfig.url, "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=config");
  assert.equal(fromConfig.timeoutMs, 12000);

  const fromEnv = core.resolveWecomWebhookBotDeliveryConfig({
    channelConfig: {},
    envVars: {
      WECOM_WEBHOOK_BOT_ENABLED: "true",
      WECOM_WEBHOOK_BOT_KEY: "env-key",
      WECOM_WEBHOOK_BOT_TIMEOUT_MS: "500",
    },
    processEnv: {},
  });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.key, "env-key");
  // min bound
  assert.equal(fromEnv.timeoutMs, 1000);
});

test("resolveWecomStreamManagerConfig applies bounds", () => {
  const cfg = core.resolveWecomStreamManagerConfig({
    channelConfig: {
      stream: {
        manager: {
          enabled: true,
          timeoutMs: 999999999,
          maxConcurrentPerSession: 0,
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.timeoutMs, 10 * 60 * 1000);
  assert.equal(cfg.maxConcurrentPerSession, 1);
});

test("resolveWecomObservabilityConfig reads env fallback", () => {
  const cfg = core.resolveWecomObservabilityConfig({
    channelConfig: {},
    envVars: {
      WECOM_OBSERVABILITY_ENABLED: "false",
      WECOM_OBSERVABILITY_PAYLOAD_META: "off",
    },
    processEnv: {},
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.logPayloadMeta, false);
});

test("resolveWecomDynamicAgentConfig parses user/group/mention maps", () => {
  const cfg = core.resolveWecomDynamicAgentConfig({
    channelConfig: {
      dynamicAgent: {
        enabled: true,
        defaultAgentId: "main",
        userMap: {
          alice: "sales",
        },
        groupMap: {
          chat_1: "ops",
        },
        mentionMap: {
          "ai助手": "helper",
        },
        adminUsers: ["Root"],
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, "deterministic");
  assert.equal(cfg.autoProvision, true);
  assert.equal(cfg.allowUnknownAgentId, true);
  assert.equal(cfg.defaultAgentId, "main");
  assert.equal(cfg.userMap.alice, "sales");
  assert.equal(cfg.groupMap.chat_1, "ops");
  assert.equal(cfg.mentionMap["ai助手"], "helper");
  assert.deepEqual(cfg.adminUsers, ["root"]);
  assert.equal(cfg.forceAgentSessionKey, true);
});

test("resolveWecomDynamicAgentConfig reads env map strings", () => {
  const cfg = core.resolveWecomDynamicAgentConfig({
    channelConfig: {},
    envVars: {
      WECOM_DYNAMIC_AGENT_ENABLED: "true",
      WECOM_DYNAMIC_AGENT_MODE: "hybrid",
      WECOM_DYNAMIC_AGENT_USER_MAP: "tom=sales,jerry:ops",
      WECOM_DYNAMIC_AGENT_GROUP_MAP: "g1=support",
      WECOM_DYNAMIC_AGENT_MENTION_MAP: "ai助手=helper",
      WECOM_DYNAMIC_AGENT_ADMIN_USERS: "AdminA,AdminB",
      WECOM_DYNAMIC_AGENT_FORCE_SESSION_KEY: "false",
    },
    processEnv: {},
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, "hybrid");
  assert.equal(cfg.userMap.tom, "sales");
  assert.equal(cfg.userMap.jerry, "ops");
  assert.equal(cfg.groupMap.g1, "support");
  assert.equal(cfg.mentionMap["ai助手"], "helper");
  assert.deepEqual(cfg.adminUsers.sort(), ["admina", "adminb"]);
  assert.equal(cfg.forceAgentSessionKey, false);
});
