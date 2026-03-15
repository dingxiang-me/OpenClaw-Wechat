#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectWecomMigrationDiagnostics,
  WECOM_MIGRATION_COMMAND,
} from "../src/wecom/migration-diagnostics.js";

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== "object") return patch;
  const out = { ...asObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeDeep(asObject(base?.[key]), value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice();
    } else {
      out[key] = value;
    }
  }
  return out;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectChangedPaths(baseValue, patchValue, prefix = "", out = []) {
  if (Array.isArray(patchValue)) {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  if (!patchValue || typeof patchValue !== "object") {
    if (!valuesEqual(baseValue, patchValue) && prefix) out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(patchValue)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const nextBase = baseValue && typeof baseValue === "object" ? baseValue[key] : undefined;
    collectChangedPaths(nextBase, value, nextPrefix, out);
  }
  return out;
}

function buildBackupPath(configPath) {
  return `${configPath}.bak-${Date.now()}`;
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(expandHome(configPath));
  try {
    const raw = await readFile(resolvedPath, "utf8");
    return {
      exists: true,
      configPath: resolvedPath,
      config: JSON.parse(raw),
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        exists: false,
        configPath: resolvedPath,
        config: {},
      };
    }
    throw err;
  }
}

async function writeMergedConfig(configPath, patch) {
  const loaded = await loadConfig(configPath);
  const changedPaths = collectChangedPaths(loaded.config, patch);
  const merged = mergeDeep(loaded.config, patch);
  const backupPath = loaded.exists ? buildBackupPath(loaded.configPath) : null;
  await mkdir(path.dirname(loaded.configPath), { recursive: true });
  if (loaded.exists) {
    await writeFile(backupPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  }
  await writeFile(loaded.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    applied: true,
    configPath: loaded.configPath,
    backupPath,
    existed: loaded.exists,
    changedPaths,
  };
}

function parseArgs(argv) {
  const out = {
    account: "default",
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    json: false,
    write: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--account" && next) {
      out.account = String(next).trim().toLowerCase() || "default";
      index += 1;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      index += 1;
    } else if (arg === "--write") {
      out.write = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat migrate

Usage:
  npm run wecom:migrate -- [options]

Options:
  --account <id>   account id used for scoped migration hints (default: default)
  --config <path>  target openclaw.json path (default: ~/.openclaw/openclaw.json)
  --write          merge generated configPatch into the target config file
  --json           print machine-readable JSON report
  -h, --help       show this help
`);
}

function printTextReport(report) {
  console.log("WeCom migrate");
  console.log(`- config: ${report.configPath}`);
  console.log(`- installState: ${report.installState}`);
  console.log(`- migrationState: ${report.migrationState}`);
  console.log(`- migrationSource: ${report.migrationSource}`);
  console.log(`- summary: ${report.installStateSummary}`);
  console.log(`- migrationSummary: ${report.migrationStateSummary}`);
  console.log(`- sourceSummary: ${report.migrationSourceSummary}`);
  if (report.installedVersion) {
    console.log(`- installedVersion: ${report.installedVersion}`);
  }
  console.log(`- migrationCommand: ${report.migrationCommand}`);

  if (Array.isArray(report.migrationSourceSignals) && report.migrationSourceSignals.length > 0) {
    console.log("- migrationSourceSignals:");
    for (const item of report.migrationSourceSignals) {
      console.log(`  - [${item.source}] ${item.path}: ${item.detail}`);
    }
  }

  if (Array.isArray(report.detectedLegacyFields) && report.detectedLegacyFields.length > 0) {
    console.log("- detectedLegacyFields:");
    for (const item of report.detectedLegacyFields) {
      console.log(`  - ${item.path}: ${item.detail}`);
    }
  }

  if (Array.isArray(report.recommendedActions) && report.recommendedActions.length > 0) {
    console.log("- recommendedActions:");
    for (const action of report.recommendedActions) {
      console.log(`  - [${action.kind}] ${action.title}: ${action.detail}`);
      if (action.command) console.log(`    command: ${action.command}`);
    }
  }

  if (report.configPatch) {
    console.log("- configPatch:");
    console.log(JSON.stringify(report.configPatch, null, 2));
  }
  if (Array.isArray(report.envTemplate?.lines) && report.envTemplate.lines.length > 0) {
    console.log("- envTemplate:");
    for (const line of report.envTemplate.lines) {
      console.log(`  - ${line}`);
    }
  }
  if (report.write?.requested) {
    console.log("- write:");
    console.log(`  - applied: ${report.write.applied ? "yes" : "no"}`);
    console.log(`  - configPath: ${report.write.configPath}`);
    if (report.write.backupPath) console.log(`  - backupPath: ${report.write.backupPath}`);
    if (Array.isArray(report.write.changedPaths) && report.write.changedPaths.length > 0) {
      console.log(`  - changedPaths: ${report.write.changedPaths.join(", ")}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const loaded = await loadConfig(args.configPath);
  const diagnostics = collectWecomMigrationDiagnostics({
    config: loaded.config,
    accountId: args.account,
  });

  const writeResult =
    args.write && diagnostics.configPatch
      ? await writeMergedConfig(loaded.configPath, diagnostics.configPatch)
      : {
          requested: args.write === true,
          applied: false,
          configPath: loaded.configPath,
          changedPaths: [],
          reason: diagnostics.configPatch ? "write not requested" : "no configPatch available",
        };

  const report = {
    accountId: args.account,
    configPath: loaded.configPath,
    installState: diagnostics.installState,
    installStateSummary: diagnostics.installStateSummary,
    migrationState: diagnostics.migrationState,
    migrationStateSummary: diagnostics.migrationStateSummary,
    migrationSource: diagnostics.migrationSource,
    migrationSourceSummary: diagnostics.migrationSourceSummary,
    migrationSourceSignals: diagnostics.migrationSourceSignals,
    installedVersion: diagnostics.installedVersion,
    expectedVersion: diagnostics.expectedVersion,
    stalePackage: diagnostics.stalePackage,
    detectedLegacyFields: diagnostics.detectedLegacyFields,
    recommendedActions: diagnostics.recommendedActions,
    configPatch: diagnostics.configPatch,
    envTemplate: diagnostics.envTemplate,
    migrationCommand: WECOM_MIGRATION_COMMAND,
    write: {
      requested: args.write === true,
      ...writeResult,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printTextReport(report);
}

main().catch((err) => {
  console.error(`WeCom migrate failed: ${String(err?.message || err)}`);
  process.exit(1);
});
