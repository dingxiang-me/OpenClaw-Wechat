import { createWecomApiClientCore } from "./api-client-core.js";
import { createWecomApiMediaClient } from "./api-client-media.js";
import { createWecomApiSenders } from "./api-client-senders.js";

export function createWecomApiClient({
  fetchImpl = fetch,
  proxyAgentCtor,
  sleep,
  splitWecomText,
  getByteLength,
  apiLimiter,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createWecomApiClient: fetchImpl is required");
  if (typeof proxyAgentCtor !== "function") throw new Error("createWecomApiClient: proxyAgentCtor is required");
  if (typeof sleep !== "function") throw new Error("createWecomApiClient: sleep is required");
  if (typeof splitWecomText !== "function") throw new Error("createWecomApiClient: splitWecomText is required");
  if (typeof getByteLength !== "function") throw new Error("createWecomApiClient: getByteLength is required");
  if (!apiLimiter || typeof apiLimiter.execute !== "function") {
    throw new Error("createWecomApiClient: apiLimiter.execute is required");
  }

  const core = createWecomApiClientCore({
    fetchImpl,
    proxyAgentCtor,
    sleep,
  });

  const senders = createWecomApiSenders({
    sleep,
    splitWecomText,
    getByteLength,
    apiLimiter,
    fetchWithRetry: core.fetchWithRetry,
    getWecomAccessToken: core.getWecomAccessToken,
    buildWecomMessageSendRequest: core.buildWecomMessageSendRequest,
  });

  const media = createWecomApiMediaClient({
    fetchWithRetry: core.fetchWithRetry,
    getWecomAccessToken: core.getWecomAccessToken,
  });

  return {
    attachWecomProxyDispatcher: core.attachWecomProxyDispatcher,
    fetchWithRetry: core.fetchWithRetry,
    getWecomAccessToken: core.getWecomAccessToken,
    buildWecomMessageSendRequest: core.buildWecomMessageSendRequest,
    sendWecomText: senders.sendWecomText,
    sendWecomMarkdown: senders.sendWecomMarkdown,
    uploadWecomMedia: media.uploadWecomMedia,
    sendWecomImage: senders.sendWecomImage,
    sendWecomVideo: senders.sendWecomVideo,
    sendWecomFile: senders.sendWecomFile,
    sendWecomVoice: senders.sendWecomVoice,
    downloadWecomMedia: media.downloadWecomMedia,
  };
}
