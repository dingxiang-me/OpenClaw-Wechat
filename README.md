# OpenClaw-Wechat 企业微信插件

> 让你的 OpenClaw AI 助手接入企业微信，通过自建应用实现智能对话。
> 接入企业微信后，可在个人微信进行对话（菜单：我的企业—微信插件，使用个人微信扫码）

## 功能特性

### 核心功能
- [x] 支持个人微信对话
- [x] 接收企业微信消息（文本、图片、语音）
- [x] 自动调用 AI 代理处理消息
- [x] 将 AI 回复发送回企业微信用户
- [x] 消息签名验证和 AES 加密解密
- [x] Webhook URL 验证（企业微信回调配置）
- [x] access_token 自动缓存和刷新（支持多账户）

### 媒体功能
- [x] 图片消息接收和 AI 识别（Vision 能力）
- [x] 图片消息发送
- [x] 语音消息转文字（优先企业微信 Recognition，缺失时自动回退 STT）

### 用户体验
- [x] 命令系统（/help、/status、/clear）
- [x] Markdown 格式自动转换
- [x] 长消息自动分段（2048 字符限制）
- [x] API 限流保护

### 高级功能
- [x] 多账户支持
- [x] 群聊支持
- [x] Token 并发安全
- [x] wecom:selfcheck 一键自检

## 前置要求

- [OpenClaw](https://openclaw.ai) 已安装并配置
- 企业微信管理员权限
- 公网可访问的服务器（用于接收回调）
- 本地语音识别命令（推荐 `whisper-cli`，可选 `whisper`）
- （推荐）`ffmpeg`，用于 AMR 等不兼容格式自动转码后再转写

## 安装

### 方式一：本地路径加载

1. 克隆本仓库：

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

2. 在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中添加插件路径：

```json
{
  "plugins": {
    "enabled": true,
    "allow": [
      "openclaw-wechat"
    ],
    "load": {
      "paths": [
        "/path/to/OpenClaw-Wechat"
      ]
    },
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

说明：示例里的 `for-tests-ggml-tiny.bin` 仅用于快速验证，线上建议换成更高质量模型（如 `ggml-base` / `ggml-small`）。

### 方式二：npm 安装（即将支持）

```bash
openclaw plugins install openclaw-wechat
```

## 配置

### 第一步：创建企业微信自建应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入 **应用管理** → **自建** → **创建应用**
3. 填写应用名称、Logo、可见范围等信息
4. 创建完成后，记录以下信息：
   - **AgentId**：应用的 AgentId
   - **Secret**：应用的 Secret

### 第二步：获取企业信息

1. 在管理后台首页，点击 **我的企业**
2. 记录 **企业ID (CorpId)**

### 第三步：配置接收消息

1. 进入你创建的应用 → **接收消息** → **设置API接收**
2. 填写：
   - **URL**：`https://你的域名/wecom/callback`
   - **Token**：自定义一个 Token（随机字符串）
   - **EncodingAESKey**：点击随机生成
3. 先不要保存！需要先启动 OpenClaw 服务

### 第四步：配置账号

推荐在 `~/.openclaw/openclaw.json` 使用 `channels.wecom`（原生结构）：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "corpId": "默认账户企业ID",
      "corpSecret": "默认账户Secret",
      "agentId": 1000004,
      "callbackToken": "默认账户Token",
      "callbackAesKey": "默认账户EncodingAESKey",
      "webhookPath": "/wecom/callback",
      "voiceTranscription": {
        "enabled": true,
        "provider": "local-whisper-cli",
        "command": "whisper-cli",
        "modelPath": "/usr/local/opt/whisper-cpp/share/whisper-cpp/for-tests-ggml-tiny.bin",
        "model": "base",
        "language": "zh",
        "timeoutMs": 120000,
        "maxBytes": 10485760,
        "ffmpegEnabled": true,
        "transcodeToWav": true
      }
    }
  }
}
```

多账户（推荐）：

```json
{
  "channels": {
    "wecom": {
      "accounts": {
        "default": {
          "enabled": true,
          "corpId": "默认账户企业ID",
          "corpSecret": "默认账户Secret",
          "agentId": 1000004,
          "callbackToken": "默认账户Token",
          "callbackAesKey": "默认账户EncodingAESKey",
          "webhookPath": "/wecom/callback"
        },
        "sales": {
          "enabled": true,
          "corpId": "销售账户企业ID",
          "corpSecret": "销售账户Secret",
          "agentId": 1000005,
          "callbackToken": "销售账户Token",
          "callbackAesKey": "销售账户EncodingAESKey",
          "webhookPath": "/wecom/sales/callback"
        }
      }
    }
  }
}
```

兼容旧配置：也支持 `env.vars`（`WECOM_*` / `WECOM_<ACCOUNT>_*`）：

```json
{
  "env": {
    "vars": {
      "WECOM_CORP_ID": "默认账户企业ID",
      "WECOM_CORP_SECRET": "默认账户Secret",
      "WECOM_AGENT_ID": "默认账户AgentId",
      "WECOM_CALLBACK_TOKEN": "默认账户Token",
      "WECOM_CALLBACK_AES_KEY": "默认账户AESKey",

      "WECOM_SALES_CORP_ID": "销售账户企业ID",
      "WECOM_SALES_CORP_SECRET": "销售账户Secret",
      "WECOM_SALES_AGENT_ID": "销售账户AgentId",
      "WECOM_SALES_CALLBACK_TOKEN": "销售账户Token",
      "WECOM_SALES_CALLBACK_AES_KEY": "销售账户AESKey"
    }
  }
}
```

### 第五步：配置公网访问

企业微信需要能够访问你的回调 URL。推荐使用 Cloudflare Tunnel：

```bash
# 安装 cloudflared
brew install cloudflared

