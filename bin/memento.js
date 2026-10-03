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
 * inspect, update, export, import, completion, session, benchmark, anchor-scope, hook, init, audit.
 */
import { parseArgs } from '../lib/cli/parseArgs.js';
import { resolveHookRemote } from '../lib/cli/_remoteSettings.js';

/**
 * 현재 디렉터리의 .env를 불러오지 않는 명령.
 * hook은 하네스가 작업 중인 저장소를 cwd로 두고 실행하므로 cwd의 .env를 읽지 않는다. 저장소의 .env가 서버 주소나
 * 키를 바꾸면 API 키와 대화 발췌가 그 주소로 간다. hook의 서버 주소와 키는 명령 인자나 프로세스 환경 변수에서만
 * 같은 출처의 한 쌍으로 읽는다(hookRemoteSettings). init은 서버 설정이 필요 없고 .env를 읽지 않는다.
 * 그 밖의 명령은 이전처럼 .env를 읽는다.
 */
const IS_HOOK                = process.argv[2] === "hook";
const DOTENV_EXEMPT_COMMANDS = new Set(["hook", "init"]);
if (!DOTENV_EXEMPT_COMMANDS.has(process.argv[2])) await import("dotenv/config");

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
  'anchor-scope': () => import('../lib/cli/anchor-scope.js'),
  hook:       () => import('../lib/cli/hook.js'),
  init:       () => import('../lib/cli/init.js'),
  audit:      () => import('../lib/cli/audit.js'),
};

/** 원격 모드를 지원하지 않는 로컬 전용 명령 목록 */
const LOCAL_ONLY_COMMANDS = new Set(["serve", "migrate", "cleanup", "backfill", "health", "update", "export", "import", "benchmark", "anchor-scope", "audit"]);

/**
 * hook 명령의 서버 주소와 키. 프로세스 환경 변수만 읽는다(.env 파일은 읽지 않는다). Claude Code 플러그인
 * userConfig 쌍(CLAUDE_PLUGIN_OPTION_SERVER_URL, CLAUDE_PLUGIN_OPTION_API_KEY)이 둘 다 있으면 그 쌍을, 아니면
 * MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY 쌍을 쓴다. 한쪽만 있는 플러그인 값은 경고와 함께 버린다.
 *
 * @returns {{ remote: string|null, key: string|null, source: string, warning: string|null }}
 */
function hookRemoteSettings() {
  return resolveHookRemote(process.env);
}

/**
 * 명령별 진입점 의존성. hook은 같은 출처의 주소와 키 한 쌍을, init은 PATH 검색 정보를 받는다.
 *
 * @param {string} cmd
 * @returns {object|undefined}
 */
function commandOverrides(cmd) {
  if (IS_HOOK)        return { remoteSettings: hookRemoteSettings };
  if (cmd === "init") return { searchPath: process.env.PATH ?? "", pathExt: process.env.PATHEXT ?? "" };
  return undefined;
}

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
    '  anchor-scope [--execute]         Inventory/normalize approved shared anchors',
    '  hook <event> --client <name>     Claude Code/Codex hook runner (SessionStart|Stop|SessionEnd)',
    '  init --target <claude|codex>     Create the Claude Code/Codex plugin (default: dry-run, --write)',
    '  audit verify [--from-seq N]      Verify the audit hash chain (exit 1 when broken)',
    '',
    'Options:',
    '  --help                      Show this help message',
    '  --json                      Output as JSON (where supported)',
    '  --remote <URL>              MCP 원격 서버 URL (recall/remember/stats/inspect 전용)',
    '  --key <KEY>                 API 키 Bearer 토큰 (--remote 사용 시 필수)',
    '  --timeout <ms>              원격 요청 타임아웃 밀리초 (default: 30000)',
    '',
    'Remote-capable commands: recall, remember, stats, inspect, session',
    'Local-only commands: serve, migrate, cleanup, backfill, health, update, export, import, benchmark, anchor-scope, audit',
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

  /**
   * 명령 결과를 표준 출력으로 내는 CLI 명령은 서버 로그를 표준 오류로 보낸다. 로거가 처음
   * 불릴 때 이 값을 읽으므로 명령 모듈을 불러오기 전에 정한다. serve는 서버 로그를 그대로 둔다.
   */
  if (cmd !== "serve" && process.env.MEMENTO_LOG_STDERR === undefined) {
    process.env.MEMENTO_LOG_STDERR = "true";
  }

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
    await mod.default(args, commandOverrides(cmd));
  } catch (err) {
    console.error(`[${cmd}] ${err.message}`);
    if (args.verbose) {
      console.error(err.stack);
    }
    process.exit(1);
  }

  // Non-blocking update check (hook은 하네스 훅 안에서 네트워크 확인을 하지 않는다)
  if (cmd !== "update" && !IS_HOOK && process.env.UPDATE_CHECK_DISABLED !== "true") {
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
