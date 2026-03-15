---
summary: "OpenClaw-Wechat WeCom channel plugin"
---

# WeCom (企业微信) (plugin)

This channel integrates OpenClaw with WeCom (企业微信) internal apps.

## Major Update: Bot Long Connection Is Production-Ready

- Official long-connection endpoint is now `wss://openws.work.weixin.qq.com`
- Inbound commands are `aibot_msg_callback` / `aibot_event_callback`
- Outbound reply command is `aibot_respond_msg`
- Runtime uses `ws` instead of Node built-in `WebSocket`, fixing the `1006` failure seen on real gateways
- Verification command:

```bash
npm run wecom:bot:longconn:probe -- --json
```

- Real gateway verification already passes:
  - socket open
  - subscribe authenticated
  - ping acked

## Major Update: Visual Config in Control UI

- You can now edit WeCom channel config directly in `Channels -> WeCom` (Control UI).
- WeCom UI hints are localized and sensitive fields are marked.
- Runtime status is clearer: `Connected` and default account display are no longer ambiguous.
- `Last inbound` updates automatically after callbacks; `n/a` before first inbound after a restart is expected.

## Status

- Webhook verification: supported (requires Token + EncodingAESKey)
- Inbound messages: text/image/voice/video/file/link (Bot quote context included)
- Outbound: Agent mode supports text/image/voice/video/file; Bot mode supports response_url mixed, WebSocket long-connection native stream, and webhook fallback media
- Local outbound media path: supported (`/abs/path`, `file://...`, `sandbox:/...`)
- Outbound target: supports `user` / `group(chatid)` / `party(dept)` / `tag` / `webhook` (including named webhook targets)
- Multi-account: supported (`channels.wecom.accounts`)
- Voice recognition: WeCom `Recognition` first; local whisper fallback supported (`channels.wecom.voiceTranscription`)
- WeCom Doc tool: supported (`wecom_doc`, built into this plugin; create/share/auth/delete/grant-access/collaborators/collect/forms/sheet-properties`; rich-text body editing is not included)
- Delivery fallback chain: enabled by default (`long_connection -> active_stream -> response_url -> webhook_bot -> agent_push`)
- Bot card replies: supported (`channels.wecom.bot.card`, `markdown/template_card`)
- Direct-message policy: supported (`channels.wecom.dm.mode=open|allowlist|deny`, account-level override via `accounts.<id>.dm`)
- Event handling: supported (`channels.wecom.events.*`, supports `enter_agent` welcome reply)
- Group trigger mode: Agent callback supports `direct` / `mention` / `keyword`; Bot mode is effectively `mention` (WeCom platform callback constraint)
- Dynamic agent route mode: `deterministic` / `mapping` / `hybrid` (`channels.wecom.dynamicAgent.mode`)
- Dynamic workspace seeding: supported via `channels.wecom.dynamicAgent.workspaceTemplate`
- Session queue / stream manager: optional (`channels.wecom.stream.manager`)
- Bot timeout tuning: supported (`channels.wecom.bot.replyTimeoutMs`, `lateReplyWatchMs`, `lateReplyPollMs`)
- Observability counters: supported (`channels.wecom.observability.*`, visible in `/status`)

## Quickstart Modes

The channel metadata now exposes three machine-readable onboarding modes for installer / quickstart / doctor flows and future integrations:

1. `bot_long_connection`
   - Recommended default
   - No public webhook required
   - Best for the fastest first reply loop
2. `agent_callback`
   - Requires a stable public callback URL
   - Best when you need proactive send, app menu, and Agent API capabilities
3. `hybrid`
   - Bot long connection for conversation
   - Agent callback for proactive send and app capabilities

Runtime helper:

```js
plugin.quickstart.listModes()
plugin.quickstart.listGroupProfiles()
plugin.quickstart.buildSetupPlan({ mode: "hybrid", groupProfile: "allowlist_template" })
plugin.quickstart.buildStarterConfig({ mode: "bot_long_connection", groupProfile: "mention_only" })
```

CLI helper:

```bash
npx -y @dingxiang-me/openclaw-wecom-cli install
npm run wecom:quickstart -- --mode bot_long_connection
npm run wecom:doctor -- --json
npm run wecom:quickstart -- --wizard
npm run wecom:quickstart -- --run-checks
npm run wecom:quickstart -- --run-checks --repair-dir ./.wecom-repair
npm run wecom:quickstart -- --run-checks --apply-repair
npm run wecom:quickstart -- --run-checks --confirm-repair
npm run wecom:migrate -- --json
npm run wecom:doctor -- --json
npm run wecom:doctor -- --fix --skip-network --json
npm run wecom:doctor -- --confirm-fix --skip-network --json
npm run test:e2e:local
npm run test:release
npm run wecom:quickstart -- --mode hybrid --group-profile allowlist_template --group-chat-id wr-ops-room --group-allow ops_lead,oncall_user
npm run wecom:quickstart -- --mode hybrid --write
openclaw channels add --channel wecom --use-env
```

`npx -y @dingxiang-me/openclaw-wecom-cli install` 会先尝试执行 `openclaw plugins install @dingxiang-me/openclaw-wechat`，然后写入 starter config，并可选继续跑本地 doctor。
`npm run wecom:quickstart` 和 `npm run wecom:doctor` 是仓库内的主推荐路径，默认文档、排障和迁移说明都围绕这两条命令展开。
`openclaw channels add --channel wecom --use-env` 现在也能走通，但它是高级兼容路径，只适合 env-backed 初始化：先把 `WECOM_*` / `WECOM_BOT_*` 环境变量准备好，再让插件暴露的 `setup.applyAccountConfig` 把它们落进 `openclaw.json`。这条路径不需要任何 OpenClaw core 补丁。
如果安装器识别到官方 / sunnoy / legacy-openclaw-wechat 风格来源，`--json` 里会直接带出 `migration.guide`、legacy 字段路径和回滚命令。
要在安装流里手工确认是否附带 `doctor --fix`，可加 `--confirm-doctor-fix`；若明确不希望附带修复，使用 `--no-doctor-fix`。
同一份 `--json` 结果还会带 `actions`，方便把来源审阅、迁移、回滚和重跑体检串成更完整的安装向导。
如果没显式传 `--mode`，安装器会结合来源和现有能力自动选 `bot_long_connection / agent_callback / hybrid`，并把决策原因写进 `sourceProfile`。
`sourceProfile` 现在还会带来源专属 `checkOrder` 和 `repairDefaults`。官方 / legacy 来源默认允许自动附带 `doctor --fix`，sunnoy / mixed-source 默认先保守输出修复建议。

如果你只想使用仓库内脚本：

```bash
npm run wecom:quickstart -- --mode bot_long_connection
npm run wecom:quickstart -- --wizard
npm run wecom:quickstart -- --run-checks
npm run wecom:quickstart -- --run-checks --repair-dir ./.wecom-repair
npm run wecom:quickstart -- --run-checks --apply-repair
npm run wecom:quickstart -- --run-checks --confirm-repair
npm run wecom:migrate -- --json
npm run wecom:doctor -- --json
npm run wecom:quickstart -- --mode hybrid --group-profile allowlist_template --group-chat-id wr-ops-room --group-allow ops_lead,oncall_user
npm run wecom:quickstart -- --mode hybrid --write
```

`buildSetupPlan()` / `--json` 会一起返回：

- `placeholders`
- `setupChecklist`
- `actions`
- `installState / migrationState`
- `migrationSource / migrationSourceSummary`
- `sourcePlaybook`
- `fix`
- `warnings`
- `postcheck.remediation`
- `postcheck.repairArtifacts`
- `postcheck.repairPlan`
- `migration.configPatch / migration.envTemplate`

`--wizard` 会把现有 CLI 参数当默认值逐步提问，并在结束时确认是否写入配置文件。
`--run-checks` 会执行当前 mode 推荐的 selfcheck；如模板仍有占位项，默认会阻止执行，除非加 `--force-checks`。
`--repair-dir` 会把 `postcheck.repairArtifacts` 直接写成补配置用的文件。
`--apply-repair` 会把 `postcheck.repairArtifacts.configPatch` 直接 merge 到目标配置文件，并自动备份原文件。
`--confirm-repair` 会先展示将要修改的字段，再确认是否真正应用 repair patch。
`npm run wecom:migrate -- --json` 只盘点当前安装状态和 legacy 布局，不生成 starter config；同时会输出 `migrationSource`，区分 `official-wecom / sunnoy-wecom / legacy-openclaw-wechat / mixed-source`。
`npm run wecom:doctor -- --json` 会把 migration、自检、Agent/Bot E2E、长连接探针和公网回调矩阵收口成一份统一报告；如果你只想先看本地安装 / 迁移问题，可以加 `--skip-network`。
`npm run wecom:doctor -- --fix --skip-network --json` 会先应用本地可落盘的 fix patch，再在修正后的配置上重跑 doctor。
`npm run wecom:doctor -- --confirm-fix --skip-network --json` 会先预览将要修改的字段，再确认是否真正写回。
`npm run wecom:quickstart -- --json` 现在也会返回 `sourcePlaybook`，把当前来源推荐的检查顺序、占位项提示和默认 repair 策略一起输出。
`npm run test:e2e:local` 会黑盒验证本地 `install -> doctor -> fix -> rerun` 闭环。
`npm run test:release` 会校验插件包、installer CLI、manifest、版本常量和 `npm pack --dry-run` 产物。
仓库 CI 现在会把这两条链单独作为 `Onboarding E2E` 和 `Release Check` 门禁；tag 发布则走独立 release workflow，顺序发布两个 npm 包。

Default recommended starter:

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "dm": {
        "mode": "pairing"
      },
      "bot": {
        "enabled": true,
        "longConnection": {
          "enabled": true,
          "botId": "your-bot-id",
          "secret": "your-bot-secret"
        }
      }
    }
  }
}
```

## Callback URL

Recommended for Agent / Bot webhook mode:

- `https://<your-domain>/wecom/callback`

If you enable `channels.wecom.bot.longConnection.enabled=true`, Bot mode does not require a public callback URL.

Public callback checklist:

- `GET /wecom/callback` should return `wecom webhook ok`
- `GET /wecom/bot/callback` should return `wecom bot webhook ok`
- Temporary tunnel domains such as `trycloudflare.com` are not recommended as formal Agent callback URLs; prefer a stable public domain
- `401/403` means the path is auth-gated by Gateway Auth / Zero Trust / reverse proxy
- `301/302/307/308` means the path is redirected to login / SSO / frontend
- `200 + HTML` means the request hit WebUI/frontend instead of the webhook route
- Exempt `/wecom/*`, `/webhooks/app*`, and `/webhooks/wecom*` from auth if your public edge uses login/token enforcement

Recommended reverse-proxy rule:

```nginx
location /wecom/ {
  proxy_pass http://127.0.0.1:8885;
}
```

Named webhook targets (optional):

- Configure `channels.wecom.webhooks` (or `accounts.<id>.webhooks`) and send to `webhook:<name>`.

Heartbeat delivery example (OpenClaw `2026.3.2`):

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
        "to": "webhook:ops"
      }
    }
  }
}
```

Useful ops commands:

```bash
openclaw system heartbeat last
openclaw config get agents.defaults.heartbeat
openclaw status --deep
```

## WeCom Doc Tool

Built into the same `OpenClaw-Wechat` plugin. No separate extension is required.

Config:

```json
{
  "channels": {
    "wecom": {
      "defaultAccount": "docs",
      "tools": {
        "doc": true,
        "docAutoGrantRequesterCollaborator": true
      },
      "accounts": {
        "docs": {
          "corpId": "wwxxxx",
          "corpSecret": "xxxx",
          "agentId": 1000008,
          "tools": {
            "doc": true
          }
        }
      }
    }
  }
}
```

Supported actions:

- `create`
- `rename`
- `get_info`
- `share`
- `get_auth`
- `diagnose_auth`
- `validate_share_link`
- `delete`
- `grant_access`
- `add_collaborators`
- `set_join_rule`
- `set_member_auth`
- `set_safety_setting`
- `create_collect`
- `modify_collect`
- `get_form_info`
- `get_form_answer`
- `get_form_statistic`
- `get_sheet_properties`

## Bot Long Connection

Supported inside the same `OpenClaw-Wechat` plugin. No separate extension is required.

Minimal config:

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "bot": {
        "enabled": true,
        "longConnection": {
          "enabled": true,
          "botId": "your-bot-id",
          "secret": "your-bot-secret"
        }
      }
    }
  }
}
```

