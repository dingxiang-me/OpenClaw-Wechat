function buildWebhookTargetStatusLine({ aliases, scope = "当前账户", maxPreview = 6 }) {
  const normalized = Array.isArray(aliases) ? aliases : [];
  if (normalized.length === 0) {
    return `ℹ️ 命名 Webhook 目标（${scope}）：未配置`;
  }
  const preview = normalized.slice(0, maxPreview).join(", ");
  const suffix = normalized.length > maxPreview ? ` ... 共 ${normalized.length} 个` : `（共 ${normalized.length} 个）`;
  return `✅ 命名 Webhook 目标（${scope}）：${preview}${suffix}`;
}

function buildDmPolicyStatusLine(dmPolicy = {}) {
  const mode = String(dmPolicy?.mode ?? "open").trim().toLowerCase() || "open";
  if (mode === "deny") {
    return "⚠️ 私聊策略：已关闭（deny）";
  }
  if (mode === "allowlist") {
    const count = Array.isArray(dmPolicy?.allowFrom) ? dmPolicy.allowFrom.length : 0;
    return `✅ 私聊策略：白名单（${count} 个用户）`;
  }
  return "ℹ️ 私聊策略：开放（open）";
}

function buildEventPolicyStatusLine(eventPolicy = {}) {
  if (eventPolicy?.enabled === false) {
    return "⚠️ 事件策略：已关闭";
  }
  if (eventPolicy?.enterAgentWelcomeEnabled) {
    return "✅ 事件策略：enter_agent 自动欢迎语已启用";
  }
  return "ℹ️ 事件策略：已启用（enter_agent 欢迎语未启用）";
}

function buildObservabilityStatusLines(observabilityMetrics = {}) {
  const inboundTotal = Number(observabilityMetrics?.inboundTotal || 0);
  const deliveryTotal = Number(observabilityMetrics?.deliveryTotal || 0);
  const deliverySuccess = Number(observabilityMetrics?.deliverySuccess || 0);
  const deliveryFailed = Number(observabilityMetrics?.deliveryFailed || 0);
  const errorsTotal = Number(observabilityMetrics?.errorsTotal || 0);
  const successRate = deliveryTotal > 0 ? `${Math.round((deliverySuccess / deliveryTotal) * 100)}%` : "n/a";
  const status = `📈 观测统计：入站 ${inboundTotal} / 回包 ${deliveryTotal}（成功 ${deliverySuccess}，失败 ${deliveryFailed}，成功率 ${successRate}） / 错误 ${errorsTotal}`;

  const recent = Array.isArray(observabilityMetrics?.recentFailures)
    ? observabilityMetrics.recentFailures.slice(-1)[0]
    : null;
  if (!recent) {
    return {
      status,
      recent: "ℹ️ 最近失败：无",
    };
  }
  return {
    status,
    recent: `⚠️ 最近失败：${recent.scope || "unknown"} ${recent.reason || "unknown"}`.slice(0, 140),
  };
}

