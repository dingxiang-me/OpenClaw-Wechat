function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotInboundContentBuilder: ${name} is required`);
  }
}

export function createWecomBotInboundContentBuilder({
  fetchMediaFromUrl,
  detectImageContentTypeFromBuffer,
  decryptWecomMediaBuffer,
  pickImageFileExtension,
  resolveWecomVoiceTranscriptionConfig,
  transcribeInboundVoice,
  inferFilenameFromMediaDownload,
  smartDecryptWecomFileBuffer,
  basename,
  mkdir,
  tmpdir,
  join,
  writeFile,
  WECOM_TEMP_DIR_NAME,
} = {}) {
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("detectImageContentTypeFromBuffer", detectImageContentTypeFromBuffer);
  assertFunction("decryptWecomMediaBuffer", decryptWecomMediaBuffer);
  assertFunction("pickImageFileExtension", pickImageFileExtension);
  assertFunction("resolveWecomVoiceTranscriptionConfig", resolveWecomVoiceTranscriptionConfig);
  assertFunction("transcribeInboundVoice", transcribeInboundVoice);
  assertFunction("inferFilenameFromMediaDownload", inferFilenameFromMediaDownload);
  assertFunction("smartDecryptWecomFileBuffer", smartDecryptWecomFileBuffer);
  assertFunction("basename", basename);
  assertFunction("mkdir", mkdir);
  assertFunction("tmpdir", tmpdir);
  assertFunction("join", join);
  assertFunction("writeFile", writeFile);

  return async function buildBotInboundContent({
    api,
    botModeConfig,
    botProxyUrl,
    msgType = "text",
    commandBody = "",
    normalizedImageUrls = [],
    normalizedFileUrl = "",
    normalizedFileName = "",
    normalizedVoiceUrl = "",
    normalizedVoiceMediaId = "",
    normalizedVoiceContentType = "",
    voiceInputMessageId = "",
    normalizedQuote = null,
  } = {}) {
    const tempPathsToCleanup = [];
    let messageText = String(commandBody ?? "").trim();

    if (normalizedImageUrls.length > 0) {
      const fetchedImagePaths = [];
      const imageUrlsToFetch = normalizedImageUrls.slice(0, 3);
      const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
      await mkdir(tempDir, { recursive: true });
      for (const imageUrl of imageUrlsToFetch) {
        try {
          const { buffer, contentType } = await fetchMediaFromUrl(imageUrl, {
            proxyUrl: botProxyUrl,
            logger: api?.logger,
            forceProxy: Boolean(botProxyUrl),
            maxBytes: 8 * 1024 * 1024,
          });
          const normalizedType = String(contentType ?? "")
            .trim()
            .toLowerCase()
            .split(";")[0]
            .trim();
          let effectiveBuffer = buffer;
          let effectiveImageType =
            normalizedType.startsWith("image/") ? normalizedType : detectImageContentTypeFromBuffer(buffer);
          if (!effectiveImageType && botModeConfig?.encodingAesKey) {
            try {
              const decryptedBuffer = decryptWecomMediaBuffer({
                aesKey: botModeConfig.encodingAesKey,
                encryptedBuffer: buffer,
              });
              const decryptedImageType = detectImageContentTypeFromBuffer(decryptedBuffer);
              if (decryptedImageType) {
                effectiveBuffer = decryptedBuffer;
                effectiveImageType = decryptedImageType;
                api?.logger?.info?.(
                  `wecom(bot): decrypted media buffer from content-type=${normalizedType || "unknown"} to ${decryptedImageType}`,
                );
              }
            } catch (decryptErr) {
              api?.logger?.warn?.(
                `wecom(bot): media decrypt attempt failed: ${String(decryptErr?.message || decryptErr)}`,
              );
            }
          }
          if (!effectiveImageType) {
            const headerHex = buffer.subarray(0, 16).toString("hex");
            throw new Error(`unexpected content-type: ${normalizedType || "unknown"} header=${headerHex}`);
          }
          const ext = pickImageFileExtension({ contentType: effectiveImageType, sourceUrl: imageUrl });
          const imageTempPath = join(tempDir, `bot-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
          await writeFile(imageTempPath, effectiveBuffer);
          fetchedImagePaths.push(imageTempPath);
          tempPathsToCleanup.push(imageTempPath);
          api?.logger?.info?.(
            `wecom(bot): downloaded image from url, size=${effectiveBuffer.length} bytes, path=${imageTempPath}`,
          );
        } catch (imageErr) {
          api?.logger?.warn?.(`wecom(bot): failed to fetch image url: ${String(imageErr?.message || imageErr)}`);
        }
      }

      if (fetchedImagePaths.length > 0) {
        const intro = fetchedImagePaths.length > 1 ? "[用户发送了多张图片]" : "[用户发送了一张图片]";
        const parts = [];
        if (messageText) parts.push(messageText);
        parts.push(intro);
        for (let i = 0; i < fetchedImagePaths.length; i += 1) {
          parts.push(`图片${i + 1}: ${fetchedImagePaths[i]}`);
        }
        parts.push("请使用 Read 工具查看图片并基于图片内容回复用户。");
        messageText = parts.join("\n").trim();
      } else if (!messageText || messageText === "[图片]") {
        return {
          aborted: true,
          abortText: "图片接收失败（下载失败或链接失效），请重新发送原图后重试。",
          messageText: "",
          tempPathsToCleanup,
        };
      } else {
        messageText = `${messageText}\n\n[附加说明] 用户还发送了图片，但插件下载失败。`;
      }
    }

    if (msgType === "file") {
      const displayName =
        inferFilenameFromMediaDownload({
          explicitName: normalizedFileName,
          sourceUrl: normalizedFileUrl,
          contentType: "",
        }) || "附件";
      if (normalizedFileUrl) {
        try {
          const tempDir = join(tmpdir(), WECOM_TEMP_DIR_NAME);
          await mkdir(tempDir, { recursive: true });
          const downloaded = await fetchMediaFromUrl(normalizedFileUrl, {
            proxyUrl: botProxyUrl,
            logger: api?.logger,
            forceProxy: Boolean(botProxyUrl),
            maxBytes: 20 * 1024 * 1024,
          });
          const resolvedName = inferFilenameFromMediaDownload({
            explicitName: normalizedFileName,
            contentDisposition: downloaded.contentDisposition,
            sourceUrl: downloaded.finalUrl || normalizedFileUrl,
            contentType: downloaded.contentType,
          });
          const decrypted = smartDecryptWecomFileBuffer({
            buffer: downloaded.buffer,
            aesKey: botModeConfig?.encodingAesKey,
            contentType: downloaded.contentType,
            sourceUrl: downloaded.finalUrl || normalizedFileUrl,
            decryptFn: decryptWecomMediaBuffer,
            logger: api?.logger,
          });
          const safeName = basename(resolvedName) || `file-${Date.now()}.bin`;
          const fileTempPath = join(
            tempDir,
            `bot-file-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`,
          );
          await writeFile(fileTempPath, decrypted.buffer);
          tempPathsToCleanup.push(fileTempPath);
          messageText =
            `[用户发送了一个文件: ${safeName}，已保存到: ${fileTempPath}]` +
            "\n\n请根据文件内容回复用户；如需读取详情请使用 Read 工具。";
          api?.logger?.info?.(
            `wecom(bot): saved file to ${fileTempPath}, size=${decrypted.buffer.length} bytes` +
              `, decrypted=${decrypted.decrypted ? "yes" : "no"} source=${downloaded.source || "unknown"}`,
          );
        } catch (fileErr) {
          api?.logger?.warn?.(`wecom(bot): failed to fetch file url: ${String(fileErr?.message || fileErr)}`);
          messageText = `[用户发送了一个文件: ${displayName}，但下载失败]\n\n请提示用户重新发送文件。`;
        }
      } else if (!messageText) {
        messageText = `[用户发送了一个文件: ${displayName}]`;
      }
    }

    if (msgType === "voice") {
      const existingVoiceText = String(messageText ?? "").trim();
      const voiceUrl = String(normalizedVoiceUrl ?? "").trim();
      const voiceMediaId = String(normalizedVoiceMediaId ?? "").trim() || String(voiceInputMessageId ?? "").trim();
      if (existingVoiceText && existingVoiceText !== "[语音]") {
        messageText = `[用户发送了一条语音]\n转写: ${existingVoiceText}`;
      } else if (!voiceUrl) {
        messageText = "语音接收成功，但未提供可下载的语音链接，请用户改发文字。";
      } else {
        const voiceConfig = resolveWecomVoiceTranscriptionConfig(api);
        if (!voiceConfig.enabled) {
          messageText = "已收到语音消息，但当前未启用语音转写，请改发文字。";
        } else {
          try {
            const downloadedVoice = await fetchMediaFromUrl(voiceUrl, {
              proxyUrl: botProxyUrl,
              logger: api?.logger,
              forceProxy: Boolean(botProxyUrl),
              maxBytes: Math.max(voiceConfig.maxBytes || 0, 2 * 1024 * 1024),
            });
            const transcript = await transcribeInboundVoice({
              api,
              buffer: downloadedVoice.buffer,
              contentType: normalizedVoiceContentType || downloadedVoice.contentType,
              mediaId: voiceMediaId || `bot-voice-${Date.now()}`,
              voiceConfig,
            });
            messageText = `[用户发送了一条语音]\n转写: ${String(transcript ?? "").trim()}`;
          } catch (voiceErr) {
            api?.logger?.warn?.(`wecom(bot): voice transcription failed: ${String(voiceErr?.message || voiceErr)}`);
            return {
              aborted: true,
              abortText: "语音识别失败，请稍后重试。",
              messageText: "",
              tempPathsToCleanup,
            };
          }
        }
      }
    }

    if (normalizedQuote?.content) {
      const quoteLabel = normalizedQuote.msgType === "image" ? "[引用图片]" : `> ${normalizedQuote.content}`;
      messageText = `${quoteLabel}\n\n${String(messageText ?? "").trim()}`.trim();
    }

    return {
      aborted: false,
      abortText: "",
      messageText,
      tempPathsToCleanup,
    };
  };
}
