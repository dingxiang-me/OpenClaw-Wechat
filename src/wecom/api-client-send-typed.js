export function createWecomTypedMessageSender({
  apiLimiter,
  fetchWithRetry,
  getWecomAccessToken,
  buildWecomMessageSendRequest,
} = {}) {
  if (!apiLimiter || typeof apiLimiter.execute !== "function") {
    throw new Error("createWecomTypedMessageSender: apiLimiter.execute is required");
  }
  if (typeof fetchWithRetry !== "function") {
    throw new Error("createWecomTypedMessageSender: fetchWithRetry is required");
  }
  if (typeof getWecomAccessToken !== "function") {
    throw new Error("createWecomTypedMessageSender: getWecomAccessToken is required");
  }
  if (typeof buildWecomMessageSendRequest !== "function") {
    throw new Error("createWecomTypedMessageSender: buildWecomMessageSendRequest is required");
  }

  return async function sendWecomTypedMessage({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    msgType,
    payload,
    logger,
    proxyUrl,
    apiProxy,
    errorPrefix,
  }) {
    return apiLimiter.execute(async () => {
      const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger });
      const { sendUrl, body, isAppChat } = buildWecomMessageSendRequest({
        accessToken,
        agentId,
        toUser,
        toParty,
        toTag,
        chatId,
        msgType,
        payload,
        apiProxy,
      });
      const sendRes = await fetchWithRetry(
        sendUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        3,
        1000,
        { proxyUrl, logger },
      );
      const sendJson = await sendRes.json();
      if (sendJson?.errcode !== 0) {
        if (errorPrefix) {
          throw new Error(`${errorPrefix}: ${JSON.stringify(sendJson)}`);
        }
        throw new Error(`WeCom ${isAppChat ? "appchat/send" : "message/send"} failed: ${JSON.stringify(sendJson)}`);
      }
      return sendJson;
    });
  };
}
