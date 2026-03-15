import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("external cli package declares installer bin and plugin dependency", () => {
  const rootPackagePath = path.resolve(process.cwd(), "package.json");
  const packagePath = path.resolve(process.cwd(), "packages/openclaw-wecom-cli/package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(pkg.name, "@dingxiang-me/openclaw-wecom-cli");
  assert.equal(pkg.bin["openclaw-wecom-cli"], "./bin/openclaw-wecom-cli.mjs");
  assert.equal(pkg.version, rootPkg.version);
  assert.equal(pkg.dependencies["@dingxiang-me/openclaw-wechat"], `^${rootPkg.version}`);
});
