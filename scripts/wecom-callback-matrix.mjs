#!/usr/bin/env node

import { diagnoseWecomCallbackHealth } from "../src/wecom/callback-health-diagnostics.js";

function pickFirstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function joinBaseUrl(baseUrl, path) {
  const safeBase = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const safePath = String(path ?? "").trim();
  if (!safeBase || !safePath) return "";
  return `${safeBase}${safePath.startsWith("/") ? safePath : `/${safePath}`}`;
}

function parseArgs(argv) {
  const out = {
    agentUrl:
      pickFirstEnv("WECOM_E2E_AGENT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_AGENT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_AGENT_WEBHOOK_PATH") || "/wecom/callback"),
    botUrl:
      pickFirstEnv("WECOM_E2E_BOT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_BOT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_WEBHOOK_PATH") || "/wecom/bot/callback"),
    agentLegacyUrl: pickFirstEnv("WECOM_E2E_AGENT_LEGACY_URL"),
    botLegacyUrl: pickFirstEnv("WECOM_E2E_BOT_LEGACY_URL"),
    timeoutMs: Number(pickFirstEnv("WECOM_E2E_TIMEOUT_MS", "E2E_WECOM_STREAM_TIMEOUT_MS")) || 8000,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--agent-url" && next) {
      out.agentUrl = next;
      i += 1;
    } else if (arg === "--bot-url" && next) {
      out.botUrl = next;
      i += 1;
    } else if (arg === "--agent-legacy-url" && next) {
      out.agentLegacyUrl = next;
      i += 1;
    } else if (arg === "--bot-legacy-url" && next) {
      out.botLegacyUrl = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n);
      i += 1;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!String(out.agentUrl).trim() && !String(out.botUrl).trim() && !String(out.agentLegacyUrl).trim() && !String(out.botLegacyUrl).trim()) {
    throw new Error("At least one callback URL is required. Provide --agent-url and/or --bot-url.");
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat callback matrix

Usage:
  npm run wecom:callback:matrix -- [options]

Options:
  --agent-url <url>          Public Agent callback URL
  --bot-url <url>            Public Bot callback URL
  --agent-legacy-url <url>   Optional legacy Agent alias URL
  --bot-legacy-url <url>     Optional legacy Bot alias URL
  --timeout-ms <ms>          HTTP timeout (default: 8000)
  --json                     Print machine-readable JSON report
  -h, --help                 Show help

Env shortcuts:
  WECOM_E2E_AGENT_URL / WECOM_E2E_BOT_URL
  WECOM_E2E_AGENT_LEGACY_URL / WECOM_E2E_BOT_LEGACY_URL
  WECOM_E2E_BASE_URL + WECOM_E2E_AGENT_PATH / WECOM_E2E_BOT_PATH
  Legacy: E2E_WECOM_BASE_URL / E2E_WECOM_AGENT_WEBHOOK_PATH / E2E_WECOM_WEBHOOK_PATH
`);
}

async function fetchWithTimeout(url, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs) || 8000);
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
}

function buildTargets(args) {
  const targets = [];
  const assign = (id, mode, url, legacy) => {
    const trimmed = String(url ?? "").trim();
    if (!trimmed) return;
    targets.push({
      id,
      mode,
      url: trimmed,
      legacy: Boolean(legacy),
    });
  };

  assign("agent", "agent", args.agentUrl, false);
  assign("bot", "bot", args.botUrl, false);
  assign("agent-legacy", "agent", args.agentLegacyUrl, true);
  assign("bot-legacy", "bot", args.botLegacyUrl, true);
  return targets;
}

function getUrlPath(value) {
  try {
    return new URL(String(value ?? "")).pathname || "/";
  } catch {
    return "/";
  }
}

function humanLabel(target) {
  const modeLabel = target.mode === "bot" ? "Bot" : "Agent";
  const variantLabel = target.legacy ? "legacy" : "current";
  return `${modeLabel} ${variantLabel}`;
}

async function inspectTarget(target, timeoutMs) {
  try {
    const response = await fetchWithTimeout(target.url, timeoutMs);
    const body = await response.text();
    const diagnosis = diagnoseWecomCallbackHealth({
      status: response.status,
      body,
      mode: target.mode,
      endpoint: target.url,
      webhookPath: getUrlPath(target.url),
      location: response.headers.get("location") || "",
    });
    return {
      ...target,
      ok: diagnosis.ok,
      detail: diagnosis.detail,
      data: diagnosis.data,
      status: response.status,
    };
  } catch (err) {
    return {
      ...target,
      ok: false,
      detail: `request failed: ${String(err?.message || err)}`,
      data: {
        reason: "request-failed",
        mode: target.mode,
        endpoint: target.url,
        hints: ["检查域名解析、反向代理、网关存活和 TLS 证书配置"],
      },
      status: null,
    };
  }
}

function summarize(entries) {
  const failed = entries.filter((entry) => !entry.ok).length;
  return {
    ok: failed === 0,
    total: entries.length,
    passed: entries.length - failed,
    failed,
  };
}

function printTextReport(report) {
  console.log("WeCom callback matrix");
  for (const entry of report.entries) {
    const state = entry.ok ? "OK" : "FAIL";
    console.log(`- [${state}] ${humanLabel(entry)} -> ${entry.url}`);
    console.log(`  ${entry.detail}`);
    if (!entry.ok && entry.data?.reason) {
      console.log(`  reason=${entry.data.reason}`);
    }
  }
  console.log(
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = buildTargets(args);
  const entries = [];
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    entries.push(await inspectTarget(target, args.timeoutMs));
  }
  const report = {
    args,
    summary: summarize(entries),
    entries,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }

  process.exit(report.summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`Callback matrix failed: ${String(err?.message || err)}`);
  process.exit(1);
});
