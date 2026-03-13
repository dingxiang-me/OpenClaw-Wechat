export function createWecomTextSender({
  sleep,
  splitWecomText,
  getByteLength,
  sendWecomTypedMessage,
} = {}) {
  if (typeof sleep !== "function") throw new Error("createWecomTextSender: sleep is required");
  if (typeof splitWecomText !== "function") throw new Error("createWecomTextSender: splitWecomText is required");
  if (typeof getByteLength !== "function") throw new Error("createWecomTextSender: getByteLength is required");
  if (typeof sendWecomTypedMessage !== "function") {
    throw new Error("createWecomTextSender: sendWecomTypedMessage is required");
  }

  async function sendWecomTextSingle({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    text,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    const sendJson = await sendWecomTypedMessage({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      msgType: "text",
      payload: {
        text: { content: text },
      },
      logger,
      proxyUrl,
      apiProxy,
      errorPrefix: "",
    });
    const isAppChat = Boolean(chatId);
    const targetLabel = isAppChat ? `chat:${chatId}` : [toUser, toParty, toTag].filter(Boolean).join("|");
    logger?.info?.(`wecom: message sent ok (to=${targetLabel || "unknown"}, msgid=${sendJson?.msgid || "n/a"})`);
    return sendJson;
  }

  async function sendWecomText({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    text,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    const chunks = splitWecomText(text);
    logger?.info?.(`wecom: splitting message into ${chunks.length} chunks, total bytes=${getByteLength(text)}`);

    for (let i = 0; i < chunks.length; i += 1) {
      logger?.info?.(`wecom: sending chunk ${i + 1}/${chunks.length}, bytes=${getByteLength(chunks[i])}`);
      // eslint-disable-next-line no-await-in-loop
      await sendWecomTextSingle({
        corpId,
        corpSecret,
        agentId,
        toUser,
        toParty,
        toTag,
        chatId,
        text: chunks[i],
        logger,
        proxyUrl,
        apiProxy,
      });
      if (i < chunks.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(300);
      }
    }
  }

  return {
    sendWecomText,
  };
}
