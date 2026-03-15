function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`executeWecomBotInboundFlow: ${name} is required`);
  }
}

function normalizeBotImageEntries({ imageEntries, imageUrls } = {}) {
  const normalized = [];
  const seen = new Map();
  const sourceEntries = Array.isArray(imageEntries) && imageEntries.length > 0
    ? imageEntries
    : Array.isArray(imageUrls)
      ? imageUrls.map((url) => ({ url }))
      : [];
  for (const rawEntry of sourceEntries) {
    if (rawEntry == null) continue;
    const entry = typeof rawEntry === "string" ? { url: rawEntry } : rawEntry;
    const url = String(entry?.url ?? "").trim();
    if (!url) continue;
    const aesKey = String(entry?.aesKey ?? "").trim();
    const existingIndex = seen.get(url);
    if (existingIndex == null) {
      seen.set(url, normalized.length);
      normalized.push({ url, aesKey });
      continue;
    }
    if (!normalized[existingIndex].aesKey && aesKey) {
      normalized[existingIndex] = { url, aesKey };
    }
  }
  return normalized;
}

const UNSUPPORTED_BOT_GROUP_TRIGGER_WARNED = new Set();

function warnUnsupportedBotGroupTriggerOnce(triggerMode, logger) {
  const mode = String(triggerMode ?? "").trim().toLowerCase();
  if (!mode || UNSUPPORTED_BOT_GROUP_TRIGGER_WARNED.has(mode)) return;
  UNSUPPORTED_BOT_GROUP_TRIGGER_WARNED.add(mode);
  logger?.warn?.(
    `wecom(bot): groupChat.triggerMode=${mode} is not supported by WeCom Bot group callbacks; forcing mention mode (@).`,
  );
}

export function normalizeWecomBotGroupChatPolicy(groupChatPolicy = {}, logger) {
  const policy = groupChatPolicy && typeof groupChatPolicy === "object" ? groupChatPolicy : {};
  const enabled = policy.enabled !== false;
  const mentionPatterns =
    Array.isArray(policy.mentionPatterns) && policy.mentionPatterns.length > 0 ? policy.mentionPatterns : ["@"];

  if (!enabled) {
    return {
      ...policy,
      enabled: false,
      mentionPatterns,
    };
  }

  const triggerMode = String(policy.triggerMode ?? "").trim().toLowerCase();
  if (triggerMode && triggerMode !== "mention") {
    warnUnsupportedBotGroupTriggerOnce(triggerMode, logger);
  }

  return {
    ...policy,
    enabled: true,
    triggerMode: "mention",
    requireMention: true,
    mentionPatterns,
  };
}

export function assertWecomBotInboundFlowDeps({ api, ...deps } = {}) {
  if (!api || typeof api !== "object") {
    throw new Error("executeWecomBotInboundFlow: api is required");
  }
  const requiredFns = [
    "buildWecomBotSessionId",
    "resolveWecomBotConfig",
    "resolveWecomBotProxyConfig",
    "normalizeWecomBotOutboundMediaUrls",
    "resolveWecomGroupChatPolicy",
    "resolveWecomDynamicAgentPolicy",
    "hasBotStream",
    "finishBotStream",
    "deliverBotReplyText",
    "shouldTriggerWecomGroupResponse",
    "shouldStripWecomGroupMentions",
    "stripWecomGroupMentions",
    "resolveWecomCommandPolicy",
    "resolveWecomAllowFromPolicy",
    "resolveWecomDmPolicy",
    "resolveWecomReasoningPolicy",
    "isWecomSenderAllowed",
    "extractLeadingSlashCommand",
    "buildWecomBotHelpText",
    "buildWecomBotStatusText",
    "buildBotInboundContent",
    "resolveWecomAgentRoute",
    "seedDynamicAgentWorkspace",
    "markTranscriptReplyDelivered",
    "markdownToWecomText",
    "withTimeout",
    "isDispatchTimeoutError",
    "queueBotStreamMedia",
    "updateBotStream",
    "isAgentFailureText",
    "scheduleTempFileCleanup",
    "ensureLateReplyWatcherRunner",
    "ensureTranscriptFallbackReader",
  ];
  for (const name of requiredFns) {
    assertFunction(name, deps[name]);
  }
}

