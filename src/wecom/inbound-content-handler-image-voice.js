import { join } from "node:path";

function pickImageExtFromMime(imageMimeType) {
  const normalized = String(imageMimeType ?? "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
}

export function createInboundImageVoiceHandlers({
  downloadWecomMedia,
  fetchMediaFromUrl,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
  sendWecomText,
  ensureTempDir,
  writeFile,
  now,
  randomSuffix,
} = {}) {
  async function handleImage({
    api,
    corpId,
    corpSecret,
    mediaId,
    picUrl,
    proxyUrl,
    tempPathsToCleanup,
  }) {
    api.logger.info?.(`wecom: downloading image mediaId=${mediaId}`);
    let imageBuffer = null;
    let imageMimeType = "";

    try {
      const { buffer, contentType } = await downloadWecomMedia({
        corpId,
        corpSecret,
        mediaId,
        proxyUrl,
        logger: api.logger,
      });
      imageBuffer = buffer;
      imageMimeType = contentType || "image/jpeg";
      api.logger.info?.(`wecom: image downloaded, size=${buffer.length} bytes, type=${imageMimeType}`);
    } catch (downloadErr) {
      api.logger.warn?.(`wecom: failed to download image via mediaId: ${downloadErr.message}`);
      if (picUrl) {
        try {
          const { buffer, contentType } = await fetchMediaFromUrl(picUrl);
          imageBuffer = buffer;
          imageMimeType = contentType || "image/jpeg";
          api.logger.info?.(`wecom: image downloaded via PicUrl, size=${buffer.length} bytes`);
        } catch (picUrlErr) {
          api.logger.warn?.(`wecom: failed to download image via PicUrl: ${picUrlErr.message}`);
        }
      }
    }

    if (imageBuffer) {
      try {
        const ext = pickImageExtFromMime(imageMimeType);
        const tempDir = await ensureTempDir();
        const imageTempPath = join(tempDir, `image-${now()}-${randomSuffix()}.${ext}`);
        await writeFile(imageTempPath, imageBuffer);
        tempPathsToCleanup.push(imageTempPath);
        api.logger.info?.(`wecom: saved image to ${imageTempPath}`);
        return {
          aborted: false,
          messageText: `[用户发送了一张图片，已保存到: ${imageTempPath}]\n\n请使用 Read 工具查看这张图片并描述内容。`,
        };
      } catch (saveErr) {
        api.logger.warn?.(`wecom: failed to save image: ${saveErr.message}`);
        return {
          aborted: false,
          messageText: "[用户发送了一张图片，但保存失败]\n\n请告诉用户图片处理暂时不可用。",
        };
      }
    }
    return {
      aborted: false,
      messageText: "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。",
    };
  }

  async function handleVoice({
    api,
    corpId,
    corpSecret,
    agentId,
    fromUser,
    mediaId,
    recognition,
    proxyUrl,
    apiProxy,
  }) {
    api.logger.info?.(`wecom: received voice message mediaId=${mediaId}`);
    const recognizedText = String(recognition ?? "").trim();
    if (recognizedText) {
      api.logger.info?.(`wecom: voice recognition result from WeCom: ${recognizedText.slice(0, 50)}...`);
      return {
        aborted: false,
        messageText: `[语音消息转写]\n${recognizedText}`,
      };
    }

    const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
    if (!voiceConfig.enabled) {
      api.logger.info?.("wecom: voice transcription fallback disabled; asking user to send text");
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text: "语音识别未启用，请先开启企业微信语音识别，或直接发送文字消息。",
        logger: api.logger,
        proxyUrl,
        apiProxy,
      });
      return { aborted: true, messageText: "" };
    }

    try {
      const { buffer, contentType } = await downloadWecomMedia({
        corpId,
        corpSecret,
        mediaId,
        proxyUrl,
        logger: api.logger,
      });
      api.logger.info?.(
        `wecom: downloaded voice media for transcription, size=${buffer.length}, type=${contentType || "unknown"}`,
      );
      const transcript = await transcribeInboundVoice({
        api,
        buffer,
        contentType,
        mediaId,
        voiceConfig,
      });
      api.logger.info?.(`wecom: voice transcribed via ${voiceConfig.model}: ${transcript.slice(0, 80)}...`);
      return {
        aborted: false,
        messageText: `[语音消息转写]\n${transcript}`,
      };
    } catch (voiceErr) {
      api.logger.warn?.(`wecom: voice transcription failed: ${String(voiceErr?.message || voiceErr)}`);
      await sendWecomText({
        corpId,
        corpSecret,
        agentId,
        toUser: fromUser,
        text:
          "语音识别失败，请稍后重试。\n" +
          "如持续失败，请确认本地 whisper 命令可用、模型路径已配置，并已安装 ffmpeg。",
        logger: api.logger,
        proxyUrl,
        apiProxy,
      });
      return { aborted: true, messageText: "" };
    }
  }

  return {
    handleImage,
    handleVoice,
  };
}
