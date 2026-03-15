import { join } from "node:path";

export function createInboundFileVideoLinkHandlers({
  downloadWecomMedia,
  ensureTempDir,
  writeFile,
  now,
  randomSuffix,
} = {}) {
  async function handleVideo({
    api,
    corpId,
    corpSecret,
    mediaId,
    proxyUrl,
    apiBaseUrl,
    tempPathsToCleanup,
  }) {
    api.logger.info?.(`wecom: received video message mediaId=${mediaId}`);
    try {
      const { buffer } = await downloadWecomMedia({
        corpId,
        corpSecret,
        mediaId,
        proxyUrl,
        apiBaseUrl,
        logger: api.logger,
      });
      const tempDir = await ensureTempDir();
      const videoTempPath = join(tempDir, `video-${now()}-${randomSuffix()}.mp4`);
      await writeFile(videoTempPath, buffer);
      tempPathsToCleanup.push(videoTempPath);
      api.logger.info?.(`wecom: saved video to ${videoTempPath}, size=${buffer.length} bytes`);
      return {
        aborted: false,
        messageText: `[用户发送了一个视频文件，已保存到: ${videoTempPath}]\n\n请告知用户您已收到视频。`,
      };
    } catch (downloadErr) {
      api.logger.warn?.(`wecom: failed to download video: ${downloadErr.message}`);
      return {
        aborted: false,
        messageText: "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。",
      };
    }
  }

  async function handleFile({
    api,
    corpId,
    corpSecret,
    mediaId,
    fileName,
    fileSize,
    proxyUrl,
    apiBaseUrl,
    tempPathsToCleanup,
  }) {
    api.logger.info?.(`wecom: received file message mediaId=${mediaId}, fileName=${fileName}, size=${fileSize}`);
    try {
      const { buffer } = await downloadWecomMedia({
        corpId,
        corpSecret,
        mediaId,
        proxyUrl,
        apiBaseUrl,
        logger: api.logger,
      });
      const ext = fileName ? fileName.split(".").pop() : "bin";
      const safeFileName = fileName || `file-${now()}.${ext}`;
      const tempDir = await ensureTempDir();
      const fileTempPath = join(tempDir, `${now()}-${safeFileName}`);
      await writeFile(fileTempPath, buffer);
      tempPathsToCleanup.push(fileTempPath);
      api.logger.info?.(`wecom: saved file to ${fileTempPath}, size=${buffer.length} bytes`);

      const readableTypes = [".txt", ".md", ".json", ".xml", ".csv", ".log", ".pdf"];
      const isReadable = readableTypes.some((t) => safeFileName.toLowerCase().endsWith(t));

      if (isReadable) {
        return {
          aborted: false,
          messageText: `[用户发送了一个文件: ${safeFileName}，已保存到: ${fileTempPath}]\n\n请使用 Read 工具查看这个文件的内容。`,
        };
      }
      return {
        aborted: false,
        messageText: `[用户发送了一个文件: ${safeFileName}，大小: ${fileSize || buffer.length} 字节，已保存到: ${fileTempPath}]\n\n请告知用户您已收到文件。`,
      };
    } catch (downloadErr) {
      api.logger.warn?.(`wecom: failed to download file: ${downloadErr.message}`);
      return {
        aborted: false,
        messageText: `[用户发送了一个文件${fileName ? `: ${fileName}` : ""}，但下载失败]\n\n请告诉用户文件处理暂时不可用。`,
      };
    }
  }

  function handleLink({ api, linkTitle, linkDescription, linkUrl }) {
    api.logger.info?.(`wecom: received link message title=${linkTitle}, url=${linkUrl}`);
    return {
      aborted: false,
      messageText: `[用户分享了一个链接]\n标题: ${linkTitle || "(无标题)"}\n描述: ${linkDescription || "(无描述)"}\n链接: ${linkUrl || "(无链接)"}\n\n请根据链接内容回复用户。如需要，可以使用 WebFetch 工具获取链接内容。`,
    };
  }

  return {
    handleVideo,
    handleFile,
    handleLink,
  };
}