export function createWecomBotInboundFlowState({
  api,
  accountId = "default",
  fromUser,
  chatId = "",
  content,
  imageEntries,
  imageUrls,
  fileUrl,
  fileName,
  fileAesKey,
  voiceUrl,
  voiceMediaId,
  voiceContentType,
  quote,
  buildWecomBotSessionId,
  resolveWecomBotConfig,
  resolveWecomBotProxyConfig,
  resolveWecomGroupChatPolicy,
  resolveWecomDynamicAgentPolicy,
} = {}) {
  const runtime = api.runtime;
  const cfg = api.config;
  const normalizedAccountId = String(accountId ?? "default").trim().toLowerCase() || "default";
  const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
  const baseSessionId = buildWecomBotSessionId(fromUser, normalizedAccountId);
  const normalizedImageEntries = normalizeBotImageEntries({ imageEntries, imageUrls });
  const state = {
    runtime,
    cfg,
    accountId: normalizedAccountId,
    baseSessionId,
    sessionId: baseSessionId,
    routedAgentId: "",
    fromAddress:
      normalizedAccountId === "default"
        ? `wecom-bot:${normalizedFromUser}`
        : `wecom-bot:${normalizedAccountId}:${normalizedFromUser}`,
    normalizedFromUser,
    originalContent: String(content ?? ""),
    commandBody: String(content ?? ""),
    dispatchStartedAt: Date.now(),
    tempPathsToCleanup: [],
    botModeConfig: resolveWecomBotConfig(api, normalizedAccountId),
    botProxyUrl: resolveWecomBotProxyConfig(api, normalizedAccountId),
    normalizedImageEntries,
    normalizedImageUrls: normalizedImageEntries.map((entry) => entry.url),
    normalizedFileUrl: String(fileUrl ?? "").trim(),
    normalizedFileName: String(fileName ?? "").trim(),
    normalizedFileAesKey: String(fileAesKey ?? "").trim(),
    normalizedVoiceUrl: String(voiceUrl ?? "").trim(),
    normalizedVoiceMediaId: String(voiceMediaId ?? "").trim(),
    normalizedVoiceContentType: String(voiceContentType ?? "").trim(),
    normalizedQuote:
      quote && typeof quote === "object"
        ? {
            msgType: String(quote.msgType ?? "").trim().toLowerCase(),
            content: String(quote.content ?? "").trim(),
          }
        : null,
    groupChatPolicy: normalizeWecomBotGroupChatPolicy(
      resolveWecomGroupChatPolicy(api, normalizedAccountId, {}, chatId),
      api?.logger,
    ),
    dynamicAgentPolicy: resolveWecomDynamicAgentPolicy(api),
    isAdminUser: false,
  };
  return state;
}

export function createWecomBotSafeReplyHelpers({
  api,
  fromUser,
  streamId,
  responseUrl,
  state,
  hasBotStream,
  finishBotStream,
  normalizeWecomBotOutboundMediaUrls,
  deliverBotReplyText,
} = {}) {
  const safeFinishStream = (text) => {
    if (!hasBotStream(streamId)) return;
    finishBotStream(streamId, String(text ?? ""));
  };

  const safeDeliverReply = async (reply, reason = "reply") => {
    const normalizedReply =
      typeof reply === "string"
        ? { text: reply }
        : reply && typeof reply === "object"
          ? reply
          : { text: "" };
    const contentText = String(normalizedReply.text ?? "").trim();
    const rawContentText = String(normalizedReply.rawText ?? contentText).trim();
    const thinkingContent = String(normalizedReply.thinkingContent ?? "").trim();
    const rawThinkingContent = String(normalizedReply.rawThinkingContent ?? thinkingContent).trim();
    const replyMediaUrls = normalizeWecomBotOutboundMediaUrls(normalizedReply);
    if (!contentText && replyMediaUrls.length === 0 && !thinkingContent) return false;
    const result = await deliverBotReplyText({
      api,
      fromUser,
      accountId: state.accountId,
      sessionId: state.sessionId,
      streamId,
      responseUrl,
      text: contentText,
      rawText: rawContentText,
      thinkingContent,
      rawThinkingContent,
      routeAgentId: state.routedAgentId,
      mediaUrls: replyMediaUrls,
      mediaType: String(normalizedReply.mediaType ?? "").trim().toLowerCase() || undefined,
      reason,
    });
    if (!result?.ok && hasBotStream(streamId)) {
      finishBotStream(streamId, contentText || "已收到模型返回的媒体结果，请稍后刷新。", {
        thinkingContent,
      });
    }
    return result?.ok === true;
  };

  return {
    safeFinishStream,
    safeDeliverReply,
  };
}
