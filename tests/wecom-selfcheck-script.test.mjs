import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const rootPackageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

async function runSelfcheck(args = []) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-selfcheck.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

function validAesKey(fill = 7) {
  return Buffer.alloc(32, fill).toString("base64").replace(/=+$/g, "");
}

function buildAgentBlock(agentId, overrides = {}) {
  return {
    corpId: `ww-${agentId}`,
    corpSecret: `secret-${agentId}`,
    agentId,
    callbackToken: `token-${agentId}`,
    callbackAesKey: validAesKey(Number(agentId) % 255 || 1),
    ...overrides,
  };
}

test("wecom-selfcheck resolves agent blocks and legacy inline accounts in --all-accounts mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
    },
    channels: {
      wecom: {
        agent: buildAgentBlock(1001),
        accounts: {
          number: {
            agent: buildAgentBlock(1002, { webhookPath: "/wecom/number/callback" }),
          },
        },
        legacy: buildAgentBlock(1003, { webhookPath: "/wecom/legacy/callback" }),
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runSelfcheck([
    "--config",
    configPath,
    "--all-accounts",
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report?.summary?.ok, true);
  const byAccount = new Map((report?.accounts ?? []).map((item) => [String(item?.accountId ?? ""), item]));
  assert.ok(byAccount.has("default"));
  assert.ok(byAccount.has("number"));
  assert.ok(byAccount.has("legacy"));
  for (const accountId of ["default", "number", "legacy"]) {
    const accountReport = byAccount.get(accountId);
    const configCheck = accountReport?.checks?.find((item) => item?.name === "config.account");
    assert.equal(configCheck?.ok, true, `${accountId} should resolve`);
  }
});

test("wecom-selfcheck accepts bot-only default accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-selfcheck-bot-only-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
    },
    channels: {
      wecom: {
        bot: {
          enabled: true,
          longConnection: {
            enabled: true,
            botId: "bot-only-id",
            secret: "bot-only-secret",
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runSelfcheck([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report?.summary?.ok, true);
  const accountReport = report?.accounts?.[0];
  const configCheck = accountReport?.checks?.find((item) => item?.name === "config.account");
  assert.equal(configCheck?.ok, true);
  assert.equal(accountReport?.resolved?.botOnly, true);
  assert.equal(accountReport?.overview?.canReceive, true);
  assert.equal(accountReport?.overview?.canReply, true);
});

test("wecom-selfcheck flags stale npm install metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
      installs: {
        "openclaw-wechat": {
          version: "1.7.2",
          resolvedVersion: "1.7.2",
        },
      },
    },
    channels: {
      wecom: {
        agent: buildAgentBlock(1001),
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runSelfcheck([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
    "--json",
  ]);

  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const versionCheck = report?.accounts?.[0]?.checks?.find(
    (item) => item?.name === "plugins.install.openclaw-wechat.version",
  );
  assert.ok(versionCheck);
  assert.equal(versionCheck.ok, false);
  assert.match(versionCheck.detail, new RegExp(`expected>=${rootPackageVersion.replace(/\./g, "\\.")}`));
});

test("wecom-selfcheck text summary includes persistence and reasoning overview", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    plugins: {
      allow: ["openclaw-wechat"],
      entries: {
        "openclaw-wechat": { enabled: true },
      },
    },
    channels: {
      wecom: {
        agent: buildAgentBlock(1001),
        groupPolicy: "allowlist",
        groupAllowFrom: ["alice", "bob"],
        delivery: {
          pendingReply: {
            enabled: true,
            persist: true,
            storeFile: "/tmp/wecom-reliable-delivery.json",
          },
          reasoning: {
            mode: "append",
            title: "内部推理",
            maxChars: 256,
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runSelfcheck([
    "--config",
    configPath,
    "--skip-network",
    "--skip-local-webhook",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /reliable-delivery: pendingReply=on persist=on quotaTracking=on store=\/tmp\/wecom-reliable-delivery\.json/);
  assert.match(result.stdout, /group-policy: mode=allowlist trigger=direct allowFrom=2 groups=0 source=channel-root/);
  assert.match(result.stdout, /reasoning: mode=append title=内部推理 maxChars=256/);
});
