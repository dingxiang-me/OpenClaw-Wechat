import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runMatrix(args = []) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-callback-matrix.mjs");
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

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);
  return { server, port };
}

test("wecom-callback-matrix passes when all endpoints are healthy", async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/wecom/callback" || req.url === "/webhooks/app") {
      res.statusCode = 200;
      res.end("wecom webhook ok");
      return;
    }
    if (req.url === "/wecom/bot/callback" || req.url === "/webhooks/wecom") {
      res.statusCode = 200;
      res.end("wecom bot webhook ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  t.after(() => server.close());

  const result = await runMatrix([
    "--agent-url",
    `http://127.0.0.1:${port}/wecom/callback`,
    "--bot-url",
    `http://127.0.0.1:${port}/wecom/bot/callback`,
    "--agent-legacy-url",
    `http://127.0.0.1:${port}/webhooks/app`,
    "--bot-legacy-url",
    `http://127.0.0.1:${port}/webhooks/wecom`,
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report?.summary?.ok, true);
  assert.equal(report?.summary?.total, 4);
  for (const entry of report.entries) {
    assert.equal(entry?.ok, true, entry?.url);
  }
});

test("wecom-callback-matrix classifies common callback failures", async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/wecom/callback") {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    if (req.url === "/wecom/bot/callback") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><html><body>ui</body></html>");
      return;
    }
    if (req.url === "/webhooks/app") {
      res.statusCode = 302;
      res.setHeader("Location", "https://login.example.invalid/auth");
      res.end("redirect");
      return;
    }
    if (req.url === "/webhooks/wecom") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 500;
    res.end("unexpected");
  });
  t.after(() => server.close());

  const result = await runMatrix([
    "--agent-url",
    `http://127.0.0.1:${port}/wecom/callback`,
    "--bot-url",
    `http://127.0.0.1:${port}/wecom/bot/callback`,
    "--agent-legacy-url",
    `http://127.0.0.1:${port}/webhooks/app`,
    "--bot-legacy-url",
    `http://127.0.0.1:${port}/webhooks/wecom`,
    "--json",
  ]);

  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  const byId = new Map(report.entries.map((entry) => [String(entry.id), entry]));
  assert.equal(byId.get("agent")?.data?.reason, "gateway-auth");
  assert.equal(byId.get("bot")?.data?.reason, "html-fallback");
  assert.equal(byId.get("agent-legacy")?.data?.reason, "redirect-auth");
  assert.equal(byId.get("bot-legacy")?.data?.reason, "route-not-found");
});
