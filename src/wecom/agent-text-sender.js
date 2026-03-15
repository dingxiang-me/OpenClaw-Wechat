function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentTextSender: ${name} is required`);
  }
}

export function createWecomAgentTextSender({
  sendWecomText,
  corpId,
  corpSecret,
  agentId,
  toUser,
  logger,
  proxyUrl,
  apiBaseUrl,
} = {}) {
  assertFunction("sendWecomText", sendWecomText);

  return async function sendText(text) {
    return sendWecomText({
      corpId,
      corpSecret,
      agentId,
      toUser,
      text,
      logger,
      proxyUrl,
      apiBaseUrl,
    });
  };
}
