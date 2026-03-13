import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWecomInboundMessageTypeHandlers } from "./inbound-content-handlers.js";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomInboundContentBuilder missing function dependency: ${name}`);
  }
}

function buildTempSuffix() {
  return Math.random().toString(36).slice(2);
}

export function createWecomInboundContentBuilder({
  tempDirName = "openclaw-wechat",
  downloadWecomMedia,
  fetchMediaFromUrl,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
  sendWecomText,
  ensureDir,
  writeFile,
  now = () => Date.now(),
  randomSuffix = buildTempSuffix,
  tmpDirResolver = tmpdir,
} = {}) {
  assertFunction("downloadWecomMedia", downloadWecomMedia);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("resolveWecomVoiceTranscriptionConfig", resolveWecomVoiceTranscriptionConfig);
  assertFunction("transcribeInboundVoice", transcribeInboundVoice);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("ensureDir", ensureDir);
  assertFunction("writeFile", writeFile);
  assertFunction("tmpDirResolver", tmpDirResolver);

  async function ensureTempDir() {
    const dir = join(tmpDirResolver(), tempDirName);
    await ensureDir(dir, { recursive: true });
    return dir;
  }

  const handlers = createWecomInboundMessageTypeHandlers({
    downloadWecomMedia,
    fetchMediaFromUrl,
    resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice,
    sendWecomText,
    ensureTempDir,
    writeFile,
    now,
    randomSuffix,
  });

  async function buildInboundContent({
    api,
    corpId,
    corpSecret,
    agentId,
    proxyUrl,
    apiProxy,
    fromUser,
    msgType,
    baseText,
    mediaId,
    picUrl,
    recognition,
    fileName,
    fileSize,
    linkTitle,
    linkDescription,
    linkUrl,
  } = {}) {
    const tempPathsToCleanup = [];
    let messageText = String(baseText ?? "");
    let result = { aborted: false, messageText };

    if (msgType === "image" && mediaId) {
      result = await handlers.handleImage({
        api,
        corpId,
        corpSecret,
        mediaId,
        picUrl,
        proxyUrl,
        tempPathsToCleanup,
      });
    } else if (msgType === "voice" && mediaId) {
      result = await handlers.handleVoice({
        api,
        corpId,
        corpSecret,
        agentId,
        fromUser,
        mediaId,
        recognition,
        proxyUrl,
        apiProxy,
      });
    } else if (msgType === "video" && mediaId) {
      result = await handlers.handleVideo({
        api,
        corpId,
        corpSecret,
        mediaId,
        proxyUrl,
        tempPathsToCleanup,
      });
    } else if (msgType === "file" && mediaId) {
      result = await handlers.handleFile({
        api,
        corpId,
        corpSecret,
        mediaId,
        fileName,
        fileSize,
        proxyUrl,
        tempPathsToCleanup,
      });
    } else if (msgType === "link") {
      result = handlers.handleLink({
        api,
        linkTitle,
        linkDescription,
        linkUrl,
      });
    }

    return {
      aborted: result.aborted === true,
      messageText: String(result.messageText ?? messageText),
      tempPathsToCleanup,
    };
  }

  return {
    buildInboundContent,
  };
}
