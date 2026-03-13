import { wecomChannelConfigSchema, wecomChannelConfigUiHints } from "./channel-config-schema.js";
import {
  getWecomChannelInboundActivity,
  getWecomInboundActivity,
} from "./channel-status-state.js";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomChannelPlugin: ${name} is required`);
  }
}

function readString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function readNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeTimestampMs(value) {
  if (value == null || value === "") return null;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return direct < 1e12 ? Math.floor(direct * 1000) : Math.floor(direct);
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return null;
}

function resolveBotCallbackConfig(cfg, accountId = "default") {
  const normalizedAccountId = readString(accountId).toLowerCase() || "default";
  const channelConfig = cfg?.channels?.wecom;
  const accountConfig = channelConfig?.accounts?.[normalizedAccountId];
  const accountBot = accountConfig?.bot;
  const channelBot = channelConfig?.bot;

  const enabled =
    accountBot?.enabled ??
    channelBot?.enabled ??
    false;
  const token = readString(
    accountBot?.token ??
      accountBot?.callbackToken ??
      channelBot?.token ??
      channelBot?.callbackToken ??
      channelConfig?.token ??
      channelConfig?.callbackToken,
  );
  const aesKey = readString(
    accountBot?.encodingAesKey ??
      accountBot?.callbackAesKey ??
      channelBot?.encodingAesKey ??
      channelBot?.callbackAesKey ??
      channelConfig?.encodingAesKey ??
      channelConfig?.callbackAesKey,
  );
  const webhookPath = readString(
    accountBot?.webhookPath ?? channelBot?.webhookPath,
  );
  const longConnection =
    accountBot?.longConnection && typeof accountBot.longConnection === "object"
      ? accountBot.longConnection
      : channelBot?.longConnection && typeof channelBot.longConnection === "object"
        ? channelBot.longConnection
        : {};
  const longConnectionEnabled = longConnection?.enabled === true;
  const longConnectionBotId = readString(longConnection?.botId ?? longConnection?.botid);
  const longConnectionSecret = readString(longConnection?.secret);

  return {
    enabled: enabled === true,
    token,
    aesKey,
    webhookPath,
    longConnectionEnabled,
    longConnectionBotId,
    longConnectionSecret,
  };
}

function hasConfiguredBotCallback(cfg, accountId = "default") {
  const bot = resolveBotCallbackConfig(cfg, accountId);
  return (
    bot.enabled &&
    ((Boolean(bot.token) && Boolean(bot.aesKey)) ||
      (bot.longConnectionEnabled && Boolean(bot.longConnectionBotId) && Boolean(bot.longConnectionSecret)))
  );
}

function hasConfiguredAgentCredentials(account) {
  return Boolean(
    readString(account?.corpId) &&
      readString(account?.corpSecret) &&
      readNumber(account?.agentId),
  );
}

function buildWecomAccountSnapshot(account, cfg, runtime = {}) {
  const accountId = readString(account?.accountId).toLowerCase() || "default";
  const agentConfigured = hasConfiguredAgentCredentials(account);
  const botConfig = resolveBotCallbackConfig(cfg, accountId);
  const botConfigured = hasConfiguredBotCallback(cfg, accountId);
  const configured = agentConfigured || botConfigured;
  const enabled = account?.enabled !== false;
  const inboundActivity = getWecomInboundActivity(accountId);
  const mode = agentConfigured && botConfigured ? "agent+bot" : botConfigured ? "bot" : "agent";
  const running = runtime?.running ?? (enabled && configured);
  const connected =
    runtime?.connected ??
    inboundActivity?.connected ??
    (running && configured);
  const lastInboundAt =
    normalizeTimestampMs(runtime?.lastInboundAt ?? runtime?.lastInbound) ??
    normalizeTimestampMs(inboundActivity?.lastInboundAtMs ?? inboundActivity?.lastInbound) ??
    null;
  const localizedName = accountId === "default" ? "默认账号" : accountId;
  return {
    ...runtime,
    accountId,
    name: readString(account?.name) || localizedName,
    displayName: readString(account?.name) || localizedName,
    enabled,
    configured,
    running,
    connected,
    lastInboundAt,
    mode,
    webhookPath: readString(account?.webhookPath) || botConfig.webhookPath || runtime?.webhookPath || undefined,
  };
}

export function createWecomChannelPlugin({
  listWecomAccountIds,
  getWecomConfig,
  getGatewayRuntime,
  normalizeWecomResolvedTarget,
  formatWecomTargetForLog,
  sendWecomWebhookText,
  sendWecomWebhookMediaBatch,
  sendWecomOutboundMediaBatch,
  sendWecomText,
} = {}) {
  assertFunction("listWecomAccountIds", listWecomAccountIds);
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("getGatewayRuntime", getGatewayRuntime);
  assertFunction("normalizeWecomResolvedTarget", normalizeWecomResolvedTarget);
  assertFunction("formatWecomTargetForLog", formatWecomTargetForLog);
  assertFunction("sendWecomWebhookText", sendWecomWebhookText);
  assertFunction("sendWecomWebhookMediaBatch", sendWecomWebhookMediaBatch);
  assertFunction("sendWecomOutboundMediaBatch", sendWecomOutboundMediaBatch);
  assertFunction("sendWecomText", sendWecomText);

  return {
    id: "wecom",
    meta: {
      id: "wecom",
      label: "企业微信 WeCom",
      selectionLabel: "企业微信 WeCom（自建应用/Bot）",
      docsPath: "/channels/wecom",
      blurb: "企业微信消息通道（自建应用回调 + Bot 回调 + 发送 API）。",
      aliases: ["wework", "qiwei", "wxwork"],
    },
    configSchema: {
      schema: wecomChannelConfigSchema,
      uiHints: wecomChannelConfigUiHints,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: {
        inbound: true,
        outbound: true,
      },
      markdown: true,
    },
    config: {
      listAccountIds: (cfg) => {
        const accountIds = listWecomAccountIds({ config: cfg });
        if (accountIds.length > 0) return accountIds;
        return hasConfiguredBotCallback(cfg, "default") ? ["default"] : [];
      },
      resolveAccount: (cfg, accountId) =>
        (getWecomConfig({ config: cfg }, accountId ?? "default") ?? {
          accountId: accountId ?? "default",
        }),
      isConfigured: (account, cfg) =>
        hasConfiguredAgentCredentials(account) || hasConfiguredBotCallback(cfg, account?.accountId ?? "default"),
      describeAccount: (account, cfg) => buildWecomAccountSnapshot(account, cfg),
    },
    status: {
      buildAccountSnapshot: ({ account, cfg, runtime }) =>
        buildWecomAccountSnapshot(account, cfg, runtime),
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot?.configured ?? false,
        running: snapshot?.running ?? false,
        connected:
          snapshot?.connected ??
          (snapshot?.running && snapshot?.configured) ??
          null,
        lastInbound:
          normalizeTimestampMs(snapshot?.lastInboundAt ?? snapshot?.lastInbound) ??
          normalizeTimestampMs(
            getWecomChannelInboundActivity([snapshot?.accountId]).lastInboundAtMs,
          ) ??
          null,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) => {
        const target = normalizeWecomResolvedTarget(to);
        if (!target) return { ok: false, error: new Error("WeCom requires --to <target>") };
        return { ok: true, to: target };
      },
      sendText: async ({ to, text, accountId }) => {
        const runtime = getGatewayRuntime();
        const target = normalizeWecomResolvedTarget(to);
        if (!target) {
          return { ok: false, error: new Error("WeCom target invalid") };
        }
        const config = getWecomConfig({ config: runtime?.config }, accountId);
        if (target.webhook) {
          await sendWecomWebhookText({
            webhook: target.webhook,
            webhookTargets: config?.webhooks,
            text,
            logger: runtime?.logger,
            proxyUrl: config?.outboundProxy,
          });
          runtime?.logger?.info?.(`wecom: outbound sendText target=${formatWecomTargetForLog(target)}`);
          return { ok: true, provider: "wecom-webhook" };
        }
        if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
          return { ok: false, error: new Error("WeCom not configured (check channels.wecom in openclaw.json)") };
        }
        await sendWecomText({
          corpId: config.corpId,
          corpSecret: config.corpSecret,
          agentId: config.agentId,
          toUser: target.toUser,
          toParty: target.toParty,
          toTag: target.toTag,
          chatId: target.chatId,
          text,
          logger: runtime?.logger,
          proxyUrl: config.outboundProxy,
          apiProxy: config.apiProxy,
        });
        runtime?.logger?.info?.(`wecom: outbound sendText target=${formatWecomTargetForLog(target)}`);
        return { ok: true, provider: "wecom" };
      },
    },
    inbound: {
      deliverReply: async ({ to, text, accountId, mediaUrl, mediaUrls, mediaType }) => {
        const runtime = getGatewayRuntime();
        const target = normalizeWecomResolvedTarget(to);
        if (!target) {
          throw new Error("WeCom deliverReply target invalid");
        }
        const config = getWecomConfig({ config: runtime?.config }, accountId);
        const proxyUrl = config?.outboundProxy;
        const apiProxy = config?.apiProxy;
        if (target.webhook) {
          const webhookMediaResult = await sendWecomWebhookMediaBatch({
            webhook: target.webhook,
            webhookTargets: config?.webhooks,
            mediaUrl,
            mediaUrls,
            mediaType,
            logger: runtime?.logger,
            proxyUrl,
          });
          if (webhookMediaResult.failed.length > 0) {
            runtime?.logger?.warn?.(
              `wecom: webhook target failed to send ${webhookMediaResult.failed.length} media item(s)`,
            );
          }
          if (text) {
            await sendWecomWebhookText({
              webhook: target.webhook,
              webhookTargets: config?.webhooks,
              text,
              logger: runtime?.logger,
              proxyUrl,
            });
          }
          if (!text && webhookMediaResult.total > 0 && webhookMediaResult.sentCount === 0) {
            throw new Error("WeCom webhook media send failed");
          }
          return { ok: true };
        }
        if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
          throw new Error("WeCom not configured (check channels.wecom in openclaw.json)");
        }
        const mediaResult = await sendWecomOutboundMediaBatch({
          corpId: config.corpId,
          corpSecret: config.corpSecret,
          agentId: config.agentId,
          toUser: target.toUser,
          toParty: target.toParty,
          toTag: target.toTag,
          chatId: target.chatId,
          mediaUrl,
          mediaUrls,
          mediaType,
          logger: runtime?.logger,
          proxyUrl,
          apiProxy,
        });
        if (mediaResult.failed.length > 0) {
          runtime?.logger?.warn?.(`wecom: failed to send ${mediaResult.failed.length} outbound media item(s)`);
        }
        if (text) {
          await sendWecomText({
            corpId: config.corpId,
            corpSecret: config.corpSecret,
            agentId: config.agentId,
            toUser: target.toUser,
            toParty: target.toParty,
            toTag: target.toTag,
            chatId: target.chatId,
            text,
            logger: runtime?.logger,
            proxyUrl,
            apiProxy,
          });
        }
        return { ok: true };
      },
    },
  };
}
