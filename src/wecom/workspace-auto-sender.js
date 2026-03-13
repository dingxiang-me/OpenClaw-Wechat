import { stat } from "node:fs/promises";

export function createWorkspaceAutoSender({
  extractWorkspacePathsFromText,
  resolveWorkspacePathToHost,
  statImpl = stat,
  sendWecomOutboundMediaBatch,
} = {}) {
  if (typeof extractWorkspacePathsFromText !== "function") {
    throw new Error("createWorkspaceAutoSender: extractWorkspacePathsFromText is required");
  }
  if (typeof resolveWorkspacePathToHost !== "function") {
    throw new Error("createWorkspaceAutoSender: resolveWorkspacePathToHost is required");
  }
  if (typeof sendWecomOutboundMediaBatch !== "function") {
    throw new Error("createWorkspaceAutoSender: sendWecomOutboundMediaBatch is required");
  }

  async function autoSendWorkspaceFilesFromReplyText({
    text,
    routeAgentId,
    corpId,
    corpSecret,
    agentId,
    toUser,
    toParty,
    toTag,
    chatId,
    logger,
    proxyUrl,
    apiProxy,
    maxDetect = 6,
  } = {}) {
    const normalizedText = String(text ?? "");
    const normalizedRouteAgentId = String(routeAgentId ?? "").trim();
    if (!normalizedText || !normalizedRouteAgentId) {
      return {
        detectedCount: 0,
        matchedCount: 0,
        sentCount: 0,
        failed: [],
        sentPaths: [],
      };
    }

    const workspacePaths = extractWorkspacePathsFromText(normalizedText, maxDetect);
    if (workspacePaths.length === 0) {
      return {
        detectedCount: 0,
        matchedCount: 0,
        sentCount: 0,
        failed: [],
        sentPaths: [],
      };
    }

    const resolved = [];
    for (const workspacePath of workspacePaths) {
      const hostPath = resolveWorkspacePathToHost({
        workspacePath,
        agentId: normalizedRouteAgentId,
      });
      if (!hostPath) continue;
      try {
        const fileStat = await statImpl(hostPath);
        if (!fileStat.isFile()) continue;
        resolved.push({ workspacePath, hostPath });
      } catch {
        // ignore missing files
      }
    }

    if (resolved.length === 0) {
      return {
        detectedCount: workspacePaths.length,
        matchedCount: 0,
        sentCount: 0,
        failed: [],
        sentPaths: [],
      };
    }

    const mediaResult = await sendWecomOutboundMediaBatch({
      corpId,
      corpSecret,
      agentId,
      toUser,
      toParty,
      toTag,
      chatId,
      mediaUrls: resolved.map((item) => item.hostPath),
      logger,
      proxyUrl,
      apiProxy,
    });

    const failedByPath = new Map();
    for (const item of mediaResult.failed) {
      failedByPath.set(String(item?.url ?? ""), String(item?.reason ?? "unknown"));
    }

    const failed = [];
    const sentPaths = [];
    for (const item of resolved) {
      const failReason = failedByPath.get(item.hostPath);
      if (failReason) {
        failed.push({
          workspacePath: item.workspacePath,
          hostPath: item.hostPath,
          reason: failReason,
        });
      } else {
        sentPaths.push(item.workspacePath);
      }
    }

    if (sentPaths.length > 0) {
      logger?.info?.(
        `wecom: auto-sent workspace files agent=${normalizedRouteAgentId} sent=${sentPaths.length} detected=${workspacePaths.length}`,
      );
    }

    return {
      detectedCount: workspacePaths.length,
      matchedCount: resolved.length,
      sentCount: sentPaths.length,
      failed,
      sentPaths,
    };
  }

  return {
    autoSendWorkspaceFilesFromReplyText,
  };
}