Notes:

- Uses official WeCom WebSocket long-connection endpoint `wss://openws.work.weixin.qq.com`.
- The plugin sends `aibot_subscribe` after connect and keeps the socket alive with `ping`.
- Inbound `aibot_msg_callback` / `aibot_event_callback` are normalized into the same bot runtime pipeline used by webhook mode.
- Block streaming is pushed out as native `aibot_respond_msg`, so Bot replies can stream without `stream-refresh` polling.

Default behavior:

- In WeCom sessions, `create` will automatically add the current requester as a collaborator unless `tools.docAutoGrantRequesterCollaborator=false`.
- `diagnose_auth` will summarize member access, internal/external visibility, and whether an anonymous browser is likely to see "document not found".
- `validate_share_link` will inspect a shared URL from a guest/browser perspective and report `blankpage`, guest identity, path resource id, and share-code-related hints.
- `create` and `share` return the canonical `docId`; use that for later API operations instead of the share-link path segment.

## Group Chat Checklist

WeCom has two different integration shapes:

1. **Webhook Bot**: can be added directly to regular group chats, but callbacks are typically triggered only when the bot is mentioned (`@机器人`).
2. **Self-built App callback**: plugin supports group processing when callback payload contains `ChatId`.

To enable direct group trigger (`triggerMode=direct`) for self-built app callback, ensure:

