// lib/cli/update.js
export const usage = [
  "Usage: memento-mcp update [options]",
  "",
  "Check for a new version and interactively apply it.",
  "Default: dry-run (shows commands without executing).",
  "",
  "Options:",
  "  --execute       Actually apply the update (fetch + install + migrate)",
  "  --redetect      Force re-detect install type (git|npm|npx)",
  "",
  "Examples:",
  "  memento-mcp update",
  "  memento-mcp update --execute",
  "  memento-mcp update --execute --redetect",
].join("\n");

import readline from "node:readline";
import { checkForUpdate }    from "../updater/version-checker.js";
import { UpdateCache }       from "../updater/cache.js";
import { detectInstallType } from "../updater/install-detector.js";
import { UpdateExecutor }    from "../updater/update-executor.js";

const cache = new UpdateCache();

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`${question} (y/N): `, answer => { rl.close(); resolve(answer.trim().toLowerCase() === "y"); });
  });
}

export async function run(args) {
  const dryRun   = args.execute !== true;
  const redetect = args.redetect === true;
  if (dryRun) console.error("[dry-run] --execute 없이 실행. 명령어 미리보기만 표시.\n");

  console.error("Checking for updates...");
  let result;
  try { result = await checkForUpdate({ githubToken: process.env.GITHUB_TOKEN }); }
  catch (err) { console.error(`Update check failed: ${err.message}`); process.exit(1); }

  console.error(`Current: ${result.currentVersion}  Latest: ${result.latestVersion}`);
  if (!result.updateAvailable) { console.error("\nAlready up to date."); process.exit(0); }

  if (result.changes.length > 0) {
    console.error(`\nChanges (${result.changes.length} commits):`);
    for (const c of result.changes.slice(0, 20)) console.error(`  ${c.sha} ${c.message}`);
    if (result.changes.length > 20) console.error(`  ... +${result.changes.length - 20} more`);
  }

  const installType = await detectInstallType(redetect ? { env: process.env } : undefined);
  console.error(`\nInstall type: ${installType}`);
  cache.set({ ...result, installType });

  const executor = new UpdateExecutor({ installType, targetVersion: `v${result.latestVersion}` });

  for (const step of ["fetch", "install", "migrate"]) {
    const label = { fetch: "Fetch changes", install: "Install update", migrate: "Run DB migrations" }[step];
    if (!await confirm(`\n${label}?`)) {
      console.error("Cancelled.");
      if (step === "migrate") console.error("Run manually: memento-mcp migrate");
      process.exit(0);
    }
    const r = await executor.executeStep(step, { dryRun });
    console.error(`\n${r.output}`);
    if (!r.success) { console.error(`${label} failed.`); process.exit(1); }
    if (r.restartRequired && !dryRun) console.error("\nRestart required to apply changes.");
  }
  console.error("\nUpdate complete!");
}

export default run;
