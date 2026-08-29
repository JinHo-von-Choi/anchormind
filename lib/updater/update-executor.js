import path from "node:path";
import { execFile } from "node:child_process";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const NEXT_STEP    = { fetch: "install", install: "migrate", migrate: null };

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, encoding: "utf8", ...opts }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

export class UpdateExecutor {
  constructor(opts) {
    this._type   = opts.installType;
    this._ver    = opts.targetVersion;
    this._root   = opts.projectRoot || DEFAULT_ROOT;
    this._exec   = opts.execCommand || ((cmd, args, o) => execFileAsync(cmd, args, { cwd: this._root, ...o }));
    this._getMig = opts.getMigrationStatus || null;
  }

  _semver() { return this._ver.replace(/^v/, ""); }

  async executeStep(step, { dryRun = true } = {}) {
    const plan = this._getPlan(step);
    if (!plan) {
      return { step, success: false, dryRun, commands: [], output: `Unsupported: ${step} for ${this._type}`, nextStep: NEXT_STEP[step] ?? null, restartRequired: false };
    }

    if (plan.commands.length === 0) {
      return { step, success: true, dryRun, commands: [], output: plan.message || "No action required", nextStep: NEXT_STEP[step] ?? null, restartRequired: plan.restartRequired ?? false };
    }

    if (dryRun) {
      const lines = plan.commands.map(c => `${c.cmd} ${(c.args || []).join(" ")}`);
      return { step, success: true, dryRun: true, commands: plan.commands, output: `[dry-run]\n${lines.join("\n")}${plan.message ? "\n" + plan.message : ""}`, nextStep: NEXT_STEP[step] ?? null, restartRequired: plan.restartRequired ?? false };
    }

    // Detect clean working tree for skipIfClean commands (git stash)
    let isClean = false;
    if (plan.commands.some(c => c.skipIfClean)) {
      try {
        const status = await this._exec("git", ["-C", this._root, "status", "--porcelain"]);
        isClean = !status || status.trim() === "";
      } catch { isClean = true; }
    }

    const outputs = [];
    for (const c of plan.commands) {
      if (c.skipIfClean && isClean) {
        outputs.push(`$ ${c.cmd} ${(c.args || []).join(" ")}\n[skipped: working tree clean]`);
        continue;
      }
      try {
        const out = await this._exec(c.cmd, c.args || [], c.opts || {});
        outputs.push(`$ ${c.cmd} ${(c.args || []).join(" ")}\n${out}`);
      } catch (err) {
        return { step, success: false, dryRun: false, commands: plan.commands, output: outputs.join("\n---\n") + `\n--- FAILED ---\n${err.message}`, nextStep: null, restartRequired: false };
      }
    }
    return { step, success: true, dryRun: false, commands: plan.commands, output: outputs.join("\n---\n") || plan.message || "Completed", nextStep: NEXT_STEP[step] ?? null, restartRequired: plan.restartRequired ?? (step === "install") };
  }

  _getPlan(step) {
    const key = `_${step}_${this._type.replace("-", "_")}`;
    return this[key]?.() || this[`_${step}_fallback`]?.();
  }

  // ===== fetch =====
  _fetch_git()        { return { commands: [{ cmd: "git", args: ["-C", this._root, "fetch", "--tags", "origin"] }] }; }
  _fetch_npm_local()  { return { commands: [{ cmd: "npm", args: ["view", "anchormind-mcp", "versions", "--json"] }] }; }
  _fetch_npm_global() { return this._fetch_npm_local(); }
  _fetch_docker()     { return { commands: [], message: "Check Docker Hub for latest anchormind image tags" }; }
  _fetch_unknown()    { return { commands: [], message: "Visit https://github.com/JinHo-von-Choi/anchormind/tags" }; }
  _fetch_fallback()   { return this._fetch_unknown(); }

  // ===== install =====
  _install_git() {
    return {
      commands: [
        { cmd: "git", args: ["-C", this._root, "stash", "--include-untracked"], skipIfClean: true },
        { cmd: "git", args: ["-C", this._root, "checkout", this._ver] },
        { cmd: "npm", args: ["install", "--production"], opts: { cwd: this._root } },
        { cmd: "git", args: ["-C", this._root, "stash", "pop"], skipIfClean: true }
      ],
      restartRequired: true
    };
  }
  _install_npm_local()  { return { commands: [{ cmd: "npm", args: ["update", "anchormind-mcp"] }], restartRequired: true }; }
  _install_npm_global() { return { commands: [{ cmd: "npm", args: ["install", "-g", `anchormind-mcp@${this._semver()}`] }], restartRequired: true }; }
  _install_docker()     { return { commands: [], message: "Docker 환경에서는 컨테이너 외부에서 이미지를 업데이트하세요:\n  docker pull jinhovonchoi/anchormind:latest\n  docker-compose up -d", restartRequired: false }; }
  _install_unknown()    { return { commands: [], message: "설치 방식을 감지할 수 없습니다. 수동으로 업데이트하세요." }; }
  _install_fallback()   { return this._install_unknown(); }

  // ===== migrate =====
  _migrate_common() {
    if (this._getMig) {
      const s = this._getMig();
      if (s.pending.length === 0) return { commands: [], message: "No pending migrations" };
      return { commands: [{ cmd: "node", args: ["scripts/migrate.js"], opts: { cwd: this._root } }], message: `Pending: ${s.pending.join(", ")}` };
    }
    return { commands: [{ cmd: "node", args: ["scripts/migrate.js"], opts: { cwd: this._root } }] };
  }
  _migrate_git()        { return this._migrate_common(); }
  _migrate_npm_local()  { return this._migrate_common(); }
  _migrate_npm_global() { return this._migrate_common(); }
  _migrate_docker()     { return this._migrate_common(); }
  _migrate_unknown()    { return this._migrate_common(); }
  _migrate_fallback()   { return this._migrate_common(); }
}
