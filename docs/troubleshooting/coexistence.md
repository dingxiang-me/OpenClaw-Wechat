# OpenClaw-Wechat 与其他渠道并存排查

本文用于排查 WeCom 与 Telegram/Feishu 同时启用时的常见问题。

## 1. 只保留一个 Gateway 进程

重复启动 Gateway 会造成“服务状态异常”或端口占用，表现为偶发无回复。

```bash
openclaw gateway stop || true
pkill -f '^openclaw-gateway$' 2>/dev/null || true
lsof -nP -iTCP:8885 -sTCP:LISTEN
openclaw gateway install
openclaw gateway start
openclaw gateway status
```

## 2. 固定插件白名单

`plugins.allow` 未设置时，扫描到的插件可能被自动加载，升级后更容易出现不确定行为。

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat", "telegram", "feishu"]
  }
}
```

## 3. 避免 webhookPath 与其他渠道冲突

建议固定 WeCom 路径为 `/wecom/callback`，并避免与其他 HTTP 回调渠道共用同一路径。

多账户示例：

```json
{
  "channels": {
    "wecom": {
      "accounts": {
        "default": { "webhookPath": "/wecom/callback" },
        "sales": { "webhookPath": "/wecom/sales/callback" }
      }
    }
  }
}
```

## 4. “no deliverable reply” 的含义

这通常表示上游本次没有直接产出最终可发送文本。插件会在这种情况下发送处理中提示，并在可用时回退发送累计内容，避免用户无感知。

## 5. 隧道是否影响 Telegram

不会。Telegram 主要由机器人主动出站拉取/发送消息，不依赖你给 WeCom 回调使用的同一条云端隧道入口。

## 6. 升级后回归检查

```bash
npm run wecom:smoke -- --all-accounts
openclaw status --all
openclaw logs -f | grep -E "wecom|feishu|telegram"
```

如果 smoke 失败，先执行：

```bash
npm run wecom:selfcheck -- --all-accounts --json
```

检查 `plugins.allow`、`config.webhookPath.conflict`、`local.webhook.health` 三项。
