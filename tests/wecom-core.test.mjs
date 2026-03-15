import assert from "node:assert/strict";
import test from "node:test";

import * as core from "../src/core.js";

test("buildWecomSessionId normalizes user id", () => {
  assert.equal(core.buildWecomSessionId(" DingXiang "), "wecom:dingxiang");
  assert.equal(core.buildWecomSessionId(" DingXiang ", "sales"), "wecom:sales:dingxiang");
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

test("resolveWecomProxyConfig supports network compatibility aliases", () => {
  const proxy = core.resolveWecomProxyConfig({
    channelConfig: {
      network: {
        egressProxyUrl: "http://channel-egress:7890",
      },
    },
    accountConfig: {
      network: {
        egressProxyUrl: "http://account-egress:8080",
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.equal(proxy, "http://account-egress:8080");
});

test("resolveWecomApiBaseUrl supports account and network compatibility aliases", () => {
  const apiBaseUrl = core.resolveWecomApiBaseUrl({
    channelConfig: {
      network: {
        apiBaseUrl: "https://channel.wecom.internal",
      },
    },
    accountConfig: {
      network: {
        apiBaseUrl: "https://account.wecom.internal",
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(apiBaseUrl, "https://account.wecom.internal");
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

test("resolveWecomCommandPolicyConfig supports legacy commandAllowlist fields", () => {
  const policy = core.resolveWecomCommandPolicyConfig({
    channelConfig: {
      commandAllowlist: ["status", "/help"],
      commandBlockMessage: "legacy blocked",
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.allowlist.sort(), ["/help", "/status"]);
  assert.equal(policy.rejectMessage, "legacy blocked");
});

test("resolveWecomCommandPolicyConfig supports commands.blockMessage alias", () => {
  const policy = core.resolveWecomCommandPolicyConfig({
    channelConfig: {
      commands: {
        enabled: true,
        allowlist: ["/status"],
        blockMessage: "blocked by alias",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.allowlist, ["/status"]);
  assert.equal(policy.rejectMessage, "blocked by alias");
});

test("resolveWecomCommandPolicyConfig auto-enables when commands.allowlist exists", () => {
  const policy = core.resolveWecomCommandPolicyConfig({
    channelConfig: {
      commands: {
        allowlist: ["/new", "/status"],
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.allowlist.sort(), ["/new", "/status"]);
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

test("allowFrom policy supports dm.allowFrom compatibility keys", () => {
  const policy = core.resolveWecomAllowFromPolicyConfig({
    channelConfig: {
      dm: {
        allowFrom: ["wecom:legacy_dm_user"],
      },
    },
    accountConfig: {},
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.deepEqual(policy.allowFrom, ["legacy_dm_user"]);
});

test("resolveWecomDmPolicyConfig supports mode/allowlist/pairing and scoped env fallback", () => {
  const denyPolicy = core.resolveWecomDmPolicyConfig({
    channelConfig: {
      dm: {
        mode: "deny",
        rejectMessage: "私聊已关闭",
      },
    },
    accountConfig: {},
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.equal(denyPolicy.mode, "deny");
  assert.equal(denyPolicy.rejectMessage, "私聊已关闭");

  const allowlistPolicy = core.resolveWecomDmPolicyConfig({
    channelConfig: {
      dm: {
        mode: "allowlist",
      },
    },
    accountConfig: {
      dm: {
        allowFrom: ["wecom:Alice", "user:Bob"],
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(allowlistPolicy.mode, "allowlist");
  assert.deepEqual(allowlistPolicy.allowFrom.sort(), ["alice", "bob"]);

  const pairingPolicy = core.resolveWecomDmPolicyConfig({
    channelConfig: {
      dm: {
        mode: "pairing",
      },
    },
    accountConfig: {
      dm: {
        allowFrom: ["wecom:Alice"],
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.equal(pairingPolicy.mode, "pairing");
  assert.deepEqual(pairingPolicy.allowFrom, ["alice"]);
  assert.equal(pairingPolicy.rejectMessage, "当前私聊需先完成配对审批。");

  const scopedEnvPolicy = core.resolveWecomDmPolicyConfig({
    channelConfig: {},
    accountConfig: {},
    envVars: {
      WECOM_SALES_DM_POLICY: "pairing",
      WECOM_SALES_DM_ALLOW_FROM: "user:Tom,wecom:Jerry",
      WECOM_SALES_DM_REJECT_MESSAGE: "销售私聊未授权",
    },
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(scopedEnvPolicy.mode, "pairing");
  assert.deepEqual(scopedEnvPolicy.allowFrom.sort(), ["jerry", "tom"]);
  assert.equal(scopedEnvPolicy.rejectMessage, "销售私聊未授权");
});

test("resolveWecomEventPolicyConfig supports channel/account/env overrides", () => {
  const fromChannel = core.resolveWecomEventPolicyConfig({
    channelConfig: {
      events: {
        enabled: true,
        enterAgentWelcomeEnabled: true,
        enterAgentWelcomeText: "欢迎来到智能助手",
      },
    },
    accountConfig: {},
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.equal(fromChannel.enabled, true);
  assert.equal(fromChannel.enterAgentWelcomeEnabled, true);
  assert.equal(fromChannel.enterAgentWelcomeText, "欢迎来到智能助手");

  const fromAccount = core.resolveWecomEventPolicyConfig({
    channelConfig: {
      events: {
        enabled: true,
        enterAgentWelcomeEnabled: false,
      },
    },
    accountConfig: {
      events: {
        enterAgentWelcomeEnabled: true,
        enterAgentWelcomeText: "销售助手为你服务",
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(fromAccount.enterAgentWelcomeEnabled, true);
  assert.equal(fromAccount.enterAgentWelcomeText, "销售助手为你服务");

  const fromScopedEnv = core.resolveWecomEventPolicyConfig({
    channelConfig: {},
    accountConfig: {},
    envVars: {
      WECOM_SALES_EVENTS_ENABLED: "1",
      WECOM_SALES_EVENTS_ENTER_AGENT_WELCOME_ENABLED: "true",
      WECOM_SALES_EVENTS_ENTER_AGENT_WELCOME_TEXT: "Env 欢迎语",
    },
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(fromScopedEnv.enabled, true);
  assert.equal(fromScopedEnv.enterAgentWelcomeEnabled, true);
  assert.equal(fromScopedEnv.enterAgentWelcomeText, "Env 欢迎语");
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

test("resolveWecomGroupChatConfig supports account and per-group authorization overrides", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupChat: {
        enabled: true,
        triggerMode: "direct",
      },
      groupAllowFrom: ["global-user"],
      groups: {
        roomA: {
          triggerMode: "keyword",
          triggerKeywords: ["global-keyword"],
          allowFrom: ["room-global"],
          rejectMessage: "global room blocked",
        },
      },
    },
    accountConfig: {
      groupChat: {
        triggerMode: "keyword",
        triggerKeywords: ["account-keyword"],
      },
      groupAllowFrom: ["account-user"],
      groupAllowFromRejectMessage: "account blocked",
      groups: {
        roomA: {
          requireMention: true,
          mentionPatterns: ["@bot"],
          allowFrom: ["room-account"],
        },
      },
    },
    envVars: {
      WECOM_GROUP_ALLOW_FROM: "env-user",
    },
    processEnv: {},
    accountId: "sales",
    chatId: "roomA",
  });

  assert.equal(groupCfg.enabled, true);
  assert.equal(groupCfg.triggerMode, "mention");
  assert.equal(groupCfg.requireMention, true);
  assert.deepEqual(groupCfg.mentionPatterns, ["@bot"]);
  assert.deepEqual(groupCfg.triggerKeywords, ["account-keyword"]);
  assert.deepEqual(groupCfg.allowFrom, ["room-account"]);
  assert.equal(groupCfg.rejectMessage, "account blocked");
  assert.equal(groupCfg.policySource, "inferred");
  assert.equal(groupCfg.triggerSource, "account.group.requireMention");
  assert.equal(groupCfg.allowFromSource, "account.group.allowFrom");
  assert.equal(groupCfg.rejectMessageSource, "account.root.groupAllowFromRejectMessage");
  assert.equal(groupCfg.matchedGroupOverride, true);
  assert.equal(groupCfg.matchedGroupOverrideSource, "account.group");
  assert.equal(groupCfg.configuredGroupCount, 1);
});

test("resolveWecomGroupChatConfig keeps explicit open policy even when allowFrom exists", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupPolicy: "open",
      groupAllowFrom: ["alice"],
    },
    envVars: {},
    processEnv: {},
  });

  assert.equal(groupCfg.enabled, true);
  assert.equal(groupCfg.policyMode, "open");
  assert.equal(groupCfg.policySource, "channel.root.groupPolicy");
  assert.deepEqual(groupCfg.allowFrom, ["alice"]);
  assert.equal(groupCfg.allowFromSource, "channel.root.groupAllowFrom");
});

test("resolveWecomGroupChatConfig turns explicit allowlist without members into deny", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupChat: {
        policy: "allowlist",
      },
    },
    envVars: {},
    processEnv: {},
  });

  assert.equal(groupCfg.enabled, false);
  assert.equal(groupCfg.policyMode, "deny");
  assert.equal(groupCfg.policySource, "allowlist-empty");
  assert.deepEqual(groupCfg.allowFrom, []);
});

test("resolveWecomGroupChatConfig supports per-group policy override", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {
      groupPolicy: "open",
      groups: {
        roomA: {
          policy: "allowlist",
          allowFrom: ["room-user"],
        },
      },
    },
    envVars: {},
    processEnv: {},
    chatId: "roomA",
  });

  assert.equal(groupCfg.enabled, true);
  assert.equal(groupCfg.policyMode, "allowlist");
  assert.deepEqual(groupCfg.allowFrom, ["room-user"]);
  assert.equal(groupCfg.policySource, "channel.group.policy");
  assert.equal(groupCfg.allowFromSource, "channel.group.allowFrom");
  assert.equal(groupCfg.matchedGroupOverride, true);
});

test("resolveWecomGroupChatConfig falls back to scoped env authorization", () => {
  const groupCfg = core.resolveWecomGroupChatConfig({
    channelConfig: {},
    accountConfig: {},
    envVars: {
      WECOM_SALES_GROUP_ALLOW_FROM: "wecom:Tom,user:Jerry",
      WECOM_SALES_GROUP_ALLOW_FROM_REJECT_MESSAGE: "sales group blocked",
    },
    processEnv: {},
    accountId: "sales",
    chatId: "roomB",
  });

  assert.deepEqual(groupCfg.allowFrom.sort(), ["jerry", "tom"]);
  assert.equal(groupCfg.rejectMessage, "sales group blocked");
  assert.equal(groupCfg.matchedGroupOverride, false);
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

test("resolveWecomBotModeConfig resolves bot card policy from config and env", () => {
  const fromConfig = core.resolveWecomBotModeConfig({
    channelConfig: {
      bot: {
        enabled: true,
        card: {
          enabled: true,
          mode: "template_card",
          title: "OpenClaw 卡片",
          subtitle: "处理中",
          footer: "由 OpenClaw-Wechat 发送",
          maxContentLength: 1888,
          responseUrlEnabled: true,
          webhookBotEnabled: false,
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(fromConfig.card.enabled, true);
  assert.equal(fromConfig.card.mode, "template_card");
  assert.equal(fromConfig.card.title, "OpenClaw 卡片");
  assert.equal(fromConfig.card.subtitle, "处理中");
  assert.equal(fromConfig.card.footer, "由 OpenClaw-Wechat 发送");
  assert.equal(fromConfig.card.maxContentLength, 1888);
  assert.equal(fromConfig.card.responseUrlEnabled, true);
  assert.equal(fromConfig.card.webhookBotEnabled, false);

  const fromEnv = core.resolveWecomBotModeConfig({
    channelConfig: {},
    envVars: {
      WECOM_BOT_CARD_ENABLED: "true",
      WECOM_BOT_CARD_MODE: "markdown",
      WECOM_BOT_CARD_TITLE: "Env Card",
      WECOM_BOT_CARD_SUBTITLE: "Env subtitle",
      WECOM_BOT_CARD_FOOTER: "Env footer",
      WECOM_BOT_CARD_MAX_CONTENT_LENGTH: "3200",
      WECOM_BOT_CARD_RESPONSE_URL_ENABLED: "false",
      WECOM_BOT_CARD_WEBHOOK_BOT_ENABLED: "true",
    },
    processEnv: {},
  });
  assert.equal(fromEnv.card.enabled, true);
  assert.equal(fromEnv.card.mode, "markdown");
  assert.equal(fromEnv.card.title, "Env Card");
  assert.equal(fromEnv.card.subtitle, "Env subtitle");
  assert.equal(fromEnv.card.footer, "Env footer");
  assert.equal(fromEnv.card.maxContentLength, 3200);
  assert.equal(fromEnv.card.responseUrlEnabled, false);
  assert.equal(fromEnv.card.webhookBotEnabled, true);
});

test("resolveWecomBotModeConfig supports legacy agent+top-level bot token layout", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      token: "legacy-bot-token",
      encodingAesKey: "legacy-bot-aes",
      webhookPath: "/webhooks/wecom/default",
      agent: {
        corpId: "ww_legacy",
        corpSecret: "legacy-secret",
        agentId: 1000001,
        token: "agent-callback-token",
        encodingAesKey: "agent-callback-aes",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(cfg.token, "legacy-bot-token");
  assert.equal(cfg.encodingAesKey, "legacy-bot-aes");
  assert.equal(cfg.webhookPath, "/webhooks/wecom/default");
});

test("resolveWecomBotModeConfig supports legacy inline account layout", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      sales: {
        enabled: true,
        token: "sales-bot-token",
        encodingAesKey: "sales-bot-aes",
        webhookPath: "/webhooks/wecom/sales",
        agent: {
          corpId: "ww_sales",
          corpSecret: "sales-secret",
          agentId: 1000008,
          token: "sales-agent-token",
          encodingAesKey: "sales-agent-aes",
        },
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(cfg.accountId, "sales");
  assert.equal(cfg.token, "sales-bot-token");
  assert.equal(cfg.encodingAesKey, "sales-bot-aes");
  assert.equal(cfg.webhookPath, "/webhooks/wecom/sales");
});

test("resolveWecomBotModeConfig supports legacy inline default account layout", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      default: {
        token: "default-bot-token",
        encodingAesKey: "default-bot-aes",
        webhookPath: "/webhooks/wecom/default",
        agent: {
          corpId: "ww_default",
          corpSecret: "default-secret",
          agentId: 1000004,
        },
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "default",
  });
  assert.equal(cfg.accountId, "default");
  assert.equal(cfg.token, "default-bot-token");
  assert.equal(cfg.encodingAesKey, "default-bot-aes");
  assert.equal(cfg.webhookPath, "/webhooks/wecom/default");
});

test("resolveWecomBotModeConfig auto-assigns non-default bot webhookPath when missing", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      accounts: {
        sales: {
          bot: {
            enabled: true,
            token: "sales-token",
            encodingAesKey: "sales-aes",
          },
        },
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "sales",
  });
  assert.equal(cfg.webhookPath, "/wecom/sales/bot/callback");
});

test("resolveWecomBotModeConfig resolves bot long connection config and enables bot mode", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      bot: {
        longConnection: {
          enabled: true,
          botId: "bot-123",
          secret: "secret-xyz",
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.longConnection.enabled, true);
  assert.equal(cfg.longConnection.botId, "bot-123");
  assert.equal(cfg.longConnection.secret, "secret-xyz");
  assert.equal(cfg.longConnection.url, "wss://openws.work.weixin.qq.com");
});

test("resolveWecomBotModeConfig supports flat botId/secret compatibility fields", () => {
  const cfg = core.resolveWecomBotModeConfig({
    channelConfig: {
      accounts: {
        ops: {
          botId: "compat-bot-1",
          secret: "compat-secret-1",
        },
      },
    },
    envVars: {},
    processEnv: {},
    accountId: "ops",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.longConnection.enabled, true);
  assert.equal(cfg.longConnection.botId, "compat-bot-1");
  assert.equal(cfg.longConnection.secret, "compat-secret-1");
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

test("resolveWecomBotModeAccountsConfig collects legacy inline account ids", () => {
  const configs = core.resolveWecomBotModeAccountsConfig({
    channelConfig: {
      ops: {
        enabled: true,
        token: "ops-token",
        encodingAesKey: "ops-aes",
        webhookPath: "/webhooks/wecom/ops",
        agent: {
          corpId: "ww_ops",
          corpSecret: "ops-secret",
          agentId: 1000006,
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  const byAccount = new Map(configs.map((item) => [item.accountId, item]));
  assert.equal(byAccount.get("ops")?.token, "ops-token");
  assert.equal(byAccount.get("ops")?.webhookPath, "/webhooks/wecom/ops");
});

test("resolveWecomBotModeAccountsConfig detects account from scoped bot card env", () => {
  const configs = core.resolveWecomBotModeAccountsConfig({
    channelConfig: {
      bot: {
        enabled: true,
        token: "default-token",
        encodingAesKey: "default-aes",
      },
    },
    envVars: {
      WECOM_SALES_BOT_CARD_ENABLED: "true",
      WECOM_SALES_BOT_CARD_MODE: "markdown",
    },
    processEnv: {},
  });
  const byAccount = new Map(configs.map((item) => [item.accountId, item]));
  assert.equal(byAccount.has("sales"), true);
  assert.equal(byAccount.get("sales")?.card?.enabled, true);
  assert.equal(byAccount.get("sales")?.card?.mode, "markdown");
});

test("resolveWecomDeliveryFallbackConfig defaults and normalization", () => {
  const defaults = core.resolveWecomDeliveryFallbackConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.enabled, true);
  assert.deepEqual(defaults.order, ["long_connection", "active_stream", "response_url", "webhook_bot", "agent_push"]);

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

test("resolveWecomPendingReplyConfig reads config and env", () => {
  const defaults = core.resolveWecomPendingReplyConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxRetries, 3);
  assert.equal(defaults.retryBackoffMs, 15000);
  assert.equal(defaults.expireMs, 10 * 60 * 1000);
  assert.equal(defaults.persist, true);
  assert.equal(defaults.storeFile, undefined);

  const configured = core.resolveWecomPendingReplyConfig({
    channelConfig: {
      delivery: {
        pendingReply: {
          enabled: false,
          maxRetries: 5,
          retryBackoffMs: 2000,
          expireMs: 120000,
          persist: false,
          storeFile: "/tmp/wecom-pending.json",
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.maxRetries, 5);
  assert.equal(configured.retryBackoffMs, 2000);
  assert.equal(configured.expireMs, 120000);
  assert.equal(configured.persist, false);
  assert.equal(configured.storeFile, "/tmp/wecom-pending.json");
});

test("resolveWecomReasoningConfig derives mode from config and env aliases", () => {
  const defaults = core.resolveWecomReasoningConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.mode, "separate");
  assert.equal(defaults.sendThinkingMessage, true);
  assert.equal(defaults.includeInFinalAnswer, false);
  assert.equal(defaults.title, "思考过程");
  assert.equal(defaults.maxChars, 1200);

  const configured = core.resolveWecomReasoningConfig({
    channelConfig: {
      delivery: {
        reasoning: {
          mode: "append",
          title: "内部推理",
          maxChars: 300,
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(configured.mode, "append");
  assert.equal(configured.sendThinkingMessage, false);
  assert.equal(configured.includeInFinalAnswer, true);
  assert.equal(configured.title, "内部推理");
  assert.equal(configured.maxChars, 300);

  const fromLegacyEnv = core.resolveWecomReasoningConfig({
    channelConfig: {},
    envVars: {
      WECOM_SEND_THINKING_MESSAGE: "false",
      WECOM_REASONING_INCLUDE_IN_FINAL_ANSWER: "false",
      WECOM_REASONING_TITLE: "隐藏推理",
    },
    processEnv: {},
  });
  assert.equal(fromLegacyEnv.mode, "hidden");
  assert.equal(fromLegacyEnv.sendThinkingMessage, false);
  assert.equal(fromLegacyEnv.includeInFinalAnswer, false);
  assert.equal(fromLegacyEnv.title, "隐藏推理");
});

test("resolveWecomReplyFormatConfig reads delivery reply format and env aliases", () => {
  const defaults = core.resolveWecomReplyFormatConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.mode, "auto");

  const configured = core.resolveWecomReplyFormatConfig({
    channelConfig: {
      delivery: {
        replyFormat: "markdown",
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(configured.mode, "markdown");

  const fromEnv = core.resolveWecomReplyFormatConfig({
    channelConfig: {},
    envVars: {
      WECOM_REPLY_FORMAT: "text",
    },
    processEnv: {},
  });
  assert.equal(fromEnv.mode, "text");
});

test("resolveWecomQuotaTrackingConfig defaults to enabled", () => {
  const defaults = core.resolveWecomQuotaTrackingConfig({
    channelConfig: {},
    envVars: {},
    processEnv: {},
  });
  assert.equal(defaults.enabled, true);

  const configured = core.resolveWecomQuotaTrackingConfig({
    channelConfig: {
      delivery: {
        quotaTracking: {
          enabled: false,
        },
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(configured.enabled, false);
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

test("resolveWecomDynamicAgentConfig supports dynamicAgents and dm compatibility keys", () => {
  const cfg = core.resolveWecomDynamicAgentConfig({
    channelConfig: {
      dynamicAgents: {
        enabled: true,
        mode: "mapping",
        userMap: {
          alice: "sales",
        },
      },
      workspaceTemplate: "/tmp/wecom-template",
      dm: {
        createAgentOnFirstMessage: false,
      },
      groupChat: {
        enabled: true,
      },
    },
    envVars: {},
    processEnv: {},
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, "mapping");
  assert.equal(cfg.dmCreateAgent, false);
  assert.equal(cfg.groupEnabled, true);
  assert.equal(cfg.userMap.alice, "sales");
  assert.equal(cfg.workspaceTemplate, "/tmp/wecom-template");
});
