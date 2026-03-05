---
summary: "OpenClaw-Wechat WeCom channel plugin"
---

# WeCom (企业微信) (plugin)

This channel integrates OpenClaw with WeCom (企业微信) internal apps.

## Major Update: Visual Config in Control UI

- You can now edit WeCom channel config directly in `Channels -> WeCom` (Control UI).
- WeCom UI hints are localized and sensitive fields are marked.
- Runtime status is clearer: `Connected` and default account display are no longer ambiguous.
- `Last inbound` updates automatically after callbacks; `n/a` before first inbound after a restart is expected.

## Status

- Webhook verification: supported (requires Token + EncodingAESKey)
- Inbound messages: text/image/voice/video/file/link (Bot quote context included)
- Outbound: Agent mode supports text/image/voice/video/file; Bot mode supports response_url mixed and webhook fallback media
- Local outbound media path: supported (`/abs/path`, `file://...`, `sandbox:/...`)
- Outbound target: supports `user` / `group(chatid)` / `party(dept)` / `tag` / `webhook` (including named webhook targets)
- Multi-account: supported (`channels.wecom.accounts`)
- Voice recognition: WeCom `Recognition` first; local whisper fallback supported (`channels.wecom.voiceTranscription`)
- Delivery fallback chain: optional (`active_stream -> response_url -> webhook_bot -> agent_push`)
- Bot card replies: supported (`channels.wecom.bot.card`, `markdown/template_card`)
- Direct-message policy: supported (`channels.wecom.dm.mode=open|allowlist|deny`, account-level override via `accounts.<id>.dm`)
- Event handling: supported (`channels.wecom.events.*`, supports `enter_agent` welcome reply)
- Group trigger mode: Agent callback supports `direct` / `mention` / `keyword`; Bot mode is effectively `mention` (WeCom platform callback constraint)
- Dynamic agent route mode: `deterministic` / `mapping` / `hybrid` (`channels.wecom.dynamicAgent.mode`)
- Dynamic workspace seeding: supported via `channels.wecom.dynamicAgent.workspaceTemplate`
- Session queue / stream manager: optional (`channels.wecom.stream.manager`)
- Bot timeout tuning: supported (`channels.wecom.bot.replyTimeoutMs`, `lateReplyWatchMs`, `lateReplyPollMs`)
- Observability counters: supported (`channels.wecom.observability.*`, visible in `/status`)

## Callback URL

Recommended:

- `https://<your-domain>/wecom/callback`

Named webhook targets (optional):

- Configure `channels.wecom.webhooks` (or `accounts.<id>.webhooks`) and send to `webhook:<name>`.

## Group Chat Checklist

WeCom has two different integration shapes:

1. **Webhook Bot**: can be added directly to regular group chats, but callbacks are typically triggered only when the bot is mentioned (`@机器人`).
2. **Self-built App callback**: plugin supports group processing when callback payload contains `ChatId`.

To enable direct group trigger (`triggerMode=direct`) for self-built app callback, ensure:

1. Plugin config uses `channels.wecom.groupChat.enabled=true` and `triggerMode=direct`.
2. WeCom app callback is enabled and URL verification succeeded.
3. App visibility scope includes members in that group context.
4. Runtime logs show `chatId=...` for inbound messages.

If logs never show `chatId`, WeCom is not delivering group messages to this callback route.  
In that case, use **Webhook Bot mode** for regular group chat scenarios.

Note: In Bot mode, `groupChat.triggerMode=direct/keyword` is normalized to `mention` by the plugin to avoid misleading config.

## Selfcheck

Run:

```bash
npm run wecom:selfcheck -- --account default
```

Agent E2E (URL verification + encrypted POST):

```bash
npm run wecom:agent:selfcheck -- --account default
```

All accounts:

```bash
npm run wecom:selfcheck -- --all-accounts
```

Bot E2E (signed/encrypted callback + stream refresh):

```bash
npm run wecom:bot:selfcheck
```

Remote matrix E2E (against public callback URLs):

```bash
npm run wecom:remote:e2e -- --mode all --agent-url https://your-domain.example/wecom/callback --bot-url https://your-domain.example/wecom/bot/callback
```

Upgrade smoke check:

```bash
npm run wecom:smoke
```

Upgrade smoke check (with Bot E2E):

```bash
npm run wecom:smoke -- --with-bot-e2e
```

## Coexistence (Telegram/Feishu)

See troubleshooting guide:

- `docs/troubleshooting/coexistence.md`

Optional:

- `--config ~/.openclaw/openclaw.json`
- `--skip-network`
- `--skip-local-webhook`
- `--json`

## P0 Reliability Config (Optional)

All new switches are default-off for compatibility.

```json
{
  "channels": {
    "wecom": {
      "delivery": {
        "fallback": {
          "enabled": true,
          "order": ["active_stream", "response_url", "webhook_bot", "agent_push"]
        }
      },
      "webhookBot": {
        "enabled": false,
        "url": "",
        "key": "",
        "timeoutMs": 8000
      },
      "stream": {
        "manager": {
          "enabled": false,
          "timeoutMs": 45000,
          "maxConcurrentPerSession": 1
        }
      },
      "bot": {
        "card": {
          "enabled": false,
          "mode": "markdown",
          "title": "OpenClaw-Wechat",
          "responseUrlEnabled": true,
          "webhookBotEnabled": true
        }
      },
      "observability": {
        "enabled": true,
        "logPayloadMeta": true
      },
      "dm": {
        "mode": "allowlist",
        "allowFrom": ["alice", "wecom:bob"],
        "rejectMessage": "当前账号未授权，请联系管理员。"
      },
      "events": {
        "enabled": true,
        "enterAgentWelcomeEnabled": true,
        "enterAgentWelcomeText": "你好，我是 AI 助手，直接发消息即可开始对话。"
      }
    }
  }
}
```

## P2 Routing Config (Recommended, Agent callback)

```json
{
  "channels": {
    "wecom": {
      "groupChat": {
        "enabled": true,
        "triggerMode": "direct",
        "mentionPatterns": ["@", "@AI助手"],
        "triggerKeywords": ["机器人", "AI助手"]
      },
      "dynamicAgent": {
        "enabled": true,
        "mode": "deterministic",
        "idStrategy": "readable-hash",
        "deterministicPrefix": "wecom",
        "autoProvision": true,
        "allowUnknownAgentId": true,
        "forceAgentSessionKey": true
      }
    }
  }
}
```

## Security

Store secrets in environment variables or secret files. Do not commit them.