export function buildAgentStatusText({
  fromUser,
  config,
  accountIds,
  webhookTargetAliases,
  pluginVersion,
  voiceConfig,
  commandPolicy,
  allowFromPolicy,
  dmPolicy,
  eventPolicy,
  groupPolicy,
  debouncePolicy,
  streamingPolicy,
  deliveryFallbackPolicy,
  streamManagerPolicy,
  webhookBotPolicy,
  dynamicAgentPolicy,
  observabilityMetrics,
} = {}) {
  const proxyEnabled = Boolean(config?.outboundProxy);
  const voiceStatusLine = voiceConfig.enabled
    ? `✅ 语音消息转写（本地 ${voiceConfig.provider}，模型: ${voiceConfig.modelPath || voiceConfig.model}）`
    : "⚠️ 语音消息转写回退未启用（仅使用企业微信 Recognition）";
  const commandPolicyLine = commandPolicy.enabled
    ? `✅ 指令白名单已启用（${commandPolicy.allowlist.length} 条，管理员 ${commandPolicy.adminUsers.length} 人）`
    : "ℹ️ 指令白名单未启用";
  const allowFromPolicyLine =
    allowFromPolicy.allowFrom.length === 0 || allowFromPolicy.allowFrom.includes("*")
      ? "ℹ️ 发送者授权：未限制（allowFrom 未配置）"
      : `✅ 发送者授权：已限制 ${allowFromPolicy.allowFrom.length} 个用户`;
  const dmPolicyLine = buildDmPolicyStatusLine(dmPolicy);
  const eventPolicyLine = buildEventPolicyStatusLine(eventPolicy);
  const groupPolicyLine = groupPolicy.enabled
    ? groupPolicy.triggerMode === "mention"
      ? "✅ 群聊触发：仅 @ 命中后处理"
      : groupPolicy.triggerMode === "keyword"
        ? `✅ 群聊触发：关键词模式（${(groupPolicy.triggerKeywords || []).join(" / ") || "未配置关键词"}）`
        : "✅ 群聊触发：无需 @（全部处理）"
    : "⚠️ 群聊处理未启用";
  const debouncePolicyLine = debouncePolicy.enabled
    ? `✅ 文本防抖合并已启用（${debouncePolicy.windowMs}ms / 最多 ${debouncePolicy.maxBatch} 条）`
    : "ℹ️ 文本防抖合并未启用";
  const streamingPolicyLine = streamingPolicy.enabled
    ? `✅ Agent 增量回包已启用（最小片段 ${streamingPolicy.minChars} 字符 / 最短间隔 ${streamingPolicy.minIntervalMs}ms）`
    : "ℹ️ Agent 增量回包未启用";
  const fallbackPolicyLine = deliveryFallbackPolicy.enabled
    ? `✅ 回包兜底链路已启用（${deliveryFallbackPolicy.order.join(" > ")}）`
    : "ℹ️ 回包兜底链路未启用（仅 active_stream）";
  const streamManagerPolicyLine = streamManagerPolicy.enabled
    ? `✅ 会话串行队列已启用（每会话并发 ${streamManagerPolicy.maxConcurrentPerSession}）`
    : "ℹ️ 会话串行队列未启用";
  const webhookBotPolicyLine = webhookBotPolicy.enabled
    ? "✅ Webhook Bot 回包已启用"
    : "ℹ️ Webhook Bot 回包未启用";
  const webhookTargetsLine = buildWebhookTargetStatusLine({
    aliases: webhookTargetAliases,
    scope: config?.accountId || "default",
  });
  const dynamicAgentPolicyLine = dynamicAgentPolicy.enabled
    ? `✅ 动态 Agent 路由已启用（mode=${dynamicAgentPolicy.mode}，用户映射 ${Object.keys(dynamicAgentPolicy.userMap || {}).length}，群映射 ${Object.keys(dynamicAgentPolicy.groupMap || {}).length}）`
    : "ℹ️ 动态 Agent 路由未启用";
  const entryVisibilityLine = "✅ 微信插件入口联系人：Agent 模式可见（自建应用）";
  const observabilityLines = buildObservabilityStatusLines(observabilityMetrics);

  return `📊 系统状态

渠道：企业微信 (WeCom)
会话ID：wecom:${fromUser}
账户ID：${config?.accountId || "default"}
已配置账户：${accountIds.join(", ")}
插件版本：${pluginVersion}

功能状态：
✅ 文本消息
✅ 图片发送/接收
✅ 消息分段 (2048字符)
✅ 命令系统
✅ Markdown 转换
✅ API 限流
✅ 多账户支持
${commandPolicyLine}
${allowFromPolicyLine}
${dmPolicyLine}
${eventPolicyLine}
${groupPolicyLine}
${debouncePolicyLine}
${streamingPolicyLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${webhookTargetsLine}
${dynamicAgentPolicyLine}
${entryVisibilityLine}
${proxyEnabled ? "✅ WeCom 出站代理已启用" : "ℹ️ WeCom 出站代理未启用"}
${voiceStatusLine}
${observabilityLines.status}
${observabilityLines.recent}`;
}

