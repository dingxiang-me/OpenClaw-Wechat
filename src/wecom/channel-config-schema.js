import pluginManifest from "../../openclaw.plugin.json" with { type: "json" };

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

const manifestConfigSchema = asObject(pluginManifest?.configSchema);
const manifestUiHints = asObject(pluginManifest?.uiHints) ?? {};

const localizedUiHints = {
  name: {
    label: "渠道显示名",
    help: "仅用于展示，不影响消息路由。",
  },
  enabled: {
    label: "启用企业微信渠道",
    help: "开启后才会接收/发送企业微信消息。",
  },
  corpId: {
    label: "企业 ID（CorpId）",
    placeholder: "wwxxxxxxxxxxxxxxxx",
  },
  corpSecret: {
    label: "应用 Secret（CorpSecret）",
    sensitive: true,
  },
  agentId: {
    label: "应用 AgentId",
    placeholder: "1000002",
  },
  callbackToken: {
    label: "回调 Token",
    sensitive: true,
  },
  callbackAesKey: {
    label: "回调 EncodingAESKey",
    sensitive: true,
  },
  webhookPath: {
    label: "自建应用回调路径",
    placeholder: "/wecom/callback",
  },
  outboundProxy: {
    label: "WeCom 出站代理",
    placeholder: "http://127.0.0.1:7890",
  },
  accounts: {
    label: "多账号配置",
    help: "按账户 ID 管理多套企业微信配置。",
  },
  "accounts.*.enabled": {
    label: "启用该账号",
  },
  "accounts.*.name": {
    label: "账号名称",
  },
  "accounts.*.corpId": {
    label: "账号 CorpId",
  },
  "accounts.*.corpSecret": {
    label: "账号 CorpSecret",
    sensitive: true,
  },
  "accounts.*.agentId": {
    label: "账号 AgentId",
  },
  "accounts.*.callbackToken": {
    label: "账号回调 Token",
    sensitive: true,
  },
  "accounts.*.callbackAesKey": {
    label: "账号回调 EncodingAESKey",
    sensitive: true,
  },
  "accounts.*.webhookPath": {
    label: "账号回调路径",
  },
  bot: {
    label: "企业微信 Bot 模式",
    help: "用于企业微信群机器人/Bot 回调与回包。",
  },
  "bot.enabled": {
    label: "启用 Bot 模式",
  },
  "bot.token": {
    label: "Bot Token",
    sensitive: true,
  },
  "bot.encodingAesKey": {
    label: "Bot EncodingAESKey",
    sensitive: true,
  },
  "bot.webhookPath": {
    label: "Bot 回调路径",
    placeholder: "/wecom/bot/callback",
  },
  "bot.replyTimeoutMs": {
    label: "Bot 回复超时（毫秒）",
  },
  "bot.streamExpireMs": {
    label: "Bot 流会话保留（毫秒）",
  },
  "bot.placeholderText": {
    label: "Bot 首包占位文本",
  },
  webhookBot: {
    label: "Webhook Bot 出站回包",
  },
  "webhookBot.enabled": {
    label: "启用 Webhook Bot 回包",
  },
  "webhookBot.url": {
    label: "Webhook Bot URL",
  },
  "webhookBot.key": {
    label: "Webhook Bot Key",
    sensitive: true,
  },
  groupChat: {
    label: "群聊触发策略",
  },
  "groupChat.triggerMode": {
    label: "群聊触发模式",
  },
  dynamicAgent: {
    label: "动态 Agent 路由",
  },
  dm: {
    label: "私聊策略",
  },
  commands: {
    label: "指令白名单",
  },
  events: {
    label: "事件消息策略",
  },
  voiceTranscription: {
    label: "语音转写",
  },
  "voiceTranscription.enabled": {
    label: "启用语音转写",
  },
  "voiceTranscription.command": {
    label: "本地转写命令",
    placeholder: "whisper / whisper-cli",
  },
  "voiceTranscription.modelPath": {
    label: "本地模型路径",
  },
  "voiceTranscription.language": {
    label: "转写语言",
    placeholder: "zh",
  },
};

export const wecomChannelConfigSchema = manifestConfigSchema ?? {
  type: "object",
  additionalProperties: true,
  properties: {},
};

export const wecomChannelConfigUiHints = {
  ...manifestUiHints,
  ...localizedUiHints,
};
