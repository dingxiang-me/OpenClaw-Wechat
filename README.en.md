# OpenClaw-Wechat (WeCom Plugin)

[中文 README](./README.md) | [English README](./README.en.md)

OpenClaw-Wechat is an OpenClaw channel plugin for Enterprise WeChat (WeCom), with two integration modes:

- `Agent mode`: WeCom custom app callback (XML)
- `Bot mode`: WeCom intelligent bot API callback (JSON + native stream)
- `Webhook outbound targets`: push messages to group webhooks or named webhook endpoints

## Table of Contents

- [Reliable Delivery Update (v2.2.0)](#reliable-delivery-update-v220)
- [Highlights](#highlights)
- [Mode Comparison](#mode-comparison)
- [5-Minute Quick Start](#5-minute-quick-start)
- [Requirements](#requirements)
- [Install and Load](#install-and-load)
- [Config Paths and Ownership](#config-paths-and-ownership)
- [Configuration Reference](#configuration-reference)
- [Capability Matrix](#capability-matrix)
- [Commands and Session Policy](#commands-and-session-policy)
- [Environment Variables](#environment-variables)
- [Public Callbacks and Gateway Auth](#public-callbacks-and-gateway-auth)
- [Webhook and Heartbeat Ops](#webhook-and-heartbeat-ops)
- [Coexistence with Other Channels](#coexistence-with-other-channels)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [FAQ](#faq)

## Reliable Delivery Update (v2.2.0)

This release focuses on reply reliability rather than new surface area. The goal is to make WeCom delivery visible, retryable, and diagnosable.

### What changed

| Item | Result |
|---|---|
| Reliable-delivery status | `/status` now shows `24h window / proactive quota / Pending Reply` summary |
| Pending Reply | final replies that fail to deliver are queued for retry and next-inbound replay |
| Failure classification | delivery now distinguishes `window expired / quota exhausted / transport failure / invalid target` |
| Selfcheck summaries | `wecom:selfcheck`, `wecom:agent:selfcheck`, and `wecom:bot:selfcheck` now print `reliable-delivery` summaries |
| Group-policy diagnostics | `/status` and selfcheck now show group rule source, access mode, and whether allowlists are actually active |
| Bot/Agent convergence | bot fallback and agent final reply now share the same reliable-delivery tracking |
| Long-connection log noise | normal connect / opened / subscribed logs stay at `debug` |

### Practical impact

- You can now see whether the current session is still inside the 24-hour reply window.
- Group-chat policy no longer requires log forensics: `/status` and selfcheck explain which group rule is active and whether an allowlist is currently enforced.
- Failed final replies no longer disappear into timeout-only fallbacks; they move into Pending Reply retry flow.
- Selfcheck now tells you whether reliable-delivery tracking is enabled, not just whether tokens and webhook paths exist.
- Bot long-connection stays quiet by default while keeping warnings and errors visible.

## Highlights

| Feature | Status | Notes |
|---|---|---|
| WeCom inbound message handling | ✅ | text/image/voice/link/file/video (Agent + Bot) |
| AI auto-reply via OpenClaw runtime | ✅ | routed by session key |
| Native WeCom Bot stream protocol | ✅ | `msgtype=stream` refresh flow |
| Bot thinking display | ✅ | parses `<think>/<thinking>/<thought>` into native `thinking_content` |
| Bot card replies | ✅ | `markdown/template_card` with automatic text fallback |
| Multi-account support | ✅ | `channels.wecom.accounts.<id>` |
| Sender allowlist and admin bypass | ✅ | `allowFrom` + `adminUsers` |
| Direct-message policy | ✅ | `dm.mode=open/allowlist/pairing/deny` + account overrides |
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
| Thinking display | not applicable | native `thinking_content` from `<think>` tags |
| Outbound media | full support (image/voice/video/file) | image/file supported (`active_stream msg_item(image)` first, then `response_url` mixed / webhook fallback) |

## 5-Minute Quick Start

### 1) Install plugin

Fastest path:

```bash
npx -y @dingxiang-me/openclaw-wecom-cli install
```

This wraps the same quickstart / migrate / doctor flow and turns plugin install + starter config write into one command.

If you want to stay inside this repo, run the same flow with:

```bash
npm run wecom:quickstart -- --mode bot_long_connection
npm run wecom:doctor -- --json
```

If you already have `WECOM_*` / `WECOM_BOT_*` env vars prepared, WeCom also supports an env-backed `channels add` flow:

```bash
export WECOM_BOT_LONG_CONNECTION_BOT_ID=your-bot-id
export WECOM_BOT_LONG_CONNECTION_SECRET=your-bot-secret
openclaw channels add --channel wecom --use-env
```

This works without any OpenClaw core patch because the plugin exposes `setup.applyAccountConfig` for WeCom. It can persist Agent/Bot settings discovered from env vars into `openclaw.json`.  
Treat it as an advanced env-backed compatibility path, not the primary onboarding flow. For full setup, migration, and repair, the external installer remains the recommended path.

If you only want the plugin package itself:

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

Recommended minimum package version: `2.3.0`. If `plugins.installs.openclaw-wechat` in `openclaw.json` still reports `1.7.x`, upgrade or reinstall first; those older npm packages do not expose the current WeCom onboarding, migration, or reliable-delivery capabilities.

For local development or direct source-path loading, use:

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

### 2) Enable plugin in OpenClaw

If you installed via `openclaw plugins install`, add this to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

If you are loading from source path instead, use the version below with `load.paths`:

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

> Agent-mode note (important): configure **Trusted IP** in the WeCom self-built app settings and include the real egress IP of your OpenClaw gateway. Otherwise you may see "messages received but no reply".

If you want first-contact DM approval, add:

```json
{
  "channels": {
    "wecom": {
      "dm": {
        "mode": "pairing"
      }
    }
  }
}
```

### 4) Restart and verify

```bash
openclaw gateway restart
openclaw gateway status
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
```

Selfcheck now starts with two summary lines:

- `readiness`: whether receive / reply / send are currently usable
- `routing`: whether `bindings` and `dynamicAgent` are active

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

### OpenClaw-managed installation (recommended)

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

If your installed runtime still shows `1.7.x`, reinstall before debugging config; old packages can fail with `unknown channel id: wecom`.

This installs the package under `~/.openclaw/extensions/openclaw-wechat/`. Treat that directory as installed runtime package content, not as your primary business configuration surface.

### Local path loading (development mode)

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

Configure plugin load path in `~/.openclaw/openclaw.json`.

## Config Paths and Ownership

The paths raised in issue #25 serve different purposes:

| Path | Edit manually? | Purpose |
|---|---|---|
| `~/.openclaw/openclaw.json` | **Yes** | Main OpenClaw config. Put `plugins.*`, `channels.wecom.*`, `bindings`, and `env.vars` here |
| `~/.openclaw/extensions/openclaw-wechat/package.json` | Usually no | Installed package metadata |
| `~/.openclaw/extensions/openclaw-wechat/openclaw.plugin.json` | Usually no | Plugin manifest/schema used by OpenClaw |
| `~/.openclaw/extensions/openclaw-wechat/package-lock.json` | No | Dependency lockfile |
| `~/.openclaw/agents/<id>/sessions/sessions.json` | No | Runtime session index |
| `~/.openclaw/agents/<id>/sessions/*.jsonl` | No | Runtime transcripts/state |

Windows example mapping:

| Windows path | Meaning |
|---|---|
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\openclaw.json` | Main config file; this is where parameters belong |
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\extensions\\openclaw-wechat\\openclaw.plugin.json` | Plugin schema; not a business config file |
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\agents\\main\\sessions\\sessions.json` | Runtime state; do not use it as config |

Recommended placement:

| Parameter type | Where to put it |
|---|---|
| Plugin load / enable flags | `plugins.*` in `openclaw.json` |
| WeCom business config | `channels.wecom.*` |
| Multi-account settings | `channels.wecom.accounts.<id>.*` |
| Account-to-agent routing | OpenClaw root `bindings` |
| Secrets / environment-specific overrides | `env.vars.*` or system environment variables |

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
| `defaultAccount` | string | - | preferred default account for tool usage and runtime fallback |
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
| Direct-message policy | `dm.mode`, `dm.allowFrom`, `dm.rejectMessage` (`open / allowlist / pairing / deny`) |
| Event policy | `events.enabled`, `events.enterAgentWelcomeEnabled`, `events.enterAgentWelcomeText` |
| Group trigger | `groupChat.enabled`, `groupChat.triggerMode`, `groupChat.mentionPatterns`, `groupChat.triggerKeywords` |
| Group policy | `groupPolicy`, `groupChat.policy`, `groups.<chatId>.policy` (`open / allowlist / deny`) |
| Group member ACL | `groupAllowFrom`, `groups.<chatId>.allowFrom` (used with `allowlist`) |
| Dynamic route | `dynamicAgent.*` (compatible with `dynamicAgents.*`, `dm.createAgentOnFirstMessage`) |
| Debounce | `debounce.enabled`, `debounce.windowMs`, `debounce.maxBatch` |
| Agent streaming | `streaming.enabled`, `streaming.minChars`, `streaming.minIntervalMs` |
| Pending Reply persistence | `delivery.pendingReply.persist`, `delivery.pendingReply.storeFile` |
| Reasoning visibility | `delivery.reasoning.mode`, `delivery.reasoning.title`, `delivery.reasoning.maxChars` |
| Final reply format | `delivery.replyFormat` (`auto / text / markdown`) |
| Observability | `observability.enabled`, `observability.logPayloadMeta` |

### OpenClaw bindings for account-level routing

Package metadata, plugin manifest, and runtime channel meta now expose the same quickstart modes so the installer, quickstart, doctor, and future integrations can consume the same starter config and setup checklist.

Fastest entry:

```bash
npx -y @dingxiang-me/openclaw-wecom-cli install
```

If you prefer the repo-local scripts, you can still generate a starter config immediately:

```bash
npm run wecom:quickstart -- --mode bot_long_connection
```

If you prefer an interactive wizard:

```bash
npm run wecom:quickstart -- --wizard
```

Common examples:

```bash
# Recommended default mode
npm run wecom:quickstart -- --json

# Walk through mode / dm / group-policy choices interactively
npm run wecom:quickstart -- --wizard

# Run the recommended selfchecks for the selected mode
npm run wecom:quickstart -- --run-checks

# Force those checks even if starter placeholders are still present
npm run wecom:quickstart -- --run-checks --force-checks

# Write a ready-to-apply config patch and .env template to disk
npm run wecom:quickstart -- --run-checks --repair-dir ./.wecom-repair

# Merge the generated repair configPatch directly into the target openclaw.json
npm run wecom:quickstart -- --run-checks --apply-repair

# Preview the fields that would change, then confirm before applying the repair patch
npm run wecom:quickstart -- --run-checks --confirm-repair

# Inspect legacy / mixed-layout config and generate a migration patch
npm run wecom:migrate -- --json

# Aggregate migration, selfchecks, E2E checks, long-connection probe, and callback matrix
npm run wecom:doctor -- --json

# Run the local black-box onboarding flow: install -> doctor -> fix -> rerun
npm run test:e2e:local

# Verify version sync and npm pack outputs for both packages
npm run test:release

# Scaffold an account-scoped Agent callback setup
npm run wecom:quickstart -- --mode agent_callback --account sales --dm-mode allowlist

# Add a ready-to-edit group allowlist template
npm run wecom:quickstart -- --mode hybrid --group-profile allowlist_template --group-chat-id wr-ops-room --group-allow ops_lead,oncall_user

# Merge into openclaw.json and create a backup first
npm run wecom:quickstart -- --mode hybrid --write
```

Supported `--group-profile` values: `inherit`, `mention_only`, `open_direct`, `allowlist_template`, `deny`.
`--wizard` treats any CLI flags you already passed as defaults, then walks through the remaining choices and write confirmation.
`--run-checks` executes the recommended post-setup selfchecks for the selected mode; if placeholders are still present, execution is blocked unless you explicitly pass `--force-checks`.
`--apply-repair` merges `postcheck.repairArtifacts.configPatch` directly into the `--config` file and creates a backup first.
`--confirm-repair` prints the exact fields that would change, then asks before performing `--apply-repair`; the prompt stays on `stderr` so `--json` output remains machine-readable.
`npm run wecom:migrate -- --json` skips starter generation and audits only the current install / migration state, which is useful for `legacy_config / mixed_layout / stale_package`.
`npm run wecom:migrate -- --json` and `npm run wecom:doctor -- --json` now also report `migrationSource`, so you can tell whether the current layout looks closer to `official-wecom`, `sunnoy-wecom`, `legacy-openclaw-wechat`, or `mixed-source`.
`npm run wecom:doctor -- --json` aggregates `migration + selfcheck + agent/bot e2e + longconn probe + callback matrix` into one report; add `--skip-network` if you want to inspect local install / migration issues first.
`npm run wecom:doctor -- --fix --skip-network --json` applies the current local fix patch first, then reruns doctor on the merged config.
`npm run wecom:doctor -- --confirm-fix --skip-network --json` previews the exact fields first, then asks before writing the patch.
`npm run wecom:quickstart -- --json` now also returns `sourcePlaybook`, so the quickstart report itself can expose source-specific check order, placeholder guidance, and default repair behavior.
`npx -y @dingxiang-me/openclaw-wecom-cli install` first tries `openclaw plugins install @dingxiang-me/openclaw-wechat`, then writes starter config and can continue with a local doctor pass.
`npm run test:e2e:local` black-boxes the local `install -> doctor -> fix -> rerun` flow without relying on a live WeCom network.
`npm run test:release` verifies root package, installer CLI, manifest, runtime version constants, and `npm pack --dry-run` outputs before a release.
If the current layout looks closer to the official plugin, sunnoy, or legacy OpenClaw-Wechat, the `--json` report now includes `migration.guide`, source-specific notes, legacy field paths, and a rollback command.
Use `--confirm-doctor-fix` if you want the installer to ask before appending `doctor --fix`; use `--no-doctor-fix` to suppress it entirely, or `--yes` to auto-confirm prompts.
The installer `--json` report now also includes structured `actions`, so a CLI/UI layer can consume source review, migration, rollback, and rerun-doctor steps directly.
If you do not pass `--mode`, the installer can now auto-pick `bot_long_connection / agent_callback / hybrid` from the detected source plus current capabilities, and explains that decision in `sourceProfile`.
The repo now also ships two CI gates: `Onboarding E2E` for the local install loop, and `Release Check` for version/pack consistency; tag releases run a dedicated workflow that publishes both the plugin package and installer CLI in sequence.
`sourceProfile` now also exposes source-specific `checkOrder` and `repairDefaults`. Official / legacy sources still default to auto-appending `doctor --fix`, while sunnoy / mixed-source defaults stay advisory until you confirm repair explicitly.

The `--json` report now also includes:

- `placeholders`: starter-template values you still need to replace
- `setupChecklist`: the next admin/selfcheck steps to run
- `actions`: structured setup actions that CLI / UI can consume directly
- `installState / migrationState`: whether the current layout is fresh, legacy_config, stale_package, mixed_layout, or ready
- `migrationSource / migrationSourceSummary`: whether the current layout looks closer to the official plugin, sunnoy compatibility layout, legacy-openclaw-wechat, or a mixed-source config
- `fix`: whether doctor `--fix` prompted, confirmed, and wrote a local patch, plus the real `changedPaths`
- `sourcePlaybook`: the quickstart-side source-specific check order, placeholder guidance, and repair defaults
- `sourceProfile.checkOrder / sourceProfile.repairDefaults`: the source-specific validation order plus the installer's default repair strategy
- `warnings`: mode/profile-specific caveats that still need confirmation
- `postcheck`: recommended selfcheck execution status, blockage reason, or summary
- `postcheck.remediation`: actionable fix hints derived from failed checks
- `postcheck.repairArtifacts`: a minimal `configPatch` plus `.env` template you can apply directly to fix the detected setup gaps
- `postcheck.repairPlan`: itemized repair changes, env updates, and file writes
- `migration.configPatch / migration.envTemplate`: suggested normalized layout for the current legacy config

If you also pass `--repair-dir <path>`, quickstart will materialize those artifacts as:

- `wecom.config-patch.json`
- `wecom.account-patch.json`
- `wecom.env.template`
- `README.txt`

If you pass `--apply-repair`, the report will also include `repairApply` so you can see whether the repair patch was actually merged into the target config.
If you pass `--confirm-repair`, `repairApply` also includes `prompted/confirmed` so you can tell whether the patch was declined or auto-applied; actual writes are listed in `repairApply.changedPaths`.

Use OpenClaw core `bindings` for stable account-to-agent routing. The plugin exposes `channel=wecom` and `accountId=<id>` to the core router.

```json
{
  "bindings": [
    {
      "match": {
        "channel": "wecom",
        "accountId": "sales"
      },
      "agentId": "sales"
    },
    {
      "match": {
        "channel": "wecom",
        "accountId": "support"
      },
      "agentId": "support"
    }
  ]
}
```

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

Session key policy:
- default account: `wecom:<userid>`
- non-default accounts: `wecom:<accountId>:<userid>`

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
| `WECOM_DM_*`, `WECOM_<ACCOUNT>_DM_*` | DM policy + allowlist / pairing controls |
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

## Public Callbacks and Gateway Auth

### Goal

WeCom must reach the OpenClaw webhook route directly.  
The callback path must not be intercepted by:

- Gateway auth / token walls
- SSO or login redirects
- frontend/WebUI routing
- the wrong upstream service

### Recommended layout

| Scenario | Recommendation |
|---|---|
| Single domain | Route `/wecom/*`, legacy `/webhooks/app*`, and `/webhooks/wecom*` directly to the OpenClaw gateway port |
| Gateway Auth / Zero Trust enabled | Exempt those webhook paths from auth; no Authorization/Cookie/login should be required |
| Shared frontend + gateway domain | Keep frontend routes separate; do not let `/wecom/*` fall into the SPA |
| Most stable setup | Use a dedicated subdomain for WeCom callbacks |

### Minimum checks

| Probe | Expected result |
|---|---|
| `curl -i http://127.0.0.1:8885/wecom/callback` | `200` + `wecom webhook ok` |
| `curl -i http://127.0.0.1:8885/wecom/bot/callback` | `200` + `wecom bot webhook ok` |
| `curl -i https://your-domain/wecom/callback` | same as local; no HTML, no `401/403`, no redirect |
| `curl -i https://your-domain/wecom/bot/callback` | same as local; no HTML, no `401/403`, no redirect |

### What common responses mean

| Response | Meaning | Fix |
|---|---|---|
| `200` + `wecom webhook ok` / `wecom bot webhook ok` | webhook route is healthy | continue with URL verification and WeCom-side setup |
| `200` + HTML | request hit frontend/WebUI | proxy `/wecom/*` directly to the gateway |
| `401/403` | callback path is auth-gated | bypass auth for webhook paths |
| `301/302/307/308` | callback path is redirected to login/SSO/frontend | remove redirect and proxy directly to OpenClaw |
| `502/503/504` | gateway upstream is down/unreachable | fix gateway health/upstream first |
| `404` | wrong path or webhook route not registered | verify `webhookPath`, plugin load state, and legacy aliases |

### Nginx example

```nginx
server {
  listen 443 ssl http2;
  server_name wecom.example.com;

  location /wecom/ {
    proxy_pass http://127.0.0.1:8885;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /webhooks/app {
    proxy_pass http://127.0.0.1:8885;
  }

  location /webhooks/wecom {
    proxy_pass http://127.0.0.1:8885;
  }
}
```

### Cloudflare Tunnel example

```yaml
ingress:
  - hostname: wecom.example.com
    service: http://127.0.0.1:8885
  - service: http_status:404
```

### Self-check

```bash
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
```

Self-check now distinguishes:

- `route-not-found`
- `html-fallback`
- `gateway-auth`
- `redirect-auth`
- `gateway-unreachable`

## Webhook and Heartbeat Ops

### Typical use cases

| Need | Recommended path |
|---|---|
| Send a one-off group notice | `openclaw message send --channel wecom --target webhook:<name>` |
| Deliver an agent result into a WeCom group | `openclaw agent --deliver --reply-channel wecom --reply-to webhook:<name>` |
| Send periodic summaries/checks | OpenClaw `agents.defaults.heartbeat` with `target: "wecom"` and `to: "webhook:<name>"` |

### Configure named webhook targets

```json
{
  "channels": {
    "wecom": {
      "webhooks": {
        "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
        "dev": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=yyy"
      }
    }
  }
}
```

For multi-account setups you can also place them under `channels.wecom.accounts.<id>.webhooks`.

### Direct send

```bash
openclaw message send --channel wecom --target webhook:ops --message "Service has recovered"
```

### Deliver an agent turn into the group

```bash
openclaw agent \
  --message "Summarize today's alerts" \
  --deliver \
  --reply-channel wecom \
  --reply-to webhook:ops
```

### Heartbeat delivery to WeCom webhook

On this machine, OpenClaw `2026.3.2` supports heartbeat delivery by channel and target.  
For a WeCom webhook target:

```json
{
  "channels": {
    "wecom": {
      "webhooks": {
        "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
      }
    }
  },
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "30m",
        "target": "wecom",
        "to": "webhook:ops",
        "prompt": "Check gateway health, recent alerts, and WeCom channel status; if all is healthy, reply in three lines or less.",
        "ackMaxChars": 300
      }
    }
  }
}
```

Multi-account webhook delivery can add:

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "target": "wecom",
        "to": "webhook:ops",
        "accountId": "sales"
      }
    }
  }
}
```

Notes:

- `target: "wecom"` selects the WeCom channel.
- `to: "webhook:ops"` selects the named webhook target inside that channel.
- `accountId` is only needed for multi-account routing.
- If `target` is omitted, heartbeat still runs but does not deliver externally.

Useful ops commands:

```bash
openclaw system heartbeat last
openclaw config get agents.defaults.heartbeat
openclaw status --deep
openclaw logs --follow
openclaw system event --mode now --text "Run the next ops heartbeat now"
```

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
| Public `curl` returns `200`, but WeCom admin still says callback verification failed | WeCom console validation | temporary tunnel domain, untrusted public domain, or enterprise-side validation rejects the callback chain | use a stable public domain; do not use temporary domains such as `trycloudflare.com` as the formal Agent callback |
| `curl /wecom/callback` returns WebUI page | reverse-proxy path routing | `/wecom/*` path is forwarded to frontend/static site instead of OpenClaw gateway |
| `curl https://your-domain/wecom/callback` returns `401/403` | gateway auth / zero-trust auth | webhook path requires login or token |
| `curl https://your-domain/wecom/callback` returns `301/302/307/308` | login redirect / SSO / frontend route | webhook path is redirected away from OpenClaw |
| Inbound received but no reply | gateway logs + dispatch status | timeout, queueing, policy block |
| Bot image parse failed | `wecom(bot): failed to fetch image url` | expired URL/non-image stream |
| Voice transcription failed | local command/model path | whisper/ffmpeg environment issue |
| Startup logs show `wecom: account diagnosis ...` | diagnosis code + account list | multi-account token/agent/path conflict risk |
| `wecom:selfcheck -- --all-accounts` reports `account '<id>' not found or incomplete` | account layout | older selfcheck logic did not fully recognize nested `agent` blocks or legacy inline accounts, or the account is actually incomplete |
| gettoken failed | WeCom API result | wrong credentials or network/proxy |

Useful commands:

```bash
openclaw gateway status
openclaw status --deep
openclaw logs --follow
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
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
| `npm run wecom:agent:selfcheck -- --account <id>` | single-account Agent E2E self-check (URL verify + encrypted POST) |
| `npm run wecom:agent:selfcheck -- --all-accounts` | multi-account Agent E2E self-check (runs URL verify + encrypted POST per account) |
| `npm run wecom:bot:selfcheck -- --account <id>` | Bot E2E self-check (URL verify/signature/encryption/stream-refresh, supports multi-account) |
| `npm run wecom:callback:matrix -- --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | public callback matrix probe (optionally include legacy alias URLs) |
| `npm run wecom:remote:e2e -- --mode all --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | remote matrix verification (Agent + Bot) |
| `npm run wecom:remote:e2e -- --mode all --agent-url <public-agent-callback> --bot-url <public-bot-callback> --prepare-browser --collect-pdf` | remote matrix with browser sandbox prepare + PDF artifact collection |
| `WECOM_E2E_BOT_URL=<...> WECOM_E2E_AGENT_URL=<...> npm run wecom:remote:e2e -- --mode all` | env-driven remote E2E (also compatible with legacy `E2E_WECOM_*`) |
| `npm run wecom:e2e:scenario -- --scenario full-smoke --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | scenario-based E2E (preset smoke/queue workflows) |
| `npm run wecom:e2e:scenario -- --scenario callback-matrix --agent-url <public-agent-callback> --bot-url <public-bot-callback>` | callback-health-only scenario |
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

### The app can receive messages but never replies (logs look normal). Why?
Check whether **Trusted IP** is configured for the WeCom self-built app.
If trusted IP is missing, WeCom may silently block part of the send/callback chain and it looks like “received but no reply”.

Fix: add the actual egress IP of your OpenClaw gateway to the app's Trusted IP list, then retry.

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

### Why does WeCom admin still say `openapi callback verification failed` even though both local and public `curl` return `200 wecom webhook ok`?
That only proves your route is reachable. It does **not** prove the WeCom admin console will accept the callback URL.

Common causes:
1. You are using a temporary public tunnel domain such as `trycloudflare.com`
2. The tenant requires a more stable/trusted public domain
3. Your callback chain still gets rewritten by auth, redirects, frontend fallback, or edge middleware during the real WeCom-side check

Recommended action:
1. Use your own stable public domain for the self-built app callback
2. Do not use `trycloudflare.com` as the formal Agent callback URL
3. Re-check that `/wecom/callback` is free from auth, redirects, frontend fallback, and caching layers

### Why do two WeCom accounts seem to share one agent/session?
This is a multi-account routing problem, not expected channel interference.

Current behavior:
1. Agent session keys are account-aware.
2. `npm run wecom:selfcheck -- --all-accounts` recognizes `accounts.<id>`, nested `agent` blocks, and legacy inline accounts.
3. Stable account-to-agent mapping should be expressed with OpenClaw `bindings`.

Recommended verification order:
1. Run `npm run wecom:selfcheck -- --all-accounts`
2. Ensure every account shows `config.account :: OK`
3. Add explicit `bindings` for each WeCom `accountId`
4. Verify session keys are `wecom:<userid>` for default account and `wecom:<accountId>:<userid>` for non-default accounts

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

If you also need to limit which members can trigger the bot in a group, add a group member ACL:

```json
{
  "channels": {
    "wecom": {
      "groupAllowFrom": ["alice", "bob"],
      "groups": {
        "wr9N1x...": {
          "allowFrom": ["ops_lead"],
          "rejectMessage": "Only the on-duty team can trigger this bot in the group."
        }
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
