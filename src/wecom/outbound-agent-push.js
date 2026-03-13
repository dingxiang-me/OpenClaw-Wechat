function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentPushDeliverer: ${name} is required`);
  }
}

export function createWecomAgentPushDeliverer({
  getWecomConfig,
  sendWecomText,
} = {}) {
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("sendWecomText", sendWecomText);

  return async function deliverAgentPushReply({
    api,
    fromUser,
    accountId = "default",
    content = "",
    fallbackText = "",
    mediaFallbackSuffix = "",
  } = {}) {
    const account = getWecomConfig(api, accountId) ?? getWecomConfig(api, "default") ?? getWecomConfig(api);
    if (!account?.corpId || !account?.corpSecret || !account?.agentId) {
      return { ok: false, reason: "agent-config-missing" };
    }
    await sendWecomText({
      corpId: account.corpId,
      corpSecret: account.corpSecret,
      agentId: account.agentId,
      toUser: fromUser,
      text: `${content || fallbackText}${mediaFallbackSuffix}`.trim(),
      logger: api?.logger,
      proxyUrl: account.outboundProxy,
      apiProxy: account.apiProxy,
    });
    return {
      ok: true,
      meta: {
        accountId: account.accountId || "default",
      },
    };
  };
}
