function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`prepareWecomBotRuntimeContext: ${name} is required`);
  }
}

export async function prepareWecomBotRuntimeContext({
  api,
  runtime,
  cfg,
  baseSessionId,
  fromUser,
  chatId,
  isGroupChat = false,
  msgId = "",
  messageText = "",
  commandBody = "",
  originalContent = "",
  fromAddress = "",
  groupChatPolicy = {},
  dynamicAgentPolicy = {},
  isAdminUser = false,
  resolveWecomAgentRoute,
  seedDynamicAgentWorkspace,
  buildWecomBotInboundEnvelopePayload,
  buildWecomBotInboundContextPayload,
} = {}) {
  assertFunction("resolveWecomAgentRoute", resolveWecomAgentRoute);
  assertFunction("seedDynamicAgentWorkspace", seedDynamicAgentWorkspace);
  assertFunction("buildWecomBotInboundEnvelopePayload", buildWecomBotInboundEnvelopePayload);
  assertFunction("buildWecomBotInboundContextPayload", buildWecomBotInboundContextPayload);

  const route = resolveWecomAgentRoute({
    runtime,
    cfg,
    channel: "wecom",
    accountId: "bot",
    sessionKey: baseSessionId,
    fromUser,
    chatId,
    isGroupChat,
    content: commandBody || messageText,
    mentionPatterns: groupChatPolicy.mentionPatterns,
    dynamicConfig: dynamicAgentPolicy,
    isAdminUser,
    logger: api?.logger,
  });
  const routedAgentId = String(route?.agentId ?? "").trim();
  const sessionId = String(route?.sessionKey ?? "").trim() || baseSessionId;
  api?.logger?.info?.(
    `wecom(bot): routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
  );
  try {
    await seedDynamicAgentWorkspace({
      api,
      agentId: route.agentId,
      workspaceTemplate: dynamicAgentPolicy.workspaceTemplate,
    });
  } catch (seedErr) {
    api?.logger?.warn?.(`wecom(bot): workspace seed failed: ${String(seedErr?.message || seedErr)}`);
  }

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const contextTimestamp = Date.now();
  const body = runtime.channel.reply.formatInboundEnvelope({
    ...buildWecomBotInboundEnvelopePayload({
      fromUser,
      chatId,
      isGroupChat,
      messageText,
      timestamp: contextTimestamp,
    }),
    ...envelopeOptions,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext(
    buildWecomBotInboundContextPayload({
      body,
      messageText,
      originalContent,
      commandBody,
      fromAddress,
      sessionId,
      isGroupChat,
      chatId,
      fromUser,
      msgId,
      timestamp: contextTimestamp,
    }),
  );
  const sessionRuntimeId = String(ctxPayload.SessionId ?? "").trim();

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: sessionId,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: sessionId,
      channel: "wecom",
      to: fromUser,
      accountId: "bot",
    },
    onRecordError: (err) => {
      api?.logger?.warn?.(`wecom(bot): failed to record session: ${err}`);
    },
  });

  runtime.channel.activity.record({
    channel: "wecom",
    accountId: "bot",
    direction: "inbound",
  });

  return {
    route,
    routedAgentId,
    sessionId,
    storePath,
    ctxPayload,
    sessionRuntimeId,
  };
}
