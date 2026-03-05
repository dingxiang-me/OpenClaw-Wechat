function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`executeWecomBotInboundFlow: ${name} is required`);
  }
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
  content,
  imageUrls,
  fileUrl,
  fileName,
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
  const baseSessionId = buildWecomBotSessionId(fromUser, normalizedAccountId);
  const state = {
    runtime,
    cfg,
    accountId: normalizedAccountId,
    baseSessionId,
    sessionId: baseSessionId,
    routedAgentId: "",
    fromAddress:
      normalizedAccountId === "default" ? `wecom-bot:${fromUser}` : `wecom-bot:${normalizedAccountId}:${fromUser}`,
    normalizedFromUser: String(fromUser ?? "").trim().toLowerCase(),
    originalContent: String(content ?? ""),
    commandBody: String(content ?? ""),
    dispatchStartedAt: Date.now(),
    tempPathsToCleanup: [],
    botModeConfig: resolveWecomBotConfig(api, normalizedAccountId),
    botProxyUrl: resolveWecomBotProxyConfig(api, normalizedAccountId),
    normalizedFileUrl: String(fileUrl ?? "").trim(),
    normalizedFileName: String(fileName ?? "").trim(),
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
    normalizedImageUrls: Array.from(
      new Set(
        (Array.isArray(imageUrls) ? imageUrls : [])
          .map((item) => String(item ?? "").trim())
          .filter(Boolean),
      ),
    ),
    groupChatPolicy: normalizeWecomBotGroupChatPolicy(resolveWecomGroupChatPolicy(api), api?.logger),
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
    const replyMediaUrls = normalizeWecomBotOutboundMediaUrls(normalizedReply);
    if (!contentText && replyMediaUrls.length === 0) return false;
    const result = await deliverBotReplyText({
      api,
      fromUser,
      accountId: state.accountId,
      sessionId: state.sessionId,
      streamId,
      responseUrl,
      text: contentText,
      mediaUrls: replyMediaUrls,
      mediaType: String(normalizedReply.mediaType ?? "").trim().toLowerCase() || undefined,
      reason,
    });
    if (!result?.ok && hasBotStream(streamId)) {
      finishBotStream(streamId, contentText || "已收到模型返回的媒体结果，请稍后刷新。");
    }
    return result?.ok === true;
  };

  return {
    safeFinishStream,
    safeDeliverReply,
  };
}