1. Plugin config uses `channels.wecom.groupPolicy=open` (or leaves it unset) and `groupChat.enabled=true` with `triggerMode=direct`.
2. WeCom app callback is enabled and URL verification succeeded.
3. App visibility scope includes members in that group context.
4. Runtime logs show `chatId=...` for inbound messages.

If logs never show `chatId`, WeCom is not delivering group messages to this callback route.  
In that case, use **Webhook Bot mode** for regular group chat scenarios.

Note: In Bot mode, `groupChat.triggerMode=direct/keyword` is normalized to `mention` by the plugin to avoid misleading config.

If you want explicit group ACL behavior instead of implicit `allowFrom` inference:

- Use `groupPolicy=open` to allow all group members.
- Use `groupPolicy=allowlist` together with `groupAllowFrom` or `groups.<chatId>.allowFrom`.
- Use `groupPolicy=deny` to disable group handling entirely.

## Selfcheck

The selfcheck summaries now also print a `group-policy` line. It shows:

- the effective mode (`open / allowlist / deny`)
- the effective trigger mode
- whether the configured group member allowlist is active or currently ignored by `groupPolicy=open`
- where the rule came from (account override, global default, or env)

Run:

```bash
npm run wecom:selfcheck -- --account default
```

Agent E2E (URL verification + encrypted POST):

```bash
npm run wecom:agent:selfcheck -- --account default
npm run wecom:agent:selfcheck -- --all-accounts
```

All accounts:

```bash
npm run wecom:selfcheck -- --all-accounts
```

Bot E2E (signed/encrypted callback + stream refresh):

```bash
npm run wecom:bot:selfcheck
```

Thinking mode:

- Bot replies now recognize `<think>...</think>` / `<thinking>...</thinking>` / `<thought>...</thought>` and send the reasoning via native `thinking_content`.
- Think tags inside fenced code blocks and inline code are ignored.
- Final replies now support `MEDIA:` / `FILE:` directives. Directive lines are stripped from visible text, and matching workspace/URL targets are sent as media attachments.

Remote matrix E2E (against public callback URLs):

```bash
npm run wecom:remote:e2e -- --mode all --agent-url https://your-domain.example/wecom/callback --bot-url https://your-domain.example/wecom/bot/callback
```

Public callback matrix only:

```bash
npm run wecom:callback:matrix -- --agent-url https://your-domain.example/wecom/callback --bot-url https://your-domain.example/wecom/bot/callback
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
