import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectInstallType } from "../../lib/updater/install-detector.js";

describe("detectInstallType", () => {
  it("detects docker from env", async () => {
    assert.equal(await detectInstallType({ env: { MEMENTO_RUNTIME: "docker" }, dirname: "/app/lib/updater" }), "docker");
  });

  it("detects docker from /.dockerenv", async () => {
    assert.equal(await detectInstallType({ env: {}, dirname: "/app/lib/updater", fileExists: (p) => p === "/.dockerenv" }), "docker");
  });

  it("detects git", async () => {
    const dirname = path.join(process.cwd(), "fake", "memento-mcp", "lib", "updater");
    const projectRoot = path.resolve(dirname, "../..");
    assert.equal(await detectInstallType({
      env: {}, dirname,
      fileExists: (p) => p === path.join(projectRoot, ".git"),
      execCommand: () => Promise.resolve("origin\thttps://github.com/JinHo-von-Choi/memento-mcp.git (fetch)")
    }), "git");
  });

  it("detects npm-local", async () => {
    const dirname = path.join(process.cwd(), "project", "node_modules", "memento-mcp", "lib", "updater");
    assert.equal(await detectInstallType({
      env: {}, dirname,
      fileExists: () => false, execCommand: () => Promise.reject(new Error("no git"))
    }), "npm-local");
  });

  it("detects npm-global", async () => {
    const prefix = path.join(process.cwd(), "global-prefix");
    const dirname = path.join(prefix, "node_modules", "memento-mcp", "lib", "updater");
    assert.equal(await detectInstallType({
      env: {}, dirname,
      fileExists: () => false,
      execCommand: (cmd) => cmd === "npm" ? Promise.resolve(prefix) : Promise.reject(new Error("no git"))
    }), "npm-global");
  });

  it("returns unknown", async () => {
    assert.equal(await detectInstallType({
      env: {}, dirname: "/random/path",
      fileExists: () => false, execCommand: () => Promise.reject(new Error("fail"))
    }), "unknown");
  });
});
