#!/usr/bin/env node
/**
 * memento-mcp CLI 엔트리포인트.
 *
 * 작성자: 최진호
 * 작성일: 2026-05-26
 *
 * 서브커맨드를 lazy-import 방식으로 디스패치한다. `--remote <URL>` 지정 시
 * 일부 명령(recall/remember/stats/inspect/session)을 원격 MCP 서버로 위임하고,
 * 로컬 전용 명령은 즉시 거부한다. 명령 실행 후 백그라운드에서 24시간 캐시 기반
 * 업데이트 확인을 수행하며, UPDATE_CHECK_DISABLED=true 로 비활성화할 수 있다.
 *
 * 지원 커맨드: serve, migrate, cleanup, backfill, stats, health, recall, remember,
 * inspect, update, export, import, completion, session, benchmark.
 */
import "dotenv/config";
import { parseArgs } from '../lib/cli/parseArgs.js';

/** 서브커맨드 → lazy import 매핑. 각 모듈은 `default(args)`와 선택적 `usage` 문자열을 export한다. */
const COMMANDS = {
  serve:      () => import('../lib/cli/serve.js'),
  migrate:    () => import('../lib/cli/migrate.js'),
  cleanup:    () => import('../lib/cli/cleanup.js'),
  backfill:   () => import('../lib/cli/backfill.js'),
  stats:      () => import('../lib/cli/stats.js'),
  health:     () => import('../lib/cli/health.js'),
  recall:     () => import('../lib/cli/recall.js'),
  remember:   () => import('../lib/cli/remember.js'),
  inspect:    () => import('../lib/cli/inspect.js'),
  update:     () => import('../lib/cli/update.js'),
  export:     () => import('../lib/cli/export.js'),
  import:     () => import('../lib/cli/import.js'),
  completion: () => import('../lib/cli/completion.js'),
  session:    () => import('../lib/cli/session.js'),
  benchmark:  () => import('../lib/cli/benchmark.js'),
};

/** 원격 모드를 지원하지 않는 로컬 전용 명령 목록 */
const LOCAL_ONLY_COMMANDS = new Set(["serve", "migrate", "cleanup", "backfill", "health", "update", "export", "import", "benchmark"]);

/**
 * `memento-mcp --help` 출력 텍스트를 stdout으로 송출한다.
 */
function printUsage() {
  const lines = [
    'Usage: memento-mcp <command> [options]',
    '',
    'Commands:',
    '  serve                       Start the MCP server',
    '  migrate                     Run DB migrations',
    '  cleanup [--execute]         Clean noise fragments (default: dry-run)',
    '  backfill                    Backfill missing embeddings',
    '  stats                       Show fragment statistics',
    '  health                      Check DB/Redis/embedding connectivity',
    '  recall <query> [--topic x]  Search fragments from terminal',
    '  remember <content> --topic  Store a fragment from terminal',
    '  inspect <fragment-id>       Show fragment detail + 1-hop links',
    '  update [--execute] [--redetect]  Check and apply updates (default: dry-run)',
    '  export [--topic x] [--type t]   Export fragments as JSONL to stdout or file',
    '  import [--input FILE]            Import fragments from JSONL file or stdin',
    '  completion <shell>               Print shell completion script (bash|zsh)',
    '  session <list|show|delete>       Manage active sessions (headless/CI)',
    '  benchmark [--goldset FILE]       Measure recall quality against a goldset',
    '',
    'Options:',
    '  --help                      Show this help message',
    '  --json                      Output as JSON (where supported)',
    '  --remote <URL>              MCP 원격 서버 URL (recall/remember/stats/inspect 전용)',
    '  --key <KEY>                 API 키 Bearer 토큰 (--remote 사용 시 필수)',
    '  --timeout <ms>              원격 요청 타임아웃 밀리초 (default: 30000)',
    '',
    'Remote-capable commands: recall, remember, stats, inspect, session',
    'Local-only commands: serve, migrate, cleanup, backfill, health, update, export, import, benchmark',
  ];
  console.log(lines.join('\n'));
}

/**
 * CLI 인자 파싱 → 서브커맨드 모듈 로딩 → 실행 → 업데이트 캐시 확인 순으로 진행한다.
 * 알 수 없는 명령, --remote 위반, 서브커맨드 예외 발생 시 비제로 종료 코드로 종료한다.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help') {
    printUsage();
    process.exit(0);
  }

  if (!COMMANDS[cmd]) {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "memento-mcp --help" for usage.');
    process.exit(1);
  }

  const args = parseArgs(rest);

  /** --remote 지정 시 로컬 전용 명령은 즉시 거부 */
  const remoteUrl = args.remote || process.env.MEMENTO_CLI_REMOTE;
  if (remoteUrl && LOCAL_ONLY_COMMANDS.has(cmd)) {
    console.error(`'${cmd}' 명령은 로컬 전용입니다. --remote 플래그를 사용할 수 없습니다.`);
    console.error('원격 모드를 지원하는 명령: recall, remember, stats, inspect');
    process.exit(1);
  }

  // 서브명령별 --help / -h
  if (args.help || args.h) {
    const mod = await COMMANDS[cmd]();
    const helpText = mod.usage ?? mod.default?.usage ?? `No help available for: ${cmd}`;
    console.log(helpText);
    process.exit(0);
  }

  try {
    const mod = await COMMANDS[cmd]();
    await mod.default(args);
  } catch (err) {
    console.error(`[${cmd}] ${err.message}`);
    if (args.verbose) {
      console.error(err.stack);
    }
    process.exit(1);
  }

  // Non-blocking update check
  if (cmd !== "update" && process.env.UPDATE_CHECK_DISABLED !== "true") {
    import("../lib/updater/cache.js").then(async ({ UpdateCache }) => {
      const c = new UpdateCache();
      if (!c.isExpired(Number(process.env.UPDATE_CHECK_INTERVAL_HOURS || 24))) return;
      try {
        const { checkForUpdate } = await import("../lib/updater/version-checker.js");
        const r = await checkForUpdate({ githubToken: process.env.GITHUB_TOKEN });
        const { detectInstallType } = await import("../lib/updater/install-detector.js");
        c.set({ ...r, installType: await detectInstallType() });
        if (r.updateAvailable) process.stderr.write(`\n[memento-mcp] v${r.latestVersion} available. Run "memento-mcp update" to upgrade.\n`);
      } catch { /* network failure - silent */ }
    }).catch(() => {});
  }
}

main();