# 创建隧道
cloudflared tunnel create openclaw

# 配置隧道路由
cloudflared tunnel route dns openclaw 你的域名

# 启动隧道
cloudflared tunnel run openclaw
```

### 第六步：启动并验证

1. 重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

2. 检查插件是否加载：

```bash
openclaw plugins list
```

3. 运行自检（推荐）：

```bash
npm run wecom:selfcheck -- --account default
```

多账户一次性体检：

```bash
npm run wecom:selfcheck -- --all-accounts
```

升级后快速回归：

```bash
npm run wecom:smoke
```

4. 回到企业微信管理后台，点击保存回调配置
5. 如果验证通过，配置完成！

## 渠道并存建议（Telegram/Feishu）

建议固定以下三点，避免升级后出现“偶发无回复”：

1. `plugins.allow` 使用显式白名单（至少包含 `openclaw-wechat`）
2. WeCom 使用独立 `webhookPath`，不要与其他 HTTP 回调渠道复用
3. 保证同一台机器只运行一个 OpenClaw gateway 进程

详细排查见：[`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md)

## 使用

配置完成后，企业微信用户可以直接向应用发送消息：

1. 在企业微信中找到你创建的应用
2. 发送文字、图片或语音消息
3. AI 会自动回复

### 命令系统

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/status` | 查看系统状态（含账户信息） |
| `/clear` | 重置会话（等价于 `/reset`） |

### 支持的消息类型

| 类型 | 接收 | 发送 | 说明 |
|------|------|------|------|
| 文本 | ✅ | ✅ | 完全支持，自动分段 |
| 图片 | ✅ | ✅ | 支持 Vision 识别 |
| 语音 | ✅ | ❌ | 优先用企业微信 Recognition；否则插件走 STT 回退 |
| 视频 | ✅ | ❌ | 接收后保存临时文件供 AI 处理 |
| 文件 | ✅ | ❌ | 接收后保存临时文件供 AI 处理 |
| 链接 | ✅ | ❌ | 支持标题/描述/URL 提取 |

## 环境变量说明

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `WECOM_CORP_ID` | 是 | 企业微信企业ID |
| `WECOM_CORP_SECRET` | 是 | 自建应用的 Secret |
| `WECOM_AGENT_ID` | 是 | 自建应用的 AgentId |
| `WECOM_CALLBACK_TOKEN` | 是 | 回调配置的 Token |
| `WECOM_CALLBACK_AES_KEY` | 是 | 回调配置的 EncodingAESKey |
| `WECOM_WEBHOOK_PATH` | 否 | Webhook 路径，默认 `/wecom/callback` |
| `WECOM_VOICE_TRANSCRIBE_ENABLED` | 否 | 是否启用语音转写回退（默认 true） |
| `WECOM_VOICE_TRANSCRIBE_PROVIDER` | 否 | 本地提供方：`local-whisper-cli` / `local-whisper` |
| `WECOM_VOICE_TRANSCRIBE_COMMAND` | 否 | 本地命令路径（默认按 provider 自动探测） |
| `WECOM_VOICE_TRANSCRIBE_MODEL_PATH` | 否 | `whisper-cli` 模型路径（推荐显式配置） |
| `WECOM_VOICE_TRANSCRIBE_MODEL` | 否 | `whisper` 模型名（默认 `base`） |
| `WECOM_VOICE_TRANSCRIBE_TIMEOUT_MS` | 否 | 转写超时毫秒数（默认 120000） |
| `WECOM_VOICE_TRANSCRIBE_MAX_BYTES` | 否 | 最大允许转写音频大小（默认 10MB） |
| `WECOM_VOICE_TRANSCRIBE_FFMPEG_ENABLED` | 否 | 不兼容音频格式时是否允许 ffmpeg 转码 |
| `WECOM_VOICE_TRANSCRIBE_TRANSCODE_TO_WAV` | 否 | 是否优先转码为 wav 再识别（默认 true） |

## 故障排查

### 回调验证失败

1. 检查 URL 是否可公网访问：
```bash
curl https://你的域名/wecom/callback
# 应返回 "wecom webhook ok"
```

2. 检查环境变量是否正确配置

3. 查看 OpenClaw 日志：
```bash
openclaw logs -f | grep wecom
```

4. 运行插件自检：
```bash
npm run wecom:selfcheck -- --account default
```

5. 批量检查所有账户并输出 JSON：
```bash
npm run wecom:selfcheck -- --all-accounts --json
```

6. 检查并存配置项（重点看 `plugins.allow` / `config.webhookPath.conflict`）

### 消息没有回复

1. 检查日志中是否有 `wecom inbound` 记录
2. 确认 AI 模型配置正确
3. 检查是否有错误日志

### access_token 获取失败

1. 确认 `WECOM_CORP_ID` 和 `WECOM_CORP_SECRET` 正确
2. 检查应用的可见范围是否包含测试用户
3. 确认服务器能访问 `qyapi.weixin.qq.com`

## 技术实现

- **消息加解密**：使用 AES-256-CBC 算法，遵循企业微信加密规范
- **签名验证**：SHA1 签名验证，防止消息伪造
- **异步处理**：消息接收后立即返回 200，异步调用 AI 处理
- **Token 缓存**：access_token 按账户隔离缓存，过期前 1 分钟刷新
- **并发安全**：Promise 锁防止重复刷新 token
- **API 限流**：RateLimiter 控制并发和频率

## 版本历史

查看 [CHANGELOG.md](./CHANGELOG.md) 了解完整版本历史。

## 相关链接

- [OpenClaw 官网](https://openclaw.ai)
- [企业微信开发文档](https://developer.work.weixin.qq.com/document/)
- [企业微信消息加解密说明](https://developer.work.weixin.qq.com/document/path/90968)

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！

## 致谢

本插件由 [OpenClaw](https://openclaw.ai) 社区开发维护。
