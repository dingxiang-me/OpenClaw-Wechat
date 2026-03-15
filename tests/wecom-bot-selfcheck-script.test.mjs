import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const rootPackageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

async function runBotSelfcheck(args = []) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-bot-selfcheck.mjs");
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

function decodeAesKey(aesKey) {
  const keyBase64 = String(aesKey ?? "").endsWith("=") ? String(aesKey) : `${String(aesKey)}=`;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error(`invalid key length=${key.length}`);
  return key;
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function decryptWecomCipher({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherTextBase64, "base64")), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);
  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  return unpadded.subarray(msgStart, msgEnd).toString("utf8");
}

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return crypto.createHash("sha1").update(arr.join("")).digest("hex");
}

test("wecom-bot-selfcheck supports --all-accounts discovery", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    gateway: { port: 18885 },
    channels: {
      wecom: {
        bot: { enabled: false },
        accounts: {
          ops: { bot: { enabled: false } },
          qa: { bot: { enabled: false } },
        },
      },
    },
    env: {
      vars: {
        WECOM_MARKETING_BOT_ENABLED: "0",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck(["--config", configPath, "--all-accounts", "--json"]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report?.args?.allAccounts, true);
  assert.ok(Array.isArray(report?.accounts));
  const accountIds = new Set(report.accounts.map((item) => String(item?.account ?? "")));
  assert.equal(accountIds.has("default"), true);
  assert.equal(accountIds.has("marketing"), true);
  assert.equal(accountIds.has("ops"), true);
  assert.equal(accountIds.has("qa"), true);
  assert.ok((report?.summary?.accountsTotal ?? 0) >= 4);
  for (const accountReport of report.accounts) {
    const checkNames = accountReport.checks.map((check) => check.name);
    assert.equal(checkNames.includes("plugins.allow"), true);
  }
});

test("wecom-bot-selfcheck rejects --url with --all-accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ channels: { wecom: {} } }, null, 2), "utf8");

  const result = await runBotSelfcheck([
    "--config",
    configPath,
    "--all-accounts",
    "--url",
    "http://127.0.0.1:8885/wecom/bot/callback",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot be used with --all-accounts/i);
});

test("wecom-bot-selfcheck flags stale npm install metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
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
        bot: {
          enabled: false,
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck(["--config", configPath, "--json"]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const versionCheck = report?.accounts?.[0]?.checks?.find(
    (item) => item?.name === "plugins.install.openclaw-wechat.version",
  );
  assert.ok(versionCheck);
  assert.equal(versionCheck.ok, false);
  assert.match(versionCheck.detail, new RegExp(`expected>=${rootPackageVersion.replace(/\./g, "\\.")}`));
});

test("wecom-bot-selfcheck text summary includes group policy overview", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    channels: {
      wecom: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["ops"],
        bot: {
          enabled: false,
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck(["--config", configPath]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /group-policy: mode=allowlist trigger=mention allowFrom=1 groups=0 source=account-root/);
});

test("wecom-bot-selfcheck performs URL verify check", async (t) => {
  const token = "bot-selfcheck-token";
  const aesKey = Buffer.alloc(32, 7).toString("base64").replace(/=+$/g, "");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const echostr = String(url.searchParams.get("echostr") ?? "");
    if (req.method === "GET" && !echostr) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("wecom bot webhook ok");
      return;
    }
    if (req.method === "GET" && echostr) {
      const timestamp = String(url.searchParams.get("timestamp") ?? "");
      const nonce = String(url.searchParams.get("nonce") ?? "");
      const msgSignature = String(url.searchParams.get("msg_signature") ?? "");
      const expected = computeMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt: echostr,
      });
      if (!timestamp || !nonce || !msgSignature || expected !== msgSignature) {
        res.statusCode = 401;
        res.end("invalid signature");
        return;
      }
      const plain = decryptWecomCipher({
        aesKey,
        cipherTextBase64: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return;
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("mock post failure");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    gateway: { port },
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
          token,
          encodingAesKey: aesKey,
          webhookPath: "/wecom/bot/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck([
    "--config",
    configPath,
    "--url",
    `http://127.0.0.1:${port}/wecom/bot/callback`,
    "--poll-count",
    "1",
    "--poll-interval-ms",
    "10",
    "--json",
  ]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const accountReport = report?.accounts?.[0];
  const verifyCheck = accountReport?.checks?.find((item) => item?.name === "e2e.url.verify");
  assert.ok(verifyCheck);
  assert.equal(verifyCheck.ok, true);
});

test("wecom-bot-selfcheck reports html-fallback hint on webhook health", async (t) => {
  const token = "bot-selfcheck-token";
  const aesKey = Buffer.alloc(32, 9).toString("base64").replace(/=+$/g, "");
  const htmlBody = "<!doctype html><html><body>web ui</body></html>";
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(htmlBody);
      return;
    }
    res.statusCode = 500;
    res.end("mock post failure");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    gateway: { port },
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
          token,
          encodingAesKey: aesKey,
          webhookPath: "/wecom/bot/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck([
    "--config",
    configPath,
    "--url",
    `http://127.0.0.1:${port}/wecom/bot/callback`,
    "--poll-count",
    "1",
    "--poll-interval-ms",
    "10",
    "--json",
  ]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const accountReport = report?.accounts?.[0];
  const healthCheck = accountReport?.checks?.find((item) => item?.name === "local.webhook.health");
  assert.ok(healthCheck);
  assert.equal(healthCheck.ok, false);
  assert.equal(healthCheck?.data?.reason, "html-fallback");
});

test("wecom-bot-selfcheck reports redirect-auth hint on webhook health", async (t) => {
  const token = "bot-selfcheck-token";
  const aesKey = Buffer.alloc(32, 11).toString("base64").replace(/=+$/g, "");
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.statusCode = 302;
      res.setHeader("Location", "https://login.example.invalid/wecom");
      res.end("redirect");
      return;
    }
    res.statusCode = 401;
    res.end("unauthorized");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-bot-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    gateway: { port },
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
          token,
          encodingAesKey: aesKey,
          webhookPath: "/wecom/bot/callback",
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runBotSelfcheck([
    "--config",
    configPath,
    "--url",
    `http://127.0.0.1:${port}/wecom/bot/callback`,
    "--poll-count",
    "1",
    "--poll-interval-ms",
    "10",
    "--json",
  ]);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const accountReport = report?.accounts?.[0];
  const healthCheck = accountReport?.checks?.find((item) => item?.name === "local.webhook.health");
  assert.ok(healthCheck);
  assert.equal(healthCheck.ok, false);
  assert.equal(healthCheck?.data?.reason, "redirect-auth");
  assert.equal(healthCheck?.data?.location, "https://login.example.invalid/wecom");
});
