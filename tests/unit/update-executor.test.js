import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UpdateExecutor } from "../../lib/updater/update-executor.js";

describe("UpdateExecutor", () => {
  describe("dry-run", () => {
    it("fetch returns commands without executing", async () => {
      const ex = new UpdateExecutor({ installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake", execCommand: () => Promise.resolve("ok") });
      const r = await ex.executeStep("fetch", { dryRun: true });
      assert.equal(r.dryRun, true);
      assert.ok(r.commands.length > 0);
    });

    it("install returns git commands", async () => {
      const ex = new UpdateExecutor({ installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake", execCommand: () => Promise.resolve("ok") });
      const r = await ex.executeStep("install", { dryRun: true });
      assert.ok(r.commands.some(c => c.args && c.args.includes("checkout")));
    });

    it("migrate returns migration command", async () => {
      const ex = new UpdateExecutor({
        installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake",
        execCommand: () => Promise.resolve("ok"),
        getMigrationStatus: () => ({ pending: ["migration-005.sql"], applied: [] })
      });
      const r = await ex.executeStep("migrate", { dryRun: true });
      assert.ok(r.output.includes("migration-005"));
    });
  });

  describe("execute", () => {
    it("fetch executes and returns success", async () => {
      const cmds = [];
      const ex = new UpdateExecutor({
        installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake",
        execCommand: (cmd, args) => { cmds.push({ cmd, args }); return Promise.resolve("ok"); }
      });
      const r = await ex.executeStep("fetch", { dryRun: false });
      assert.equal(r.success, true);
      assert.ok(cmds.some(c => c.cmd === "git" && c.args.includes("fetch")));
    });

    it("returns correct nextStep chain", async () => {
      const ex = new UpdateExecutor({
        installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake",
        execCommand: () => Promise.resolve("ok"),
        getMigrationStatus: () => ({ pending: [], applied: [] })
      });
      assert.equal((await ex.executeStep("fetch", { dryRun: false })).nextStep, "install");
      assert.equal((await ex.executeStep("install", { dryRun: false })).nextStep, "migrate");
      assert.equal((await ex.executeStep("migrate", { dryRun: false })).nextStep, null);
    });
  });

  describe("git clean worktree", () => {
    it("skips stash/pop when working tree is clean", async () => {
      const cmds = [];
      const ex = new UpdateExecutor({
        installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake",
        execCommand: (cmd, args) => {
          cmds.push({ cmd, args });
          if (cmd === "git" && args.includes("--porcelain")) return Promise.resolve("");
          return Promise.resolve("ok");
        }
      });
      const r = await ex.executeStep("install", { dryRun: false });
      assert.equal(r.success, true);
      // stash and stash pop should not be in executed commands (only status --porcelain, checkout)
      const stashCmds = cmds.filter(c => c.cmd === "git" && c.args.includes("stash") && !c.args.includes("--porcelain"));
      assert.equal(stashCmds.length, 0);
    });
  });

  describe("docker", () => {
    it("install returns guidance message", async () => {
      const ex = new UpdateExecutor({ installType: "docker", targetVersion: "v2.3.0", projectRoot: "/app", execCommand: () => Promise.resolve("ok") });
      const r = await ex.executeStep("install", { dryRun: false });
      assert.ok(r.output.includes("컨테이너 외부"));
    });
  });

  describe("npm-global", () => {
    it("install uses npm install -g", async () => {
      const ex = new UpdateExecutor({ installType: "npm-global", targetVersion: "v2.3.0", projectRoot: "/usr/local", execCommand: () => Promise.resolve("ok") });
      const r = await ex.executeStep("install", { dryRun: true });
      assert.ok(r.commands.some(c => c.cmd === "npm" && c.args.includes("anchormind-mcp@2.3.0")));
    });
  });
});
