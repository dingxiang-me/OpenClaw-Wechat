# OpenClaw-Wechat vs sunnoy/openclaw-plugin-wecom

## Scope

This document tracks high-value gaps and the implementation status for this iteration.

## Capability Matrix

| Capability | sunnoy repo | OpenClaw-Wechat (before) | OpenClaw-Wechat (now) | Notes |
| --- | --- | --- | --- | --- |
| Dynamic agent routing | deterministic + mapping modules | mapping-first only | deterministic / mapping / hybrid | Added `dynamicAgent.mode` and deterministic agent id generation |
| Group trigger strategy | richer group parsing | mention toggle only (`requireMention`) | `direct` / `mention` / `keyword` | Added `groupChat.triggerMode` + keywords |
| Delivery fallback chain | explicit multi-layer | multi-layer but light observability | standardized result + attempt timing/status | Added `deliveryPath`, `finalStatus`, attempt telemetry |
| Webhook bot mixed reply | supported | supported | supported (kept) | Existing mixed `msg_item` retained |
| Inbound adapter abstraction | modular webhook layer | partial | partial+ | Existing adapter retained; parser abstraction is now documented as P3 follow-up |
| E2E/contract tests | broad matrix | unit-focused | unit+contract-like coverage | Expanded policy/routing/delivery behavior tests |

## Next Iteration Candidates (P3)

1. Split `src/index.js` into layered modules (`inbound`, `routing`, `delivery`, `media`).
2. Add remote E2E job for live WeCom callback verification.
3. Implement optional workspace template bootstrap for deterministic dynamic agents.
