export const usage = [
  "Usage: memento-mcp cleanup [options]",
  "",
  "Remove noise fragments (low-quality, short content). Default: dry-run.",
  "",
  "Options:",
  "  --execute       Actually delete (without this flag, only previews deletions)",
  "  --include-nli   Also remove NLI-conflict fragments",
  "",
  "Examples:",
  "  memento-mcp cleanup",
  "  memento-mcp cleanup --execute",
  "  memento-mcp cleanup --execute --include-nli",
].join("\n");

export default async function cleanup(args) {
  /** DATABASE_URL 자동 구성 (POSTGRES_* 환경변수 기반) */
  if (!process.env.DATABASE_URL) {
    const h  = process.env.POSTGRES_HOST || "localhost";
    const p  = process.env.POSTGRES_PORT || "5432";
    const d  = process.env.POSTGRES_DB   || "memento";
    const u  = process.env.POSTGRES_USER || "postgres";
    const pw = process.env.POSTGRES_PASSWORD || "";
    process.env.DATABASE_URL = `postgresql://${u}:${encodeURIComponent(pw)}@${h}:${p}/${d}`;
  }

  /** cleanup-noise.js reads process.argv.slice(2) directly */
  const savedArgv = process.argv;
  try {
    process.argv = ["node", "cleanup-noise.js", ...buildFlags(args)];
    await import("../../scripts/cleanup-noise.js");
  } finally {
    process.argv = savedArgv;
  }
}

function buildFlags(args) {
  const flags = [];
  if (args.execute)    flags.push("--execute");
  if (args["include-nli"] === true || args.includeNli) flags.push("--include-nli");
  return flags;
}