export function buildBotStatusText({
  fromUser,
  pluginVersion,
  botConfig,
  allWebhookTargetAliases,
  commandPolicy,
  allowFromPolicy,
  dmPolicy,
  eventPolicy,
  groupPolicy,
  deliveryFallbackPolicy,
  streamManagerPolicy,
  webhookBotPolicy,
  dynamicAgentPolicy,
  observabilityMetrics,
} = {}) {
  const commandPolicyLine = commandPolicy.enabled
    ? `✅ 指令白名单已启用（${commandPolicy.allowlist.length} 条，管理员 ${commandPolicy.adminUsers.length} 人）`
    : "ℹ️ 指令白名单未启用";
  const allowFromPolicyLine =
    allowFromPolicy.allowFrom.length === 0 || allowFromPolicy.allowFrom.includes("*")
      ? "ℹ️ 发送者授权：未限制（allowFrom 未配置）"
      : `✅ 发送者授权：已限制 ${allowFromPolicy.allowFrom.length} 个用户`;
  const dmPolicyLine = buildDmPolicyStatusLine(dmPolicy);
  const eventPolicyLine = buildEventPolicyStatusLine(eventPolicy);
  const groupPolicyLine = groupPolicy.enabled
    ? "✅ 群聊触发：仅 @ 机器人后处理（企业微信 Bot 平台限制）"
    : "⚠️ 群聊处理未启用";
  const fallbackPolicyLine = deliveryFallbackPolicy.enabled
    ? `✅ 回包兜底链路已启用（${deliveryFallbackPolicy.order.join(" > ")}）`
    : "ℹ️ 回包兜底链路未启用（仅 active_stream）";
  const streamManagerPolicyLine = streamManagerPolicy.enabled
    ? `✅ 会话串行队列已启用（每会话并发 ${streamManagerPolicy.maxConcurrentPerSession}）`
    : "ℹ️ 会话串行队列未启用";
  const webhookBotPolicyLine = webhookBotPolicy.enabled
    ? "✅ Webhook Bot 回包已启用"
    : "ℹ️ Webhook Bot 回包未启用";
  const webhookTargetsLine = buildWebhookTargetStatusLine({
    aliases: allWebhookTargetAliases,
    scope: "全部账户",
  });
  const dynamicAgentPolicyLine = dynamicAgentPolicy.enabled
    ? `✅ 动态 Agent 路由已启用（mode=${dynamicAgentPolicy.mode}，用户映射 ${Object.keys(dynamicAgentPolicy.userMap || {}).length}，群映射 ${Object.keys(dynamicAgentPolicy.groupMap || {}).length}）`
    : "ℹ️ 动态 Agent 路由未启用";
  const entryVisibilityLine = "ℹ️ 微信插件入口联系人：Bot 模式通常不显示（请通过机器人会话/群聊入口触发）";
  const observabilityLines = buildObservabilityStatusLines(observabilityMetrics);
  return `📊 系统状态

渠道：企业微信 AI 机器人 (Bot)
会话ID：wecom-bot:${fromUser}
插件版本：${pluginVersion}
Bot Webhook：${botConfig.webhookPath}

功能状态：
✅ 原生流式回复（stream）
${commandPolicyLine}
${allowFromPolicyLine}
${dmPolicyLine}
${eventPolicyLine}
${groupPolicyLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${webhookTargetsLine}
${dynamicAgentPolicyLine}
${entryVisibilityLine}
${observabilityLines.status}
${observabilityLines.recent}`;
}

export function buildWecomBotHelpText() {
  return `🤖 AI 助手使用帮助（Bot 流式模式）

可用命令：
/help - 显示帮助信息
/new - 新建会话（兼容命令，等价于 /reset）
/status - 查看系统状态
/clear - 重置会话（等价于 /reset）

说明：企业微信 Bot 群聊通常仅对 @ 机器人消息触发回调。

直接发送消息即可与 AI 对话。`;
}
