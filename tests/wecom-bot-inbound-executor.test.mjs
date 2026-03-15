import assert from "node:assert/strict";
import test from "node:test";

import { executeWecomBotInboundFlow } from "../src/wecom/bot-inbound-executor.js";

function createRuntime({
  dispatchReplyWithBufferedBlockDispatcher = async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "final reply" }, { kind: "final" });
  },
} = {}) {
  return {
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        resolveEnvelopeFormatOptions: () => ({}),
        formatInboundEnvelope: (payload) => String(payload?.text ?? payload?.Text ?? payload?.Body ?? ""),
        finalizeInboundContext: (ctx) => ({
          ...ctx,
          SessionId: String(ctx?.SessionId ?? "runtime:session"),
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw/store/main",
        recordInboundSession: async () => {},
      },
      activity: {
        record() {},
      },
    },
  };
}

function createInput(overrides = {}) {
  const finished = [];
  const delivered = [];
  const cleanup = [];
  const watcherReasons = [];
  const runtime = createRuntime(overrides.runtimeOptions || {});
  const input = {
    api: {
      runtime,
      config: { env: { vars: {} }, session: { store: "memory" } },
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    },
    streamId: "stream-1",
    fromUser: "alice",
    content: "hello",
    msgType: "text",
    msgId: "msg-1",
    chatId: "",
    isGroupChat: false,
    imageUrls: [],
    fileUrl: "",
    fileName: "",
    quote: null,
    responseUrl: "",
    buildWecomBotSessionId: (fromUser) => `wecom-bot:${fromUser}`,
    resolveWecomBotConfig: () => ({ replyTimeoutMs: 90000, lateReplyWatchMs: 120000, lateReplyPollMs: 1500 }),
    resolveWecomBotProxyConfig: () => "",
    normalizeWecomBotOutboundMediaUrls: (payload) =>
      Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : payload?.mediaUrl ? [payload.mediaUrl] : [],
    resolveWecomGroupChatPolicy: () => ({ enabled: true, triggerMode: "direct", mentionPatterns: [] }),
    resolveWecomReasoningPolicy: () => ({ mode: "separate", title: "思考过程", maxChars: 1200 }),
    resolveWecomDynamicAgentPolicy: () => ({ mode: "mapping" }),
    hasBotStream: () => true,
    finishBotStream: (streamId, text) => {
      finished.push({ streamId, text: String(text ?? "") });
    },
    deliverBotReplyText: async ({ text, reason }) => {
      delivered.push({ text: String(text ?? ""), reason: String(reason ?? "") });
      return { ok: true };
    },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => String(text ?? ""),
    resolveWecomCommandPolicy: () => ({
      enabled: false,
      allowlist: ["/help", "/status", "/reset", "/clear"],
      rejectMessage: "blocked",
      adminUsers: [],
    }),
    resolveWecomAllowFromPolicy: () => ({
      allowFrom: ["*"],
      rejectMessage: "denied",
    }),
    resolveWecomDmPolicy: () => ({
      mode: "open",
      allowFrom: ["*"],
      rejectMessage: "",
    }),
    isWecomSenderAllowed: () => true,
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
    buildBotInboundContent: async () => ({
      aborted: false,
      messageText: "hello world",
      tempPathsToCleanup: ["/tmp/wecom-bot-file-1"],
    }),
    resolveWecomAgentRoute: ({ sessionKey }) => ({
      agentId: "main",
      sessionKey,
      matchedBy: "default",
    }),
    seedDynamicAgentWorkspace: async () => {},
    markTranscriptReplyDelivered: () => {},
    markdownToWecomText: (text) => String(text ?? ""),
    withTimeout: async (promise) => promise,
    isDispatchTimeoutError: (err) => String(err?.message || "").includes("timed out"),
    queueBotStreamMedia() {},
    updateBotStream() {},
    isAgentFailureText: () => false,
    scheduleTempFileCleanup: (filePath) => cleanup.push(String(filePath)),
    ACTIVE_LATE_REPLY_WATCHERS: new Map(),
    ensureLateReplyWatcherRunner: () => async ({ reason }) => {
      watcherReasons.push(String(reason ?? ""));
    },
    ensureTranscriptFallbackReader: () => async () => ({ text: "", transcriptMessageId: "" }),
    ...overrides,
  };
  return { input, finished, delivered, cleanup, watcherReasons };
}

test("executeWecomBotInboundFlow dispatches final reply and cleans temp files", async () => {
  const { input, delivered, cleanup, finished } = createInput();
  await executeWecomBotInboundFlow(input);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "final reply");
  assert.equal(delivered[0].reason, "final");
  assert.deepEqual(cleanup, ["/tmp/wecom-bot-file-1"]);
  assert.equal(finished.length, 0);
});

test("executeWecomBotInboundFlow stops on group policy guard rejection", async () => {
  const { input, delivered, finished, cleanup } = createInput({
    isGroupChat: true,
    resolveWecomGroupChatPolicy: () => ({ enabled: false, triggerMode: "direct", mentionPatterns: [] }),
    buildBotInboundContent: async () => {
      throw new Error("should not reach inbound content");
    },
  });
  await executeWecomBotInboundFlow(input);
  assert.equal(delivered.length, 0);
  assert.equal(finished.length, 1);
  assert.match(finished[0].text, /群聊消息处理未启用/);
  assert.equal(cleanup.length, 0);
});

test("executeWecomBotInboundFlow falls back with error text on dispatch error", async () => {
  const { input, delivered, watcherReasons } = createInput({
    runtimeOptions: {
      dispatchReplyWithBufferedBlockDispatcher: async () => new Promise(() => {}),
    },
    withTimeout: async () => {
      throw new Error("upstream broken");
    },
    isDispatchTimeoutError: () => false,
  });
  await executeWecomBotInboundFlow(input);
  assert.equal(watcherReasons.length, 0);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /当前模型请求超时或网络不稳定/);
  assert.equal(delivered[0].reason, "catch-timeout-fallback");
});

test("executeWecomBotInboundFlow handles /clear as local reset without dispatch", async () => {
  let dispatchCalled = false;
  const resetCalls = [];
  const { input, finished, delivered, watcherReasons } = createInput({
    content: "/clear",
    buildBotInboundContent: async () => {
      throw new Error("should not build inbound content for reset command");
    },
    extractLeadingSlashCommand: (text) => {
      if (String(text ?? "").startsWith("/clear")) return "/clear";
      if (String(text ?? "").startsWith("/reset")) return "/reset";
      return "";
    },
    resetWecomConversationSession: async (payload) => {
      resetCalls.push(payload);
      return { cleared: true };
    },
    runtimeOptions: {
      dispatchReplyWithBufferedBlockDispatcher: async () => {
        dispatchCalled = true;
      },
    },
  });

  await executeWecomBotInboundFlow(input);

  assert.equal(resetCalls.length, 1);
  assert.equal(resetCalls[0].baseSessionId, "wecom-bot:alice");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].text, "会话已重置。请继续发送你的新问题。");
  assert.equal(delivered.length, 0);
  assert.equal(watcherReasons.length, 0);
  assert.equal(dispatchCalled, false);
});
