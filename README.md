# OpenClaw-Wechat 企业微信插件

[中文 README](./README.md) | [English README](./README.en.md)

OpenClaw-Wechat 是一个面向 OpenClaw 的企业微信渠道插件，支持两种接入方式：

- `Agent 模式`：企业微信自建应用（XML 回调，经典模式）
- `Bot 模式`：企业微信智能机器人 API 模式（JSON 回调，原生 stream）

适用于“个人微信扫码进入企业微信应用对话”、“企业内员工问答助手”、“多账户多业务线消息分流”等场景。

## 目录

- [功能概览](#功能概览)
- [模式对比](#模式对比)
- [5 分钟极速上手](#5-分钟极速上手)
- [前置要求](#前置要求)
- [安装与加载](#安装与加载)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [消息能力矩阵](#消息能力矩阵)
- [命令与会话策略](#命令与会话策略)
- [环境变量速查](#环境变量速查)
- [与其他渠道并存建议](#与其他渠道并存建议)
- [故障排查](#故障排查)
- [开发与发布](#开发与发布)
- [FAQ](#faq)
- [版本与贡献](#版本与贡献)

## 5 分钟极速上手

适合“先跑起来再细调”的场景。

### Step 1. 安装插件

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

### Step 2. 在 OpenClaw 里加载插件

在 `~/.openclaw/openclaw.json` 增加：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "load": {
      "paths": ["/path/to/OpenClaw-Wechat"]
    },
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

### Step 3. 选择一种模式配置

| 模式 | 回调路径 | 企业微信侧类型 | 最少需要的配置 |
|---|---|---|---|
| Agent（自建应用） | `/wecom/callback` | 自建应用 API 接收 | `corpId/corpSecret/agentId/callbackToken/callbackAesKey` |
| Bot（智能机器人） | `/wecom/bot/callback` | 智能机器人 **API 模式** | `bot.enabled/token/encodingAesKey` |

### Step 4. 重启并自检

```bash
openclaw gateway restart
openclaw gateway status
npm run wecom:selfcheck -- --all-accounts
```

### Step 5. 发一条消息验证

| 验证项 | 预期结果 |
|---|---|
| 文本消息 | 机器人返回文本 |
| 图片消息（Bot） | 不再提示“图片接收失败”，可识别图像内容 |
| `openclaw gateway status` | `RPC probe: ok` 且 WeCom 状态正常 |

## 功能概览

### 核心能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 企业微信入站消息处理 | ✅ | 文本、图片、语音、链接、文件/视频（Agent + Bot） |
| AI 自动回复 | ✅ | 接入 OpenClaw Runtime，自动路由 Agent |
| Bot 原生 stream 协议 | ✅ | `msgtype=stream` 刷新与增量回包 |
| 多账户 | ✅ | `channels.wecom.accounts.<id>` |
| 发送者授权控制 | ✅ | `allowFrom` + 账户级覆盖 |
| 命令白名单 | ✅ | `/help` `/status` `/clear` 等 |
| 群聊触发策略 | ✅ | 支持 `direct/mention/keyword` 三种模式 |
| 文本防抖合并 | ✅ | 窗口期内多条消息合并投递 |
| 异步补发（超时后） | ✅ | transcript 轮询补发最终回复 |
| WeCom 出站代理 | ✅ | `outboundProxy` / `WECOM_PROXY` |

### 媒体能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 图片识别（入站） | ✅ | 支持 URL 下载、类型识别、必要时解密后识别 |
| 图片发送（出站） | ✅ | Agent 模式支持 |
| 语音/视频/文件发送（出站） | ✅ | 自动判型上传后发送（语音支持 AMR/SILK） |
| 语音转写（本地） | ✅ | 企业微信 Recognition 优先，缺失时回退本地 whisper |
| Bot 模式媒体回传 | ✅ | `active_stream` 优先 `msg_item(image)`；失败自动降级媒体链接，`response_url`/Webhook Bot 继续兜底 |
| Bot 文件入站 | ✅ | 支持 `msgtype=file` 下载并注入会话上下文 |
| Bot 引用消息上下文 | ✅ | 自动将 `quote` 内容前置到本轮上下文 |

## 模式对比

| 维度 | Agent 模式（自建应用） | Bot 模式（智能机器人 API） |
|---|---|---|
| 回调数据格式 | XML | JSON |
| 企业微信创建方式 | 应用管理 -> 自建应用 | 智能机器人 -> **API 模式** |
| 回调路径默认值 | `/wecom/callback` | `/wecom/bot/callback` |
| 回复机制 | 主动调用 WeCom 发送 API | 回调响应 `stream` + 轮询刷新 |
| 流式体验 | 多条消息模拟增量 | 原生 stream 协议 |
| 出站媒体（图/语音/视频/文件） | 支持 | 支持（`active_stream msg_item(image)` + `response_url/Webhook` 回包，video 自动按 file 回传） |
| 典型场景 | 标准企业应用、菜单/回调体系 | 对话机器人、连续流式问答 |

### 回调路径规划建议

| 场景 | 建议 |
|---|---|
| 同时开 Agent + Bot | 使用不同路径：`/wecom/callback` 与 `/wecom/bot/callback` |
| 多账户 Agent | 每个账户独立路径（如 `/wecom/sales/callback`） |
| 与 Telegram/Feishu 并存 | 不复用任何 webhook path，避免路由冲突 |

## 前置要求

| 项目 | 说明 |
|---|---|
| OpenClaw | 已安装并可正常运行 Gateway |
| 企业微信管理员权限 | 可创建应用或智能机器人并配置回调 |
| 公网入口 | 企业微信需回调到可访问 URL（常见用 Cloudflare Tunnel） |
| Node.js | 与 OpenClaw 运行环境一致 |
| 本地语音识别（可选） | `whisper-cli` 或 `whisper` |
| ffmpeg（推荐） | AMR 等格式转码时需要 |

## 安装与加载

### 方式 A：本地路径加载（推荐）

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

在 `~/.openclaw/openclaw.json` 中配置插件加载：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "load": {
      "paths": ["/path/to/OpenClaw-Wechat"]
    },
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

### 方式 B：npm 安装（包发布后）

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

## 快速开始

### 1) 企业微信侧准备

#### Agent 模式（自建应用）

1. 创建自建应用，拿到 `AgentId`、`Secret`
2. 在“我的企业”拿到 `CorpId`
3. 开启“接收消息”，配置：
   - URL: `https://你的域名/wecom/callback`
   - Token: 自定义随机字符串
   - EncodingAESKey: 企业微信生成

#### Bot 模式（智能机器人）

1. 创建智能机器人时选择 **API 模式**
2. 配置回调 URL：`https://你的域名/wecom/bot/callback`
3. 获取并保存 `token` 与 `encodingAesKey`

### 2) OpenClaw 最小配置示例

#### Agent 最小可用

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "corpId": "wwxxxx",
      "corpSecret": "xxxx",
      "agentId": 1000004,
      "callbackToken": "xxxx",
      "callbackAesKey": "xxxx",
      "webhookPath": "/wecom/callback"
    }
  }
}
```

#### Bot 最小可用（Bot-only）

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "bot": {
        "enabled": true,
        "token": "xxxx",
        "encodingAesKey": "xxxx",
        "webhookPath": "/wecom/bot/callback"
      }
    }
  }
}
```

### 3) 启动与验证

```bash
openclaw gateway restart
openclaw gateway status
openclaw plugins list
npm run wecom:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck
```

`wecom:selfcheck` 帮助：

```bash
node ./scripts/wecom-selfcheck.mjs --help
```

`wecom:bot:selfcheck` 帮助：

```bash
node ./scripts/wecom-bot-selfcheck.mjs --help
```

## 配置参考

### 主配置键（`channels.wecom`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用 WeCom 渠道 |
| `corpId` | string | - | 企业 ID（Agent 模式） |
| `corpSecret` | string | - | 应用 Secret（敏感） |
| `agentId` | number/string | - | 应用 AgentId |
| `callbackToken` | string | - | 回调 Token（敏感） |
| `callbackAesKey` | string | - | 回调 AES Key（敏感） |
| `webhookPath` | string | `/wecom/callback` | Agent 回调路径（非 default 账户未配置时自动生成 `/wecom/<accountId>/callback`） |
| `agent` | object | - | 兼容旧配置：`agent.corpId/corpSecret/agentId`（与顶层 Agent 字段等价） |
| `outboundProxy` | string | - | WeCom 出站代理 |
| `webhooks` | object | - | 命名 Webhook 目标映射（如 `{ "ops": "https://...key=xxx" }`） |
| `accounts` | object | - | 多账户配置（支持 `accounts.<id>.bot` 独立 Bot 配置） |

兼容说明：支持旧字段与旧结构迁移：`name`、`token` / `encodingAesKey`、`agent.*`、`dynamicAgents.*`、`dm.createAgentOnFirstMessage`、`dm.allowFrom`、`workspaceTemplate`、`commandAllowlist/commandBlockMessage`、`commands.blockMessage`、以及 inline 账户写法 `channels.wecom.<accountId>`。新配置建议优先使用 `accounts.<id>`、`callbackToken/callbackAesKey`、`commands.*` 与 `dynamicAgent.*`。

提示：`accounts.<id>` 现在支持 Bot-only 账号（仅配置 `bot.*`），不再强制要求 `corpId/corpSecret/agentId`。
兼容提示：当 Bot 使用默认新路径（如 `/wecom/bot/callback`）时，会自动附加 legacy alias（如 `/webhooks/wecom`），便于旧回调地址平滑迁移。

### Bot 配置（`channels.wecom.bot`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 启用 Bot 模式 |
| `token` | string | - | Bot 回调 Token（敏感） |
| `encodingAesKey` | string | - | Bot 回调 AESKey（43 位，敏感） |
| `webhookPath` | string | `/wecom/bot/callback` | Bot 回调路径（非 default 账户未配置时自动生成 `/wecom/<accountId>/bot/callback`） |
| `placeholderText` | string | `消息已收到...` | stream 初始占位文案（可设为空字符串） |
| `streamExpireMs` | integer | `600000` | stream 状态保留时间（30s~1h） |
| `replyTimeoutMs` | integer | `90000` | Bot 等待模型回包超时（15s~10m） |
| `lateReplyWatchMs` | integer | `180000` | Bot 超时后异步补发观察窗口（30s~10m） |
| `lateReplyPollMs` | integer | `2000` | Bot 异步补发轮询间隔（500ms~10s） |

### 多账户 Bot 覆盖配置（`channels.wecom.accounts.<id>.bot`）

当你启用了 `accounts` 多账户时，可以为每个账户单独配置 Bot 回调密钥、路径、超时和代理；若未配置，则回退到 `channels.wecom.bot`。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 是否启用该账户 Bot |
| `token` / `callbackToken` | string | - | 该账户 Bot 回调 Token（兼容旧字段） |
| `encodingAesKey` / `callbackAesKey` | string | - | 该账户 Bot 回调 AESKey（兼容旧字段） |
| `webhookPath` | string | `/wecom/bot/callback` | 该账户 Bot 回调路径 |
| `placeholderText` | string | `消息已收到...` | stream 初始占位文案 |
| `streamExpireMs` | integer | `600000` | stream 状态保留时间 |
| `replyTimeoutMs` | integer | `90000` | Bot 等待模型回包超时 |
| `lateReplyWatchMs` | integer | `180000` | 超时后异步补发观察窗口 |
| `lateReplyPollMs` | integer | `2000` | 异步补发轮询间隔 |
| `outboundProxy` / `proxyUrl` / `proxy` | string | - | 该账户 Bot 专用代理（优先于全局） |

### 授权与指令策略

| 模块 | 配置键 | 作用 |
|---|---|---|
| 发送者授权 | `allowFrom` / `accounts.<id>.allowFrom` | 限定可对话用户；支持 `*` |
| 拒绝文案 | `allowFromRejectMessage` | 未授权提示 |
| 管理员 | `adminUsers` | 绕过命令白名单 |
| 命令白名单 | `commands.enabled` + `commands.allowlist` | 限制 `/` 指令 |
| 群聊触发 | `groupChat.enabled` + `triggerMode` + `mentionPatterns` + `triggerKeywords` | 控制群消息触发条件 |
| 动态路由 | `dynamicAgent.*`（兼容 `dynamicAgents.*`、`dm.createAgentOnFirstMessage`） | 动态 Agent + workspace bootstrap 播种 |

### 吞吐与稳定性

| 模块 | 配置键 | 说明 |
|---|---|---|
| 文本防抖 | `debounce.enabled/windowMs/maxBatch` | 合并短时间多条文本 |
| Agent 增量回包 | `streaming.enabled/minChars/minIntervalMs` | 多消息模拟流式 |
| 异步补发 | `WECOM_LATE_REPLY_WATCH_MS/POLL_MS` | dispatch 超时后补发最终回复 |

### 语音转写（本地）

| 键 | 默认 | 说明 |
|---|---|---|
| `voiceTranscription.enabled` | `true` | 开启回退转写 |
| `provider` | `local-whisper-cli` | `local-whisper-cli` / `local-whisper` |
| `command` | 自动探测 | 本地命令路径 |
| `modelPath` | - | whisper-cli 模型路径 |
| `model` | `base` | whisper 模型名 |
| `timeoutMs` | `120000` | 单次转写超时 |
| `maxBytes` | `10485760` | 最大音频大小 |
| `ffmpegEnabled` | `true` | 不兼容格式自动转码 |
| `transcodeToWav` | `true` | 优先转为 wav |

### 多账户示例

```json
{
  "channels": {
    "wecom": {
      "outboundProxy": "http://127.0.0.1:7890",
      "accounts": {
        "default": {
          "enabled": true,
          "corpId": "ww-default",
          "corpSecret": "secret-default",
          "agentId": 1000004,
          "callbackToken": "token-default",
          "callbackAesKey": "aes-default",
          "webhookPath": "/wecom/callback",
          "allowFrom": ["*"]
        },
        "sales": {
          "enabled": true,
          "corpId": "ww-sales",
          "corpSecret": "secret-sales",
          "agentId": 1000005,
          "callbackToken": "token-sales",
          "callbackAesKey": "aes-sales",
          "webhookPath": "/wecom/sales/callback",
          "outboundProxy": "http://10.0.0.5:8888",
          "bot": {
            "enabled": true,
            "token": "sales-bot-token",
            "encodingAesKey": "sales-bot-aes",
            "webhookPath": "/wecom/sales/bot/callback",
            "replyTimeoutMs": 120000,
            "outboundProxy": "http://10.0.0.9:7890"
          },
          "allowFrom": ["alice", "wecom:bob"],
          "allowFromRejectMessage": "销售助手未授权，请联系管理员。"
        }
      }
    }
  }
}
```

## 消息能力矩阵

### Agent 模式

| 类型 | 入站 | 出站 | 备注 |
|---|---|---|---|
| 文本 | ✅ | ✅ | 自动分段 |
| 图片 | ✅ | ✅ | 入站可识别，出站可发送 |
| 语音 | ✅ | ✅ | 入站支持本地转写回退；出站支持 AMR/SILK |
| 视频 | ✅ | ✅ | 下载并可回包 |
| 文件 | ✅ | ✅ | 下载并可回包 |
| 链接 | ✅ | ❌ | 提取标题/描述/URL |

### Bot 模式

| 类型 | 入站 | 出站 | 备注 |
|---|---|---|---|
| 文本 | ✅ | ✅ | 原生 stream |
| 图片 | ✅ | ✅ | `response_url` mixed + webhook fallback |
| 语音 | ✅ | ✅ | 以文本结果回传 |
| 文件 | ✅ | ✅ | Bot 文件入站下载；出站可按 file 回传 |
| mixed（图文） | ✅ | ✅ | 聚合后回文本 |
| 链接/位置 | ✅ | ✅ | 转换为文本上下文 |

## 命令与会话策略

### 命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看帮助 |
| `/status` | 查看运行状态 |
| `/clear` | 清理会话（兼容映射到 `/reset`） |
| `/reset` | 重置会话 |
| `/new` | 新建会话（由上层运行时支持） |
| `/compact` | 压缩会话（由上层运行时支持） |

### 会话策略

- 默认一用户一会话：`wecom:<userid>`
- 群聊可配置“仅 @ 才触发”，避免误触发

### 出站目标格式

- `user`：`wecom:alice` / `user:alice`
- `group(chat)`：`group:wrxxxx` / `chat:wcxxxx`（自动走 `appchat/send`）
- `party`：`party:2` / `dept:2`
- `tag`：`tag:ops`
- `webhook`：`webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx` 或 `webhook:key:xxx`
- `webhook(命名)`：`webhook:ops`（从 `channels.wecom.webhooks.ops` 或 `accounts.<id>.webhooks.ops` 解析）

## 环境变量速查

### 核心与回调

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECOM_CORP_ID` | Agent 必填 | 企业 ID |
| `WECOM_CORP_SECRET` | Agent 必填 | 应用 Secret |
| `WECOM_AGENT_ID` | Agent 必填 | AgentId |
| `WECOM_CALLBACK_TOKEN` | Agent 必填 | 回调 Token |
| `WECOM_CALLBACK_AES_KEY` | Agent 必填 | 回调 AESKey |
| `WECOM_WEBHOOK_PATH` | 否 | Agent 回调路径（默认 `/wecom/callback`） |
| `WECOM_WEBHOOK_TARGETS` | 否 | 命名 Webhook 目标映射（`name=url`，多个用 `,`/`;` 分隔） |

### Bot

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECOM_BOT_ENABLED` | 否 | 是否启用 Bot 模式 |
| `WECOM_BOT_TOKEN` | Bot 必填 | Bot Token |
| `WECOM_BOT_ENCODING_AES_KEY` | Bot 必填 | Bot EncodingAESKey |
| `WECOM_BOT_WEBHOOK_PATH` | 否 | Bot 回调路径 |
| `WECOM_BOT_PLACEHOLDER_TEXT` | 否 | stream 占位文案 |
| `WECOM_BOT_STREAM_EXPIRE_MS` | 否 | stream 保留时长 |
| `WECOM_BOT_REPLY_TIMEOUT_MS` | 否 | Bot 等待模型回包超时 |
| `WECOM_BOT_LATE_REPLY_WATCH_MS` | 否 | Bot 超时后补发观察窗口 |
| `WECOM_BOT_LATE_REPLY_POLL_MS` | 否 | Bot 补发轮询间隔 |
| `WECOM_<ACCOUNT>_BOT_*` | 否 | 账户级 Bot 覆盖（如 `WECOM_SALES_BOT_TOKEN`） |
| `WECOM_<ACCOUNT>_BOT_PROXY` | 否 | 账户级 Bot 媒体下载/回包代理 |

### 策略与流控

| 变量 | 说明 |
|---|---|
| `WECOM_ALLOW_FROM` / `WECOM_<ACCOUNT>_ALLOW_FROM` | 发送者白名单 |
| `WECOM_ALLOW_FROM_REJECT_MESSAGE` / `WECOM_<ACCOUNT>_ALLOW_FROM_REJECT_MESSAGE` | 未授权提示 |
| `WECOM_ADMIN_USERS` | 管理员用户列表 |
| `WECOM_COMMANDS_ENABLED` / `WECOM_COMMANDS_ALLOWLIST` / `WECOM_COMMANDS_REJECT_MESSAGE` | 命令白名单策略 |
| `WECOM_GROUP_CHAT_ENABLED` / `WECOM_GROUP_CHAT_REQUIRE_MENTION` / `WECOM_GROUP_CHAT_MENTION_PATTERNS` | 群触发策略 |
| `WECOM_DEBOUNCE_ENABLED` / `WECOM_DEBOUNCE_WINDOW_MS` / `WECOM_DEBOUNCE_MAX_BATCH` | 文本防抖 |
| `WECOM_STREAMING_ENABLED` / `WECOM_STREAMING_MIN_CHARS` / `WECOM_STREAMING_MIN_INTERVAL_MS` | Agent 增量回包 |
| `WECOM_LATE_REPLY_WATCH_MS` / `WECOM_LATE_REPLY_POLL_MS` | 异步补发窗口与轮询频率 |

### 语音回退转写

| 变量 | 说明 |
|---|---|
| `WECOM_VOICE_TRANSCRIBE_ENABLED` | 启用本地语音转写回退 |
| `WECOM_VOICE_TRANSCRIBE_PROVIDER` | `local-whisper-cli` / `local-whisper` |
| `WECOM_VOICE_TRANSCRIBE_COMMAND` | 转写命令 |
| `WECOM_VOICE_TRANSCRIBE_MODEL_PATH` | whisper-cli 模型路径 |
| `WECOM_VOICE_TRANSCRIBE_MODEL` | whisper 模型名 |
| `WECOM_VOICE_TRANSCRIBE_TIMEOUT_MS` | 转写超时 |
| `WECOM_VOICE_TRANSCRIBE_MAX_BYTES` | 音频大小上限 |
| `WECOM_VOICE_TRANSCRIBE_FFMPEG_ENABLED` | 是否允许 ffmpeg 转码 |
| `WECOM_VOICE_TRANSCRIBE_TRANSCODE_TO_WAV` | 是否优先转 WAV |

## 与其他渠道并存建议

建议固定以下三点，减少“偶发无回复/冲突”风险：

1. 配置 `plugins.allow` 显式白名单（至少包含 `openclaw-wechat`）
2. 各渠道使用独立 webhook path，不复用
3. 同一台机器尽量只运行一个 OpenClaw gateway 进程

详细说明见：[`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md)

## 故障排查

### 快速定位表

| 现象 | 先看什么 | 常见原因 | 处理建议 |
|---|---|---|---|
| 回调验证失败 | `curl https://域名/wecom/callback` | URL 不通、Token/AESKey 不一致 | 先通公网，再核对配置 |
| `curl /wecom/callback` 返回 WebUI 页面 | 反向代理路由与回调路径 | 域名把 `/wecom/callback` 转发到了前端/静态站点 | 单独为 `/wecom/*` 配置反向代理到 OpenClaw 网关端口 |
| 能收到消息但不回复 | `openclaw gateway status` + `openclaw logs --follow` | 模型超时、会话排队、权限策略拦截 | 查看 dispatch/allowFrom/commands 日志 |
| Bot 图片识别失败 | `wecom(bot): failed to fetch image url` | URL 失效、返回非图像流 | 已支持 octet-stream+解密兜底，先升级到最新版本 |
| 语音转写失败 | `wecom: voice transcription failed` | 本地命令或模型路径错误 | 检查 `command`、`modelPath`、`ffmpeg` |
| 启动出现账号体检告警 | `wecom: account diagnosis ...` | 多账号 Token/Agent/路径存在冲突风险 | 按日志 `code` 与账户列表调整配置，优先处理 `warn` 级别 |
| gettoken 失败 | 企业微信 API 返回码 | CorpId/Secret 错或网络受限 | 检查凭据/配置代理 |

### 推荐检查命令

```bash
openclaw gateway status
openclaw status --deep
openclaw logs --follow
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --account default
npm run wecom:bot:selfcheck
```

## 开发与发布

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 语法与单测 |
| `WECOM_E2E_ENABLE=1 npm run test:e2e:remote` | 运行远程 E2E 测试（默认跳过，需配 `WECOM_E2E_BOT_URL`/`WECOM_E2E_AGENT_URL`） |
| `npm run wecom:selfcheck -- --all-accounts` | 配置+网络体检 |
| `npm run wecom:agent:selfcheck -- --account <id>` | Agent 端到端链路体检（URL 验证 + 加密 POST） |
| `npm run wecom:bot:selfcheck` | Bot 端到端链路体检（签名/加密/stream-refresh） |
| `npm run wecom:remote:e2e -- --mode all --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 远端矩阵验证（Agent+Bot） |
| `npm run wecom:e2e:scenario -- --scenario full-smoke --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 场景化 E2E（预置 smoke/queue 场景） |
| `GitHub Actions -> CI -> Run workflow (run_remote_e2e=true)` | 在仓库 CI 手动触发远程 E2E（使用 `WECOM_E2E_*` secrets） |
| `npm run wecom:smoke` | 升级后快速回归（Agent 主链路） |
| `npm run wecom:smoke -- --with-bot-e2e` | 升级后快速回归（含 Bot E2E） |
| `openclaw gateway restart` | 重启网关 |

### 发版建议流程

1. 更新 `CHANGELOG.md` 与版本号
2. 运行 `npm test` 与 `wecom:selfcheck`
3. 打 tag 并发布 GitHub Release
4. （可选）发布 npm 包

## FAQ

### Q1：Bot 模式回调一直失败？
通常是机器人创建成“标准模式”。请重建为 **API 模式**（JSON 回调）。

### Q2：为什么图片偶发识别失败？
企业微信可能返回非标准 `content-type` 或加密媒体流。插件已增加类型识别与解密兜底；仍失败时请查看日志中的 header/下载错误。

### Q3：Telegram 和 WeCom 会互相影响吗？
理论上独立；实战中若复用 webhook 路径、多进程抢占、或 `plugins.allow` 未收紧，会出现干扰。按“并存建议”配置可大幅降低风险。

### Q4：支持个人微信吗？
支持企业微信场景下的“微信插件入口”（个人微信扫码进入企业应用对话），不等同于“个人微信网页版协议”。

### Q5：为什么 `curl https://域名/wecom/callback` 返回的是 WebUI 页面？
这是路由层问题，不是插件正常行为。`GET /wecom/callback`（无 `echostr`）应返回纯文本 `wecom webhook ok`。  
若返回 WebUI，说明你的反向代理把该路径转发到了前端服务而不是 OpenClaw 网关。

建议按顺序排查：
1. 本机验证：`curl http://127.0.0.1:8885/wecom/callback`（应返回 `wecom webhook ok`）
2. 公网验证：`curl -i https://你的域名/wecom/callback`
3. 代理配置：为 `/wecom/*` 单独反代到 OpenClaw 网关端口，不要落到 WebUI 路由

### Q6：自建应用群聊怎么开？为什么群里不 @ 就不触发？
先区分两种通道能力：
1. **群机器人（Webhook Bot）**：可直接添加到企微群，天然适合群聊收发。
2. **自建应用（Agent 回调）**：插件支持处理 `ChatId` 群消息；但是否能收到“普通群消息”取决于企业微信实际下发能力（很多租户里普通群只能加机器人，无法像成员一样加自建应用）。

如果你的场景是“普通群里直接聊天并稳定触发”，优先用 **Webhook Bot 模式**。  
如果你确认企业微信会把群消息回调到自建应用（日志里有 `chatId=...`），再配置触发模式：

```json
{
  "channels": {
    "wecom": {
      "groupChat": {
        "enabled": true,
        "triggerMode": "direct"
      }
    }
  }
}
```

同时确认企业微信侧前提：
1. 自建应用已开启“接收消息”并完成 URL 验证
2. 应用可见范围包含该群成员
3. 日志里能看到 `chatId=...`（若没有 `chatId`，说明企业微信没有把群消息推送到该回调）

若你在企微侧只能给群添加“机器人”而不能添加“自建应用”，这不是插件配置问题，属于企微产品形态差异；建议走 Bot 模式承载群聊，自建应用用于私聊/应用会话/主动推送。

## 版本与贡献

- 版本记录：[`CHANGELOG.md`](./CHANGELOG.md)
- 渠道文档：[`docs/channels/wecom.md`](./docs/channels/wecom.md)
- 问题排查：[`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md)
- 许可证：MIT

欢迎提交 Issue / PR。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=dingxiang-me/OpenClaw-Wechat&type=Date)](https://star-history.com/#dingxiang-me/OpenClaw-Wechat&Date)
