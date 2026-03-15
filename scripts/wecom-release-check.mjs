#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../src/wecom/plugin-constants.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, "package.json");
const MANIFEST_PATH = path.join(REPO_ROOT, "openclaw.plugin.json");
const CLI_PACKAGE_PATH = path.join(REPO_ROOT, "packages/openclaw-wecom-cli/package.json");

function parseArgs(argv = []) {
  return {
    json: argv.includes("--json"),
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function addIssue(issues, kind, detail, extra = {}) {
  issues.push({
    kind,
    detail,
    ...extra,
  });
}

function commandForCurrentPlatform(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function runPackDryRun(cwd) {
  return new Promise((resolve) => {
    const child = spawn(commandForCurrentPlatform("npm"), ["pack", "--dry-run", "--json"], {
      cwd,
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
      let parsed = [];
      try {
        parsed = JSON.parse(stdout || "[]");
      } catch {}
      resolve({
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
        parsed: Array.isArray(parsed) ? parsed : [],
      });
    });
  });
}

function collectPackFileNames(packResult = {}) {
  const files = Array.isArray(packResult?.parsed?.[0]?.files) ? packResult.parsed[0].files : [];
  return uniqueStrings(files.map((item) => item?.path));
}

function buildReport({
  rootPackage,
  manifest,
  cliPackage,
  issues,
  rootPack,
  cliPack,
} = {}) {
  return {
    status: issues.length === 0 ? "ready" : "action_required",
    versions: {
      package: rootPackage?.version || "",
      manifest: manifest?.version || "",
      runtime: PLUGIN_VERSION,
      cliPackage: cliPackage?.version || "",
      cliDependency: cliPackage?.dependencies?.["@dingxiang-me/openclaw-wechat"] || "",
    },
    packages: {
      plugin: {
        name: rootPackage?.name || "",
        packStatus: rootPack?.code === 0 ? "ok" : "failed",
        fileCount: Number(rootPack?.parsed?.[0]?.files?.length || 0),
        files: collectPackFileNames(rootPack),
      },
      installer: {
        name: cliPackage?.name || "",
        packStatus: cliPack?.code === 0 ? "ok" : "failed",
        fileCount: Number(cliPack?.parsed?.[0]?.files?.length || 0),
        files: collectPackFileNames(cliPack),
      },
    },
    issues,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = [];
  const [rootPackage, manifest, cliPackage] = await Promise.all([
    readJson(ROOT_PACKAGE_PATH),
    readJson(MANIFEST_PATH),
    readJson(CLI_PACKAGE_PATH),
  ]);

  if (rootPackage.version !== manifest.version) {
    addIssue(issues, "version_mismatch", "package.json 和 openclaw.plugin.json 版本不一致。", {
      left: rootPackage.version,
      right: manifest.version,
    });
  }
  if (rootPackage.version !== PLUGIN_VERSION) {
    addIssue(issues, "version_mismatch", "package.json 和运行时 PLUGIN_VERSION 不一致。", {
      left: rootPackage.version,
      right: PLUGIN_VERSION,
    });
  }
  if (rootPackage.version !== cliPackage.version) {
    addIssue(issues, "version_mismatch", "插件包和外部 installer CLI 版本不一致。", {
      left: rootPackage.version,
      right: cliPackage.version,
    });
  }
  if (cliPackage.dependencies?.["@dingxiang-me/openclaw-wechat"] !== `^${rootPackage.version}`) {
    addIssue(issues, "dependency_mismatch", "CLI 对插件包的依赖版本未跟随当前版本。", {
      expected: `^${rootPackage.version}`,
      actual: cliPackage.dependencies?.["@dingxiang-me/openclaw-wechat"] || "",
    });
  }
  if (rootPackage?.openclaw?.install?.installerSpec !== cliPackage.name) {
    addIssue(issues, "metadata_mismatch", "openclaw.install.installerSpec 未指向当前 CLI 包名。", {
      expected: cliPackage.name,
      actual: rootPackage?.openclaw?.install?.installerSpec || "",
    });
  }
  if (rootPackage?.openclaw?.channel?.quickstart?.installerSpec !== cliPackage.name) {
    addIssue(issues, "metadata_mismatch", "quickstart.installerSpec 未指向当前 CLI 包名。", {
      expected: cliPackage.name,
      actual: rootPackage?.openclaw?.channel?.quickstart?.installerSpec || "",
    });
  }

  const [rootPack, cliPack] = await Promise.all([
    runPackDryRun(REPO_ROOT),
    runPackDryRun(path.join(REPO_ROOT, "packages/openclaw-wecom-cli")),
  ]);

  if (rootPack.code !== 0) {
    addIssue(issues, "pack_failed", "插件包 npm pack --dry-run 失败。", {
      stderr: rootPack.stderr.trim(),
    });
  }
  if (cliPack.code !== 0) {
    addIssue(issues, "pack_failed", "installer CLI npm pack --dry-run 失败。", {
      stderr: cliPack.stderr.trim(),
    });
  }

  const rootPackFiles = collectPackFileNames(rootPack);
  const cliPackFiles = collectPackFileNames(cliPack);
  for (const requiredPath of ["openclaw.plugin.json", "README.md", "CHANGELOG.md", "src/index.js"]) {
    if (!rootPackFiles.includes(requiredPath)) {
      addIssue(issues, "pack_missing_file", "插件包缺少必需文件。", {
        package: rootPackage.name,
        path: requiredPath,
      });
    }
  }
  for (const requiredPath of ["bin/openclaw-wecom-cli.mjs", "README.md", "package.json"]) {
    if (!cliPackFiles.includes(requiredPath)) {
      addIssue(issues, "pack_missing_file", "installer CLI 包缺少必需文件。", {
        package: cliPackage.name,
        path: requiredPath,
      });
    }
  }

  const report = buildReport({
    rootPackage,
    manifest,
    cliPackage,
    issues,
    rootPack,
    cliPack,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Release check: ${report.status}`);
    console.log(`- package version: ${report.versions.package}`);
    console.log(`- cli version: ${report.versions.cliPackage}`);
    console.log(`- plugin pack files: ${report.packages.plugin.fileCount}`);
    console.log(`- cli pack files: ${report.packages.installer.fileCount}`);
    if (report.issues.length > 0) {
      console.log("Issues:");
      for (const issue of report.issues) {
        console.log(`- [${issue.kind}] ${issue.detail}`);
      }
    }
  }

  assert.equal(report.status, "ready");
}

main().catch((err) => {
  const message = String(err?.stack || err?.message || err);
  console.error(message);
  process.exit(1);
});
