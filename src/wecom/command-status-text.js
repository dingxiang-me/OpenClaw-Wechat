import { formatWecomQuotaState, formatWecomReplyWindowState } from "./reliable-delivery.js";

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
  if (mode === "pairing") {
    const count = Array.isArray(dmPolicy?.allowFrom) ? dmPolicy.allowFrom.length : 0;
    return count > 0
      ? `✅ 私聊策略：配对审批（pairing，显式放行 ${count} 个用户）`
      : "✅ 私聊策略：配对审批（pairing，首次私聊需审批）";
  }
  return "ℹ️ 私聊策略：开放（open）";
}

function buildRoutePolicyStatusLine({ bindingsCount = 0, dynamicAgentPolicy = {} } = {}) {
  const count = Math.max(0, Number(bindingsCount) || 0);
  if (count > 0 && dynamicAgentPolicy?.enabled) {
    return `✅ 路由策略：OpenClaw bindings 优先（${count} 条），动态 Agent 补充（mode=${dynamicAgentPolicy.mode}）`;
  }
  if (count > 0) {
    return `✅ 路由策略：OpenClaw bindings（${count} 条）`;
  }
  if (dynamicAgentPolicy?.enabled) {
    return `✅ 路由策略：动态 Agent（mode=${dynamicAgentPolicy.mode}）`;
  }
  return "ℹ️ 路由策略：使用 OpenClaw 默认 Agent 路由";
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

function buildGroupAuthorizationStatusLine(groupPolicy = {}) {
  const policyMode = String(groupPolicy?.policyMode ?? (groupPolicy?.enabled === false ? "deny" : "open"))
    .trim()
    .toLowerCase();
  if (!groupPolicy?.enabled || policyMode === "deny") {
    return "⚠️ 群聊授权：已关闭（deny）";
  }
  const allowFrom = Array.isArray(groupPolicy?.allowFrom) ? groupPolicy.allowFrom : [];
  const overrideLabel = groupPolicy?.matchedGroupOverride
    ? "（当前群已应用专属规则）"
    : Number(groupPolicy?.configuredGroupCount || 0) > 0
      ? `（已配置 ${Number(groupPolicy.configuredGroupCount || 0)} 个群覆盖）`
      : "";
  if (policyMode === "open" || allowFrom.includes("*")) {
    return `ℹ️ 群聊授权：开放（open）${overrideLabel}`;
  }
  return `✅ 群聊授权：白名单（${allowFrom.length} 个成员）${overrideLabel}`;
}

function truncateStatusSnippet(text, maxChars = 48) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function formatGroupPolicySourceLabel(source = "") {
  const normalized = String(source ?? "").trim();
  if (!normalized) return "未配置";
  if (normalized === "default") return "默认值";
  if (normalized === "inferred") return "自动推断";
  if (normalized === "enabled=false") return "enabled=false";
  if (normalized === "allowlist-empty") return "allowlist 空白名单";
  if (normalized.startsWith("env.")) return "环境变量";
  if (normalized.startsWith("account.group.")) return "当前账号当前群覆盖";
  if (normalized === "account.group") return "当前账号当前群覆盖";
  if (normalized.startsWith("account.groupChat.")) return "当前账号群默认";
  if (normalized === "account.groupChat") return "当前账号群默认";
  if (normalized.startsWith("account.root.")) return "当前账号根配置";
  if (normalized === "account.root") return "当前账号根配置";
  if (normalized.startsWith("channel.group.")) return "全局当前群覆盖";
  if (normalized === "channel.group") return "全局当前群覆盖";
  if (normalized.startsWith("channel.groupChat.")) return "全局群默认";
  if (normalized === "channel.groupChat") return "全局群默认";
  if (normalized.startsWith("channel.root.")) return "全局根配置";
  if (normalized === "channel.root") return "全局根配置";
  return normalized;
}

function buildGroupPolicySourceLine(groupPolicy = {}, { includeTrigger = true } = {}) {
  const segments = [];
  const policySourceLabel = formatGroupPolicySourceLabel(groupPolicy?.policySource);
  if (policySourceLabel && policySourceLabel !== "未配置") {
    segments.push(`准入=${policySourceLabel}`);
  }
  if (includeTrigger) {
    const triggerSourceLabel = formatGroupPolicySourceLabel(groupPolicy?.triggerSource);
    if (triggerSourceLabel && triggerSourceLabel !== "未配置") {
      segments.push(`触发=${triggerSourceLabel}`);
    }
  }
  if (Array.isArray(groupPolicy?.allowFrom) && groupPolicy.allowFrom.length > 0) {
    const allowFromSourceLabel = formatGroupPolicySourceLabel(groupPolicy?.allowFromSource);
    if (allowFromSourceLabel && allowFromSourceLabel !== "未配置") {
      segments.push(`成员=${allowFromSourceLabel}`);
    }
  }
  if (groupPolicy?.rejectMessageSource && groupPolicy.rejectMessageSource !== "default") {
    segments.push(`拒绝文案=${formatGroupPolicySourceLabel(groupPolicy.rejectMessageSource)}`);
  }
  return segments.length > 0 ? `🧩 群规则来源：${segments.join(" / ")}` : "";
}

function buildGroupAllowFromEffectLine(groupPolicy = {}) {
  const allowFrom = Array.isArray(groupPolicy?.allowFrom) ? groupPolicy.allowFrom : [];
  const policyMode = String(groupPolicy?.policyMode ?? "").trim().toLowerCase();
  if (policyMode === "open" && allowFrom.length > 0 && !allowFrom.includes("*")) {
    return `ℹ️ 群成员白名单：已配置 ${allowFrom.length} 个成员，但当前 open 模式不会限制触发`;
  }
  if (policyMode === "deny" && groupPolicy?.policySource === "allowlist-empty") {
    return "⚠️ 群成员白名单：allowlist 未配置成员，当前已等价关闭群聊";
  }
  return "";
}

function buildGroupRejectMessageLine(groupPolicy = {}) {
  if (!groupPolicy?.rejectMessageSource || groupPolicy.rejectMessageSource === "default") {
    return "";
  }
  const text = truncateStatusSnippet(groupPolicy?.rejectMessage, 40);
  if (!text) return "";
  return `💬 群拒绝文案：${text}`;
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

function buildVoiceStatusLine(voiceConfig = {}, voiceRuntimeInfo = null) {
  if (!voiceConfig?.enabled) {
    return "⚠️ 语音消息转写回退未启用（仅使用企业微信 Recognition）";
  }

  const modelLabel = voiceConfig.modelPath || voiceConfig.model || "未配置";
  const baseLine = `✅ 语音消息转写（本地 ${voiceConfig.provider}，模型: ${modelLabel}）`;
  if (!voiceRuntimeInfo || typeof voiceRuntimeInfo !== "object") {
    return baseLine;
  }

  const commandState = voiceRuntimeInfo.resolvedCommand
    ? `命令 ${voiceRuntimeInfo.resolvedCommand}`
    : `命令缺失（检查 ${voiceRuntimeInfo.commandCandidates?.join(" / ") || "未配置"}）`;
  const ffmpegState = voiceRuntimeInfo.ffmpegEnabled
    ? voiceRuntimeInfo.ffmpegAvailable
      ? "ffmpeg 已安装"
      : "ffmpeg 缺失"
    : "ffmpeg 未启用";
  const issueSuffix =
    Array.isArray(voiceRuntimeInfo.issues) && voiceRuntimeInfo.issues.length > 0
      ? `；问题：${voiceRuntimeInfo.issues.join("；")}`
      : "";
  return `${baseLine}（${commandState}，${ffmpegState}）${issueSuffix}`;
}

function buildReasoningPolicyStatusLine(reasoningPolicy = {}) {
  const mode = String(reasoningPolicy?.mode ?? "separate").trim().toLowerCase();
  if (mode === "append") {
    return `🧠 推理展示：合并到最终回复（标题 ${String(reasoningPolicy?.title ?? "思考过程")}）`;
  }
  if (mode === "hidden") {
    return "🧠 推理展示：隐藏";
  }
  return `🧠 推理展示：分离显示（标题 ${String(reasoningPolicy?.title ?? "思考过程")}）`;
}

function buildReplyFormatStatusLine(replyFormatPolicy = {}) {
  const mode = String(replyFormatPolicy?.mode ?? "auto").trim().toLowerCase();
  if (mode === "markdown") {
    return "📝 最终回复格式：优先 markdown";
  }
  if (mode === "text") {
    return "📝 最终回复格式：强制纯文本";
  }
  return "📝 最终回复格式：自动";
}

function buildReliableDeliveryStatusLines({
  reliableDeliverySnapshot = null,
  pendingReplyPolicy = {},
  quotaTrackingPolicy = {},
} = {}) {
  const account = reliableDeliverySnapshot?.account ?? {};
  const session = reliableDeliverySnapshot?.session ?? null;
  const pendingEnabled = pendingReplyPolicy?.enabled === true;
  const pendingPersist = pendingEnabled && pendingReplyPolicy?.persist !== false;
  const quotaEnabled = quotaTrackingPolicy?.enabled !== false;
  const accountWindow = formatWecomReplyWindowState(account.replyWindowState);
  const accountQuota = quotaEnabled ? formatWecomQuotaState(account.proactiveQuotaState) : "disabled";
  const accountPending = pendingEnabled ? Number(account.pendingCount || 0) : 0;
  const accountPrefix = accountPending > 0 ? "⚠️" : "ℹ️";
  const lines = [
    `${accountPrefix} 可靠投递：窗口 ${accountWindow} / 主动发送 ${accountQuota} / Pending Reply ${
      pendingEnabled ? `${accountPending} 条${pendingPersist ? "（持久化 on）" : "（持久化 off）"}` : "off"
    }`,
  ];
  if (!session) return lines;
  const sessionWindow = formatWecomReplyWindowState(session.replyWindowState);
  const sessionPending = pendingEnabled ? Number(session.pendingCount || 0) : 0;
  const sessionFailure = String(session.lastFailureReason ?? "").trim();
  lines.push(
    `${
      sessionPending > 0 || sessionFailure ? "⚠️" : "ℹ️"
    } 当前会话：窗口 ${sessionWindow} / 待补发 ${pendingEnabled ? `${sessionPending} 条` : "off"} / 最近失败 ${
      sessionFailure || "无"
    }`,
  );
  return lines;
}

function buildAgentReadinessLines({ config = {}, voiceConfig = {} } = {}) {
  const canReceive = Boolean(config?.callbackToken && config?.callbackAesKey && config?.webhookPath);
  const canReply = Boolean(config?.corpId && config?.corpSecret && config?.agentId);
  const docEnabled = config?.tools?.doc !== false;
  const voiceEnabled = voiceConfig?.enabled === true;
  return [
    `${canReceive ? "✅" : "⚠️"} 收消息：${canReceive ? "Agent 回调已配置" : "缺少 callbackToken / callbackAesKey / webhookPath"}`,
    `${canReply ? "✅" : "⚠️"} 回消息：${canReply ? "Agent API 可用" : "缺少 corpId / corpSecret / agentId"}`,
    `${canReply ? "✅" : "⚠️"} 主动发送：${canReply ? "文本/图片/文件可主动发送" : "主动发送依赖 Agent API 配置"}`,
    `${canReply ? "✅" : "⚠️"} 媒体链路：${canReply ? "图片/文件/语音回退链路可用" : "需先完成 Agent API 配置"}`,
    `${voiceEnabled ? "✅" : "ℹ️"} 语音能力：${voiceEnabled ? "已启用本地转写回退" : "仅使用企业微信 Recognition"}`,
    `${docEnabled ? "✅" : "ℹ️"} 文档工具：${docEnabled ? "wecom_doc 已启用" : "未启用"}`,
  ];
}

function buildBotReadinessLines({ botConfig = {}, config = {} } = {}) {
  const longConnectionEnabled =
    botConfig?.longConnection?.enabled === true &&
    Boolean(String(botConfig?.longConnection?.botId ?? "").trim()) &&
    Boolean(String(botConfig?.longConnection?.secret ?? "").trim());
  const webhookEnabled =
    botConfig?.enabled === true &&
    Boolean(String(botConfig?.token ?? "").trim()) &&
    Boolean(String(botConfig?.encodingAesKey ?? "").trim()) &&
    Boolean(String(botConfig?.webhookPath ?? "").trim());
  const canReceive = longConnectionEnabled || webhookEnabled;
  const canReply = canReceive;
  const docEnabled = config?.tools?.doc !== false;
  return [
    `${canReceive ? "✅" : "⚠️"} 收消息：${canReceive ? (longConnectionEnabled ? "Bot 长连接/回调已配置" : "Bot webhook 已配置") : "缺少 Bot webhook 或长连接凭证"}`,
    `${canReply ? "✅" : "⚠️"} 回消息：${canReply ? "原生 stream + fallback 可用" : "需先完成 Bot 配置"}`,
    `${canReceive ? "ℹ️" : "⚠️"} 主动发送：${canReceive ? "Bot 以会话回包为主；跨会话主动发送建议配合 Agent/Webhook 目标" : "需先完成 Bot 配置"}`,
    `${canReceive ? "✅" : "⚠️"} 媒体链路：${canReceive ? "Bot 图片/文件/PDF 入站理解已启用" : "需先完成 Bot 配置"}`,
    `${docEnabled ? "✅" : "ℹ️"} 文档工具：${docEnabled ? "wecom_doc 已启用" : "未启用"}`,
  ];
}

export function buildAgentStatusText({
  fromUser,
  accountId,
  chatId,
  isGroupChat = false,
  config,
  accountIds,
  webhookTargetAliases,
  pluginVersion,
  voiceConfig,
  voiceRuntimeInfo,
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
  bindingsCount = 0,
  reliableDeliverySnapshot,
  pendingReplyPolicy,
  quotaTrackingPolicy,
  reasoningPolicy,
  replyFormatPolicy,
} = {}) {
  const proxyEnabled = Boolean(config?.outboundProxy);
  const voiceStatusLine = buildVoiceStatusLine(voiceConfig, voiceRuntimeInfo);
  const reasoningPolicyLine = buildReasoningPolicyStatusLine(reasoningPolicy);
  const replyFormatPolicyLine = buildReplyFormatStatusLine(replyFormatPolicy);
  const readinessLines = buildAgentReadinessLines({ config, voiceConfig });
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
  const groupAuthorizationLine = buildGroupAuthorizationStatusLine(groupPolicy);
  const groupPolicySourceLine = buildGroupPolicySourceLine(groupPolicy);
  const groupAllowFromEffectLine = buildGroupAllowFromEffectLine(groupPolicy);
  const groupRejectMessageLine = buildGroupRejectMessageLine(groupPolicy);
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
  const routePolicyLine = buildRoutePolicyStatusLine({ bindingsCount, dynamicAgentPolicy });
  const entryVisibilityLine = "✅ 微信插件入口联系人：Agent 模式可见（自建应用）";
  const observabilityLines = buildObservabilityStatusLines(observabilityMetrics);
  const reliableDeliveryLines = buildReliableDeliveryStatusLines({
    reliableDeliverySnapshot,
    pendingReplyPolicy,
    quotaTrackingPolicy,
  });

  return `📊 系统状态

渠道：企业微信 (WeCom)
会话ID：wecom:${fromUser}
账户ID：${config?.accountId || "default"}
${isGroupChat ? `当前群ID：${chatId || "unknown"}` : "当前会话：私聊"}
已配置账户：${accountIds.join(", ")}
插件版本：${pluginVersion}

功能状态：
${readinessLines.join("\n")}
✅ 文本消息
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
${groupAuthorizationLine}
${groupPolicySourceLine}
${groupAllowFromEffectLine}
${groupRejectMessageLine}
${debouncePolicyLine}
${streamingPolicyLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${webhookTargetsLine}
${dynamicAgentPolicyLine}
${routePolicyLine}
${entryVisibilityLine}
${proxyEnabled ? "✅ WeCom 出站代理已启用" : "ℹ️ WeCom 出站代理未启用"}
${voiceStatusLine}
${reasoningPolicyLine}
${replyFormatPolicyLine}
${reliableDeliveryLines.join("\n")}
${observabilityLines.status}
${observabilityLines.recent}`;
}

export function buildBotStatusText({
  fromUser,
  accountId = "default",
  chatId = "",
  isGroupChat = false,
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
  config = {},
  bindingsCount = 0,
  reliableDeliverySnapshot,
  pendingReplyPolicy,
  quotaTrackingPolicy,
  reasoningPolicy,
  replyFormatPolicy,
} = {}) {
  const readinessLines = buildBotReadinessLines({ botConfig, config });
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
  const groupAuthorizationLine = buildGroupAuthorizationStatusLine(groupPolicy);
  const groupPolicySourceLine = buildGroupPolicySourceLine(groupPolicy, { includeTrigger: false });
  const groupAllowFromEffectLine = buildGroupAllowFromEffectLine(groupPolicy);
  const groupRejectMessageLine = buildGroupRejectMessageLine(groupPolicy);
  const fallbackPolicyLine = deliveryFallbackPolicy.enabled
    ? `✅ 回包兜底链路已启用（${deliveryFallbackPolicy.order.join(" > ")}）`
    : "ℹ️ 回包兜底链路未启用（仅 active_stream）";
  const streamManagerPolicyLine = streamManagerPolicy.enabled
    ? `✅ 会话串行队列已启用（每会话并发 ${streamManagerPolicy.maxConcurrentPerSession}）`
    : "ℹ️ 会话串行队列未启用";
  const webhookBotPolicyLine = webhookBotPolicy.enabled
    ? "✅ Webhook Bot 回包已启用"
    : "ℹ️ Webhook Bot 回包未启用";
  const longConnectionLine =
    botConfig?.longConnection?.enabled === true
      ? `✅ Bot 长连接已启用（BotID=${String(botConfig?.longConnection?.botId ?? "").slice(0, 8) || "n/a"}...）`
      : "ℹ️ Bot 长连接未启用";
  const webhookTargetsLine = buildWebhookTargetStatusLine({
    aliases: allWebhookTargetAliases,
    scope: "全部账户",
  });
  const dynamicAgentPolicyLine = dynamicAgentPolicy.enabled
    ? `✅ 动态 Agent 路由已启用（mode=${dynamicAgentPolicy.mode}，用户映射 ${Object.keys(dynamicAgentPolicy.userMap || {}).length}，群映射 ${Object.keys(dynamicAgentPolicy.groupMap || {}).length}）`
    : "ℹ️ 动态 Agent 路由未启用";
  const routePolicyLine = buildRoutePolicyStatusLine({ bindingsCount, dynamicAgentPolicy });
  const entryVisibilityLine = "ℹ️ 微信插件入口联系人：Bot 模式通常不显示（请通过机器人会话/群聊入口触发）";
  const observabilityLines = buildObservabilityStatusLines(observabilityMetrics);
  const reasoningPolicyLine = buildReasoningPolicyStatusLine(reasoningPolicy);
  const replyFormatPolicyLine = buildReplyFormatStatusLine(replyFormatPolicy);
  const reliableDeliveryLines = buildReliableDeliveryStatusLines({
    reliableDeliverySnapshot,
    pendingReplyPolicy,
    quotaTrackingPolicy,
  });
  return `📊 系统状态

渠道：企业微信 AI 机器人 (Bot)
会话ID：wecom-bot:${fromUser}
插件版本：${pluginVersion}
账户ID：${accountId}
${isGroupChat ? `当前群ID：${chatId || "unknown"}` : "当前会话：私聊"}
Bot Webhook：${botConfig.webhookPath}

功能状态：
${readinessLines.join("\n")}
✅ 原生流式回复（stream）
${commandPolicyLine}
${allowFromPolicyLine}
${dmPolicyLine}
${eventPolicyLine}
${groupPolicyLine}
${groupAuthorizationLine}
${groupPolicySourceLine}
${groupAllowFromEffectLine}
${groupRejectMessageLine}
${fallbackPolicyLine}
${streamManagerPolicyLine}
${webhookBotPolicyLine}
${longConnectionLine}
${webhookTargetsLine}
${dynamicAgentPolicyLine}
${routePolicyLine}
${entryVisibilityLine}
${reasoningPolicyLine}
${replyFormatPolicyLine}
${reliableDeliveryLines.join("\n")}
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
