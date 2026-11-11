import fs   from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, encoding: "utf8", ...opts }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

export async function detectInstallType(opts = {}) {
  const env         = opts.env         ?? process.env;
  const dirname     = opts.dirname     ?? import.meta.dirname;
  const fileExists  = opts.fileExists  ?? ((p) => fs.existsSync(p));
  const execCommand = opts.execCommand ?? ((cmd, args, o) => execFileAsync(cmd, args, o));

  const projectRoot = opts.dirname ? path.resolve(dirname, "../..") : PROJECT_ROOT;

  if (env.MEMENTO_RUNTIME === "docker" || fileExists("/.dockerenv")) return "docker";

  if (fileExists(path.join(projectRoot, ".git"))) {
    try {
      const remotes = await execCommand("git", ["-C", projectRoot, "remote", "-v"]);
      if (remotes.includes("anchormind") || remotes.includes("memento-mcp")) return "git";
    } catch { /* no git */ }
  }

  try {
    const globalPrefix = await execCommand("npm", ["prefix", "-g"]);
    if (dirname.startsWith(globalPrefix)) return "npm-global";
  } catch { /* npm not available */ }

  if (dirname.includes("node_modules")) return "npm-local";

  return "unknown";
}
