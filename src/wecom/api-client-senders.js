import { createWecomTextSender } from "./api-client-send-text.js";
import { createWecomTypedMessageSender } from "./api-client-send-typed.js";

export function createWecomApiSenders({
  sleep,
  splitWecomText,
  getByteLength,
  apiLimiter,
  fetchWithRetry,
  getWecomAccessToken,
  buildWecomMessageSendRequest,
} = {}) {
  const sendWecomTypedMessage = createWecomTypedMessageSender({
    apiLimiter,
    fetchWithRetry,
    getWecomAccessToken,
    buildWecomMessageSendRequest,
  });

  const { sendWecomText } = createWecomTextSender({
    sleep,
    splitWecomText,
    getByteLength,
    sendWecomTypedMessage,
  });

  async function sendWecomImage({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    mediaId,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    return sendWecomTypedMessage({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      msgType: "image",
      payload: {
        image: { media_id: mediaId },
      },
      logger,
      proxyUrl,
      apiProxy,
      errorPrefix: "WeCom image send failed",
    });
  }

  async function sendWecomVideo({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    mediaId,
    title,
    description,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    const videoPayload = {
      media_id: mediaId,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
    return sendWecomTypedMessage({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      msgType: "video",
      payload: {
        video: videoPayload,
      },
      logger,
      proxyUrl,
      apiProxy,
      errorPrefix: "WeCom video send failed",
    });
  }

  async function sendWecomFile({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    mediaId,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    return sendWecomTypedMessage({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      msgType: "file",
      payload: {
        file: { media_id: mediaId },
      },
      logger,
      proxyUrl,
      apiProxy,
      errorPrefix: "WeCom file send failed",
    });
  }

  async function sendWecomVoice({
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    mediaId,
    logger,
    proxyUrl,
    apiProxy,
  }) {
    return sendWecomTypedMessage({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      msgType: "voice",
      payload: {
        voice: { media_id: mediaId },
      },
      logger,
      proxyUrl,
      apiProxy,
      errorPrefix: "WeCom voice send failed",
    });
  }

  return {
    sendWecomText,
    sendWecomImage,
    sendWecomVideo,
    sendWecomFile,
    sendWecomVoice,
  };
}
