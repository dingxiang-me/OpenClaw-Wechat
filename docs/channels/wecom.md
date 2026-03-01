---
summary: "OpenClaw-Wechat WeCom channel plugin"
---

# WeCom (企业微信) (plugin)

This channel integrates OpenClaw with WeCom (企业微信) internal apps.

## Status

- Webhook verification: supported (requires Token + EncodingAESKey)
- Inbound messages: text/image/voice/video/file/link
- Outbound: text and image
- Multi-account: supported (`channels.wecom.accounts`)
- Voice recognition: WeCom `Recognition` first; local whisper fallback supported (`channels.wecom.voiceTranscription`)

## Callback URL

Recommended:

- `https://<your-domain>/wecom/callback`

## Selfcheck

Run:

```bash
npm run wecom:selfcheck -- --account default
```

All accounts:

```bash
npm run wecom:selfcheck -- --all-accounts
```

Upgrade smoke check:

```bash
npm run wecom:smoke
```

## Coexistence (Telegram/Feishu)

See troubleshooting guide:

- `docs/troubleshooting/coexistence.md`

Optional:

- `--config ~/.openclaw/openclaw.json`
- `--skip-network`
- `--skip-local-webhook`
- `--json`

## Security

Store secrets in environment variables or secret files. Do not commit them.
