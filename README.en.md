# OpenClaw-Wechat (WeCom Plugin)

[中文 README](./README.md) | [English README](./README.en.md)

OpenClaw-Wechat is an OpenClaw channel plugin for Enterprise WeChat (WeCom), with two integration modes:

- `Agent mode`: WeCom custom app callback (XML)
- `Bot mode`: WeCom intelligent bot API callback (JSON + native stream)

## Table of Contents

- [Highlights](#highlights)
- [Mode Comparison](#mode-comparison)
- [5-Minute Quick Start](#5-minute-quick-start)
- [Requirements](#requirements)
- [Install and Load](#install-and-load)
- [Configuration Reference](#configuration-reference)
- [Capability Matrix](#capability-matrix)
- [Commands and Session Policy](#commands-and-session-policy)
- [Environment Variables](#environment-variables)
- [Coexistence with Other Channels](#coexistence-with-other-channels)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [FAQ](#faq)

## Highlights

| Feature | Status | Notes |
|---|---|---|
| WeCom inbound message handling | ✅ | text/image/voice/link/file/video (Agent + Bot) |
| AI auto-reply via OpenClaw runtime | ✅ | routed by session key |
| Native WeCom Bot stream protocol | ✅ | `msgtype=stream` refresh flow |
| Multi-account support | ✅ | `channels.wecom.accounts.<id>` |
| Sender allowlist and admin bypass | ✅ | `allowFrom` + `adminUsers` |
| Command allowlist | ✅ | `/help`, `/status`, `/clear`, etc. |
| Group trigger policy | ✅ | mention-required or direct-trigger |
| Debounce and late-reply fallback | ✅ | better stability under queue/timeout |
| Outbound proxy for WeCom APIs | ✅ | `outboundProxy` / `WECOM_PROXY` |

## Mode Comparison

| Dimension | Agent Mode (Custom App) | Bot Mode (Intelligent Bot API) |
|---|---|---|
| Callback payload | XML | JSON |
| WeCom setup entry | Custom App | Intelligent Bot (**API mode**) |
| Default callback path | `/wecom/callback` | `/wecom/bot/callback` |
| Reply mechanism | WeCom send APIs | stream response + refresh polling |
| Streaming UX | simulated via multiple messages | native stream protocol |
| Outbound media | full support | image/file supported (`response_url` mixed first, webhook fallback) |

## 5-Minute Quick Start

### 1) Install plugin

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

### 2) Load plugin in OpenClaw

Add to `~/.openclaw/openclaw.json`:

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

### 3) Configure one mode

| Mode | Required keys |
|---|---|
| Agent | `corpId`, `corpSecret`, `agentId`, `callbackToken`, `callbackAesKey` |
| Bot | `bot.enabled=true`, `bot.token`, `bot.encodingAesKey` |

### 4) Restart and verify

```bash
openclaw gateway restart
openclaw gateway status
npm run wecom:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck
```

## Requirements

| Item | Description |
|---|---|
| OpenClaw | installed and gateway is runnable |
| WeCom admin permission | to create app/bot and configure callback |
| Public callback endpoint | accessible from WeCom |
| Node.js | compatible with OpenClaw runtime |
| Local STT (optional) | `whisper-cli` or `whisper` |
| ffmpeg (recommended) | for voice transcoding fallback |

## Install and Load

### Local path loading (recommended)

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

Configure plugin load path in `~/.openclaw/openclaw.json`.

### npm installation

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

## Configuration Reference

### Root channel config (`channels.wecom`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | enable WeCom channel |
| `corpId` | string | - | Agent mode |
| `corpSecret` | string | - | sensitive |
| `agentId` | number/string | - | Agent mode |
| `callbackToken` | string | - | sensitive |
| `callbackAesKey` | string | - | sensitive |
| `webhookPath` | string | `/wecom/callback` | Agent callback path |
| `outboundProxy` | string | - | WeCom API proxy |
| `accounts` | object | - | multi-account map |

### Bot config (`channels.wecom.bot`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | enable Bot mode |
| `token` | string | - | sensitive |
| `encodingAesKey` | string | - | sensitive, 43 chars |
| `webhookPath` | string | `/wecom/bot/callback` | Bot callback path |
| `placeholderText` | string | processing text | stream initial placeholder |
| `streamExpireMs` | integer | `600000` | 30s ~ 1h |
| `replyTimeoutMs` | integer | `90000` | Bot reply timeout (15s ~ 10m) |
| `lateReplyWatchMs` | integer | `180000` | async late-reply watch window |
| `lateReplyPollMs` | integer | `2000` | async late-reply poll interval |

### Policy config

| Area | Keys |
|---|---|
| Sender ACL | `allowFrom`, `allowFromRejectMessage` |
| Command ACL | `commands.enabled`, `commands.allowlist`, `commands.rejectMessage` |
| Admin bypass | `adminUsers` |
| Group trigger | `groupChat.enabled`, `groupChat.triggerMode`, `groupChat.mentionPatterns`, `groupChat.triggerKeywords` |
| Dynamic route | `dynamicAgent.*` (with `workspaceTemplate` bootstrap seeding) |
| Debounce | `debounce.enabled`, `debounce.windowMs`, `debounce.maxBatch` |
| Agent streaming | `streaming.enabled`, `streaming.minChars`, `streaming.minIntervalMs` |

## Capability Matrix

### Agent mode

| Message type | Inbound | Outbound |
|---|---|---|
| Text | ✅ | ✅ |
| Image | ✅ | ✅ |
| Voice | ✅ | ❌ (transcript as text) |
| Video | ✅ | ✅ |
| File | ✅ | ✅ |
| Link | ✅ | ❌ |

### Bot mode

| Message type | Inbound | Outbound | Notes |
|---|---|---|---|
| Text | ✅ | ✅ | native stream |
| Image | ✅ | ✅ | response_url mixed first; webhook fallback supports image/file |
| Voice | ✅ | ✅ | transcript-driven text reply |
| File | ✅ | ✅ | Bot `msgtype=file` inbound + file outbound fallback |
| Mixed | ✅ | ✅ | aggregated context |
| Link/Location | ✅ | ✅ | normalized to text context |

Quoted reply context in Bot mode is also supported (`quote` is prepended into current turn context).

## Commands and Session Policy

| Command | Description |
|---|---|
| `/help` | show help |
| `/status` | show runtime status |
| `/clear` | clear session (mapped to `/reset`) |
| `/reset` | reset conversation |
| `/new` | new session (runtime-supported) |
| `/compact` | compact session (runtime-supported) |

Session key policy: default is one-user-one-session (`wecom:<userid>`).

Outbound target formats:
- `user`: `wecom:alice` / `user:alice`
- `group`: `group:wrxxxx` / `chat:wcxxxx`
- `party`: `party:2` / `dept:2`
- `tag`: `tag:ops`

## Environment Variables

### Core

| Variable | Purpose |
|---|---|
| `WECOM_CORP_ID`, `WECOM_CORP_SECRET`, `WECOM_AGENT_ID` | Agent app credentials |
| `WECOM_CALLBACK_TOKEN`, `WECOM_CALLBACK_AES_KEY` | Agent callback security |
| `WECOM_WEBHOOK_PATH` | Agent callback path |

### Bot

| Variable | Purpose |
|---|---|
| `WECOM_BOT_ENABLED` | enable Bot mode |
| `WECOM_BOT_TOKEN` | Bot callback token |
| `WECOM_BOT_ENCODING_AES_KEY` | Bot AES key |
| `WECOM_BOT_WEBHOOK_PATH` | Bot callback path |
| `WECOM_BOT_PLACEHOLDER_TEXT` | stream placeholder text |
| `WECOM_BOT_STREAM_EXPIRE_MS` | stream cache TTL |
| `WECOM_BOT_REPLY_TIMEOUT_MS` | Bot reply timeout |
| `WECOM_BOT_LATE_REPLY_WATCH_MS` | Bot late-reply watch window |
| `WECOM_BOT_LATE_REPLY_POLL_MS` | Bot late-reply poll interval |

### Stability and policy

| Variable group | Purpose |
|---|---|
| `WECOM_ALLOW_FROM*` | sender authorization |
| `WECOM_COMMANDS_*` | command ACL |
| `WECOM_GROUP_CHAT_*` | group trigger policy |
| `WECOM_DEBOUNCE_*` | text debounce |
| `WECOM_STREAMING_*` | Agent incremental output |
| `WECOM_LATE_REPLY_*` | async late reply fallback |
| `WECOM_PROXY`, `WECOM_<ACCOUNT>_PROXY` | outbound proxy |

### Local voice transcription fallback

| Variable group | Purpose |
|---|---|
| `WECOM_VOICE_TRANSCRIBE_*` | local whisper/whisper-cli settings |

## Coexistence with Other Channels

Recommended hardening for Telegram/Feishu/WeCom together:

1. Use explicit `plugins.allow` whitelist.
2. Keep webhook paths isolated per channel/account.
3. Prefer one OpenClaw gateway process per machine.

See [`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md).

## Troubleshooting

| Symptom | Check first | Typical root cause |
|---|---|---|
| Callback verification failed | callback URL reachability | URL/Token/AES mismatch |
| Inbound received but no reply | gateway logs + dispatch status | timeout, queueing, policy block |
| Bot image parse failed | `wecom(bot): failed to fetch image url` | expired URL/non-image stream |
| Voice transcription failed | local command/model path | whisper/ffmpeg environment issue |
| gettoken failed | WeCom API result | wrong credentials or network/proxy |

Useful commands:

```bash
openclaw gateway status
openclaw status --deep
openclaw logs --follow
npm run wecom:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck
```

## Development

| Command | Purpose |
|---|---|
| `npm test` | syntax + tests |
| `npm run wecom:selfcheck -- --all-accounts` | config/network self-check |
| `npm run wecom:bot:selfcheck` | Bot E2E self-check (signature/encryption/stream-refresh) |
| `npm run wecom:remote:e2e -- --bot-url <public-callback>` | remote Bot E2E verification (public domain/tunnel) |
| `npm run wecom:smoke` | smoke test after upgrades (Agent path) |
| `npm run wecom:smoke -- --with-bot-e2e` | smoke test after upgrades (with Bot E2E) |
| `openclaw gateway restart` | restart runtime |

## FAQ

### Why does Bot callback fail with parsing errors?
Most likely the bot was created in non-API mode. Re-create as **API mode**.

### Why can image recognition fail intermittently?
WeCom image URLs can return non-standard content type or encrypted media stream. The plugin now includes content sniffing and decrypt fallback.

### Can Telegram and WeCom affect each other?
They are logically independent, but can conflict via shared webhook paths, multi-process gateway races, or loose plugin loading policy.
