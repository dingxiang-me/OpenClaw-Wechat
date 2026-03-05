# OpenClaw-Wechat (WeCom Plugin)

[中文 README](./README.md) | [English README](./README.en.md)

OpenClaw-Wechat is an OpenClaw channel plugin for Enterprise WeChat (WeCom), with two integration modes:

- `Agent mode`: WeCom custom app callback (XML)
- `Bot mode`: WeCom intelligent bot API callback (JSON + native stream)

## Table of Contents

- [Major Update (v1.8.0)](#major-update-v180)
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

## Major Update (v1.8.0)

This release is a major operations-focused upgrade: **WeCom now supports visual configuration in Control UI**, so you no longer need to rely on manual JSON edits only.

### Visual config in Control UI

| Item | Status | Notes |
|---|---|---|
| WeCom config form | ✅ | `channels.wecom` can be edited/saved directly from UI |
| Localized labels | ✅ | Common fields are now clearly labeled in Chinese for ops teams |
| Sensitive-field hints | ✅ | secret/token/aesKey fields are marked as sensitive |
| Runtime status clarity | ✅ | `Connected` is no longer stuck at `n/a`; default account display name is localized |
| Inbound activity tracking | ✅ | `Last inbound` is updated after webhook callbacks (`n/a` before first inbound after restart is expected) |

### Practical impact

- Configure WeCom directly in `Channels -> WeCom` without hand-editing large config files.
- Better readability for day-to-day ops and handover.
- More accurate runtime status display reduces false alarm on “plugin not working”.

## Highlights

| Feature | Status | Notes |
|---|---|---|
| WeCom inbound message handling | ✅ | text/image/voice/link/file/video (Agent + Bot) |
| AI auto-reply via OpenClaw runtime | ✅ | routed by session key |
| Native WeCom Bot stream protocol | ✅ | `msgtype=stream` refresh flow |
| Bot card replies | ✅ | `markdown/template_card` with automatic text fallback |
| Multi-account support | ✅ | `channels.wecom.accounts.<id>` |
| Sender allowlist and admin bypass | ✅ | `allowFrom` + `adminUsers` |
| Direct-message policy | ✅ | `dm.mode=open/allowlist/deny` + account overrides |
| Event welcome reply (`enter_agent`) | ✅ | configurable via `events.enterAgentWelcome*` |
| Command allowlist | ✅ | `/help`, `/status`, `/clear`, `/new`, etc. |
| Group trigger policy | ✅ | mention-required or direct-trigger |
| Debounce and late-reply fallback | ✅ | better stability under queue/timeout |
| Observability metrics | ✅ | inbound/delivery/error counters + recent failures |
| Outbound proxy for WeCom APIs | ✅ | `outboundProxy` / `WECOM_PROXY` |

## Mode Comparison

| Dimension | Agent Mode (Custom App) | Bot Mode (Intelligent Bot API) |
|---|---|---|
| Callback payload | XML | JSON |
| WeCom setup entry | Custom App | Intelligent Bot (**API mode**) |
| Default callback path | `/wecom/callback` | `/wecom/bot/callback` |
| Reply mechanism | WeCom send APIs | stream response + refresh polling |
| Streaming UX | simulated via multiple messages | native stream protocol |
| Outbound media | full support (image/voice/video/file) | image/file supported (`active_stream msg_item(image)` first, then `response_url` mixed / webhook fallback) |

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
npm run wecom:agent:selfcheck -- --account default
npm run wecom:bot:selfcheck -- --account default
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
| `webhookPath` | string | `/wecom/callback` | Agent callback path (auto `/wecom/<accountId>/callback` when non-default account leaves it empty) |
| `agent` | object | - | legacy layout: `agent.corpId/corpSecret/agentId` (equivalent to top-level Agent fields) |
| `outboundProxy` | string | - | WeCom API proxy |
| `webhooks` | object | - | named webhook target map (`{ "ops": "https://...key=xxx" }`) |
| `accounts` | object | - | multi-account map (supports `accounts.<id>.bot` overrides) |

Compatibility note: legacy keys/layouts are supported: `name`, `token` / `encodingAesKey`, `agent.*`, `dynamicAgents.*`, `dm.createAgentOnFirstMessage`, `dm.allowFrom`, `workspaceTemplate`, `commandAllowlist/commandBlockMessage`, `commands.blockMessage`, and inline account blocks (`channels.wecom.<accountId>`). New configs should prefer `accounts.<id>`, `callbackToken/callbackAesKey`, `commands.*`, and `dynamicAgent.*`.

Note: `accounts.<id>` now supports Bot-only accounts (`bot.*` only) and no longer requires `corpId/corpSecret/agentId`.
Compat note: when default new paths are used, legacy aliases are auto-registered for smoother migration. Agent default paths also add `/webhooks/app` aliases (`/webhooks/app/<id>` for multi-account), and Bot default paths add `/webhooks/wecom` aliases (`/webhooks/wecom/<id>`). Conflicting aliases are skipped with warnings.

### Bot config (`channels.wecom.bot`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | enable Bot mode |
| `token` | string | - | sensitive |
| `encodingAesKey` | string | - | sensitive, 43 chars |
| `webhookPath` | string | `/wecom/bot/callback` | Bot callback path (auto `/wecom/<accountId>/bot/callback` when non-default account leaves it empty) |
| `placeholderText` | string | processing text | stream initial placeholder |
| `streamExpireMs` | integer | `600000` | 30s ~ 1h |
| `replyTimeoutMs` | integer | `90000` | Bot reply timeout (15s ~ 10m) |
| `lateReplyWatchMs` | integer | `180000` | async late-reply watch window |
| `lateReplyPollMs` | integer | `2000` | async late-reply poll interval |
| `card` | object | see below | Bot card reply policy (`response_url` / `webhook_bot`) |

#### Bot card config (`channels.wecom.bot.card`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | enable card replies |
| `mode` | string | `markdown` | `markdown` (compat-first) or `template_card` |
| `title` | string | `OpenClaw-Wechat` | card title |
| `subtitle` | string | - | card subtitle |
| `footer` | string | - | card footer text |
| `maxContentLength` | integer | `1400` | max card body length (auto-truncated) |
| `responseUrlEnabled` | boolean | `true` | enable card sending at `response_url` layer |
| `webhookBotEnabled` | boolean | `true` | enable card sending at `webhook_bot` layer |

### Account-level Bot overrides (`channels.wecom.accounts.<id>.bot`)

When multi-account is enabled, each account can override Bot callback credentials/path/timeout/proxy. If omitted, it falls back to `channels.wecom.bot`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | enable Bot mode for this account |
| `token` / `callbackToken` | string | - | callback token (legacy alias supported) |
| `encodingAesKey` / `callbackAesKey` | string | - | callback AES key (legacy alias supported) |
| `webhookPath` | string | `/wecom/bot/callback` | Bot callback path |
| `placeholderText` | string | processing text | stream placeholder |
| `streamExpireMs` | integer | `600000` | stream TTL |
| `replyTimeoutMs` | integer | `90000` | model reply timeout |
| `lateReplyWatchMs` | integer | `180000` | late-reply watch window |
| `lateReplyPollMs` | integer | `2000` | late-reply poll interval |
| `card` | object | - | account-level card policy (overrides global `bot.card`) |
| `outboundProxy` / `proxyUrl` / `proxy` | string | - | account-level Bot proxy |

### Policy config

| Area | Keys |
|---|---|
| Sender ACL | `allowFrom`, `allowFromRejectMessage` |
| Command ACL | `commands.enabled`, `commands.allowlist`, `commands.rejectMessage` |
| Admin bypass | `adminUsers` |
| Direct-message policy | `dm.mode`, `dm.allowFrom`, `dm.rejectMessage` |
| Event policy | `events.enabled`, `events.enterAgentWelcomeEnabled`, `events.enterAgentWelcomeText` |
| Group trigger | `groupChat.enabled`, `groupChat.triggerMode`, `groupChat.mentionPatterns`, `groupChat.triggerKeywords` |
| Dynamic route | `dynamicAgent.*` (compatible with `dynamicAgents.*`, `dm.createAgentOnFirstMessage`) |
| Debounce | `debounce.enabled`, `debounce.windowMs`, `debounce.maxBatch` |
| Agent streaming | `streaming.enabled`, `streaming.minChars`, `streaming.minIntervalMs` |
| Observability | `observability.enabled`, `observability.logPayloadMeta` |

## Capability Matrix

### Agent mode

| Message type | Inbound | Outbound |
|---|---|---|
| Text | ✅ | ✅ |
| Image | ✅ | ✅ |
| Voice | ✅ | ✅ (AMR/SILK) |
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
| `/new` | new session (mapped to `/reset`) |
| `/reset` | reset conversation |
| `/compact` | compact session (runtime-supported) |

Session key policy: default is one-user-one-session (`wecom:<userid>`).

Outbound target formats:
- `user`: `wecom:alice` / `user:alice`
- `group(chat)`: `group:wrxxxx` / `chat:wcxxxx` (uses `appchat/send`)
- `party`: `party:2` / `dept:2`
- `tag`: `tag:ops`
- `webhook`: `webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx` or `webhook:key:xxx`
- `webhook(named)`: `webhook:ops` (resolved from `channels.wecom.webhooks.ops` or `accounts.<id>.webhooks.ops`)

## Environment Variables

### Core

| Variable | Purpose |
|---|---|
| `WECOM_CORP_ID`, `WECOM_CORP_SECRET`, `WECOM_AGENT_ID` | Agent app credentials |
| `WECOM_CALLBACK_TOKEN`, `WECOM_CALLBACK_AES_KEY` | Agent callback security |
| `WECOM_WEBHOOK_PATH` | Agent callback path |
| `WECOM_WEBHOOK_TARGETS` | named webhook targets (`name=url`, separated by `,`/`;`) |

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
| `WECOM_BOT_CARD_ENABLED` | enable Bot card replies |
| `WECOM_BOT_CARD_MODE` | card mode: `markdown` / `template_card` |
| `WECOM_BOT_CARD_TITLE` | card title |
| `WECOM_BOT_CARD_SUBTITLE` | card subtitle |
| `WECOM_BOT_CARD_FOOTER` | card footer text |
| `WECOM_BOT_CARD_MAX_CONTENT_LENGTH` | max card body length |
| `WECOM_BOT_CARD_RESPONSE_URL_ENABLED` | card switch for response_url layer |
| `WECOM_BOT_CARD_WEBHOOK_BOT_ENABLED` | card switch for webhook_bot layer |
| `WECOM_<ACCOUNT>_BOT_*` | account-level Bot override (e.g. `WECOM_SALES_BOT_TOKEN`) |
| `WECOM_<ACCOUNT>_BOT_PROXY` | account-level Bot proxy for media/download/reply |

### Stability and policy

| Variable group | Purpose |
|---|---|
| `WECOM_ALLOW_FROM*` | sender authorization |
| `WECOM_COMMANDS_*` | command ACL |
| `WECOM_DM_*`, `WECOM_<ACCOUNT>_DM_*` | DM policy + allowlist |
| `WECOM_EVENTS_*`, `WECOM_<ACCOUNT>_EVENTS_*` | event handling + enter_agent welcome text |
| `WECOM_GROUP_CHAT_*` | group trigger policy |
| `WECOM_DEBOUNCE_*` | text debounce |
| `WECOM_STREAMING_*` | Agent incremental output |
| `WECOM_LATE_REPLY_*` | async late reply fallback |
| `WECOM_OBSERVABILITY_ENABLED`, `WECOM_OBSERVABILITY_PAYLOAD_META` | observability counters and payload-meta logging |
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
| `curl /wecom/callback` returns WebUI page | reverse-proxy path routing | `/wecom/*` path is forwarded to frontend/static site instead of OpenClaw gateway |
| Inbound received but no reply | gateway logs + dispatch status | timeout, queueing, policy block |
| Bot image parse failed | `wecom(bot): failed to fetch image url` | expired URL/non-image stream |
| Voice transcription failed | local command/model path | whisper/ffmpeg environment issue |
| Startup logs show `wecom: account diagnosis ...` | diagnosis code + account list | multi-account token/agent/path conflict risk |
| gettoken failed | WeCom API result | wrong credentials or network/proxy |

Useful commands:

```bash
openclaw gateway status
openclaw status --deep
openclaw logs --follow
npm run wecom:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
```

## Development

| Command | Purpose |
|---|---|
| `npm test` | syntax + tests |
| `WECOM_E2E_ENABLE=1 npm run test:e2e:remote` | run remote E2E tests (skipped by default; supports both `WECOM_E2E_*` and legacy `E2E_WECOM_*` env sets) |
| `WECOM_E2E_MATRIX_ENABLE=1 npm run test:e2e:matrix` | run remote matrix E2E (signature/negative requests/stream refresh/dedupe) |
| `npm run test:e2e:prepare-browser` | check remote browser sandbox readiness (optional Chromium auto-install) |
| `npm run test:e2e:collect-pdf` | collect browser-generated PDFs from remote sandbox to local artifacts |
| `npm run wecom:selfcheck -- --all-accounts` | config/network self-check |
| `npm run wecom:agent:selfcheck -- --account <id>` | Agent E2E self-check (URL verify + encrypted POST) |
| `npm run wecom:bot:selfcheck -- --account <id>` | Bot E2E self-check (URL verify/signature/encryption/stream-refresh, supports multi-account) |
| `npm run wecom:remote:e2e -- --mode all --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | remote matrix verification (Agent + Bot) |
| `npm run wecom:remote:e2e -- --mode all --agent-url <public-agent-callback> --bot-url <public-bot-callback> --prepare-browser --collect-pdf` | remote matrix with browser sandbox prepare + PDF artifact collection |
| `WECOM_E2E_BOT_URL=<...> WECOM_E2E_AGENT_URL=<...> npm run wecom:remote:e2e -- --mode all` | env-driven remote E2E (also compatible with legacy `E2E_WECOM_*`) |
| `npm run wecom:e2e:scenario -- --scenario full-smoke --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | scenario-based E2E (preset smoke/queue workflows) |
| `npm run wecom:e2e:scenario -- --scenario compat-smoke --agent-url <new-agent-url> --agent-legacy-url <legacy-agent-url> --bot-url <new-bot-url> --bot-legacy-url <legacy-bot-url>` | compatibility matrix run across new + legacy webhook endpoints |
| `npm run wecom:e2e:scenario -- --scenario matrix-smoke --bot-url <public-bot-callback>` | bot protocol matrix checks (signature/negative requests/stream-refresh/dedupe; requires `WECOM_BOT_TOKEN/WECOM_BOT_ENCODING_AES_KEY`) |
| `npm run wecom:e2e:compat -- --agent-url <new-agent-url> --agent-legacy-url <legacy-agent-url> --bot-url <new-bot-url> --bot-legacy-url <legacy-bot-url>` | compatibility matrix shortcut command (same as `--scenario compat-smoke`) |
| `npm run wecom:e2e:full -- --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | one-shot full-smoke (pre-enabled `--prepare-browser --collect-pdf`) |
| `GitHub Actions -> CI -> Run workflow` | trigger remote E2E in CI with `run_remote_e2e=true`; optionally pick `e2e_scenario` (including `compat-smoke`) and browser options |
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

### Why is the Bot contact not visible in the WeChat plugin entry?
This is usually a WeCom product behavior difference, not a plugin bug.  
In many tenants, the WeChat plugin entry maps to **self-built app (Agent callback)** visibility, while Bot mode (intelligent bot API) is not exposed as a direct contact.

Recommended setup:
1. Need stable direct entry: prefer Agent mode.
2. Need group notifications/conversation: prefer Webhook Bot / Bot mode.
3. Need both: run Agent (entry) + Bot (group capability) together.
4. Run `npm run wecom:bot:selfcheck -- --account <id>` (or `--all-accounts`) and check `bot.entry.visibility` to confirm this is expected product behavior rather than a plugin fault.

### Why does `curl https://<domain>/wecom/callback` return WebUI instead of webhook health text?
That is a routing issue. `GET /wecom/callback` (without `echostr`) should return plain text `wecom webhook ok`.
If you get WebUI HTML, your reverse proxy is sending `/wecom/*` to frontend/static service.

Quick checks:
1. Local: `curl http://127.0.0.1:8885/wecom/callback`
2. Public: `curl -i https://<domain>/wecom/callback`
3. Proxy rules: route `/wecom/*` to OpenClaw gateway port, not WebUI.

### How to enable self-built app group chat without requiring `@`?
First, separate the two WeCom integration types:
1. **Webhook Bot**: can be added into normal WeCom groups directly (best for group chat).
2. **Self-built App (Agent callback)**: plugin can handle group messages when WeCom callback includes `ChatId`, but whether normal group messages are delivered depends on WeCom tenant/product behavior.

If your goal is stable normal-group conversations, prefer **Webhook Bot mode**.
If your tenant does deliver group callbacks (`chatId=...` in logs), set:

Set:

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

And verify WeCom-side prerequisites:
1. App callback is enabled and URL verification succeeded.
2. App visibility includes group members.
3. Logs contain inbound `chatId=...`; otherwise WeCom is not pushing group messages to this callback.

If your WeCom admin console only allows adding a webhook bot (not a self-built app) into regular groups, that is a WeCom-side product limitation rather than a plugin setting issue.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=dingxiang-me/OpenClaw-Wechat&type=Date)](https://star-history.com/#dingxiang-me/OpenClaw-Wechat&Date)
