import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runReleaseCheck(args = []) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-release-check.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
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

test("wecom-release-check reports ready and validates both packages", async () => {
  const result = await runReleaseCheck(["--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.versions.package, report.versions.manifest);
  assert.equal(report.versions.package, report.versions.runtime);
  assert.equal(report.versions.package, report.versions.cliPackage);
  assert.equal(report.versions.cliDependency, `^${report.versions.package}`);
  assert.equal(report.packages.plugin.packStatus, "ok");
  assert.equal(report.packages.installer.packStatus, "ok");
  assert.equal(report.packages.plugin.files.includes("openclaw.plugin.json"), true);
  assert.equal(report.packages.installer.files.includes("bin/openclaw-wecom-cli.mjs"), true);
});
