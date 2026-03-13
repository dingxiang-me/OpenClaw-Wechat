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
  apiProxy: {
    label: "WeCom API 代理地址",
    help: "仅替换消息发送接口的基础地址，用于代理 https://qyapi.weixin.qq.com。",
    placeholder: "https://wecom-proxy.example.com",
  },
  defaultAccount: {
    label: "默认账号",
    help: "文档工具等多账号能力未显式指定账号时优先使用该账号。",
  },
  tools: {
    label: "工具能力",
    help: "控制 OpenClaw 工具级能力是否启用。",
  },
  "tools.doc": {
    label: "启用文档工具",
  },
  "tools.docAutoGrantRequesterCollaborator": {
    label: "创建后自动加当前发送者为协作者",
    help: "仅在 WeCom 会话中生效；创建文档后会把当前发送者自动加入协作者。",
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
  "accounts.*.apiProxy": {
    label: "账号 WeCom API 代理地址",
  },
  "accounts.*.tools": {
    label: "账号工具能力",
  },
  "accounts.*.tools.doc": {
    label: "启用该账号文档工具",
  },
  "accounts.*.tools.docAutoGrantRequesterCollaborator": {
    label: "自动加当前发送者为协作者",
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
  "bot.longConnection": {
    label: "Bot 长连接",
    help: "企业微信智能机器人长连接（WebSocket）模式，无需公网回调地址。",
  },
  "bot.longConnection.enabled": {
    label: "启用 Bot 长连接",
  },
  "bot.longConnection.botId": {
    label: "BotID",
  },
  "bot.longConnection.secret": {
    label: "长连接 Secret",
    sensitive: true,
  },
  "bot.longConnection.url": {
    label: "长连接地址",
    placeholder: "wss://openws.work.weixin.qq.com",
  },
  "bot.longConnection.pingIntervalMs": {
    label: "心跳间隔（毫秒）",
  },
  "bot.longConnection.reconnectDelayMs": {
    label: "重连基准延迟（毫秒）",
  },
  "bot.longConnection.maxReconnectDelayMs": {
    label: "最大重连延迟（毫秒）",
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
  "accounts.*.bot.longConnection": {
    label: "账号 Bot 长连接",
  },
  "accounts.*.bot.longConnection.enabled": {
    label: "启用该账号长连接",
  },
  "accounts.*.bot.longConnection.botId": {
    label: "账号 BotID",
  },
  "accounts.*.bot.longConnection.secret": {
    label: "账号长连接 Secret",
    sensitive: true,
  },
  "accounts.*.bot.longConnection.url": {
    label: "账号长连接地址",
  },
  "accounts.*.bot.longConnection.pingIntervalMs": {
    label: "账号心跳间隔（毫秒）",
  },
  "accounts.*.bot.longConnection.reconnectDelayMs": {
    label: "账号重连基准延迟（毫秒）",
  },
  "accounts.*.bot.longConnection.maxReconnectDelayMs": {
    label: "账号最大重连延迟（毫秒）",
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
