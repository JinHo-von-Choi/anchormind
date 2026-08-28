/**
 * Shell completion 스크립트 생성기.
 *
 * Usage:
 *   memento-mcp completion bash   # bash 자동완성 스크립트를 stdout에 출력
 *   memento-mcp completion zsh    # zsh 자동완성 스크립트를 stdout에 출력
 *
 * 사용자는 아래처럼 로드한다:
 *   source <(memento-mcp completion bash)
 *   source <(memento-mcp completion zsh)
 */

export const usage = [
  "Usage: memento-mcp completion <shell>",
  "",
  "Generate shell completion script and print to stdout.",
  "",
  "Supported shells:",
  "  bash   Generate bash completion script",
  "  zsh    Generate zsh completion script (bash-compat mode)",
  "",
  "Examples:",
  "  source <(memento-mcp completion bash)",
  "  source <(memento-mcp completion zsh)",
  "  memento-mcp completion bash >> ~/.bash_completion",
].join("\n");

/** 자동완성 대상 서브명령 목록 */
const COMMANDS = [
  "serve",
  "migrate",
  "cleanup",
  "backfill",
  "stats",
  "health",
  "recall",
  "remember",
  "inspect",
  "update",
  "export",
  "import",
  "completion",
  "session",
  "benchmark",
];

/** 공통 플래그 목록 */
const COMMON_OPTS = [
  "--help",
  "-h",
  "--format",
  "--json",
  "--remote",
  "--key",
  "--timeout",
];

/**
 * bash 자동완성 스크립트를 반환한다.
 * COMP_CWORD=1 이면 서브명령 목록, 그 이후에는 공통 플래그 목록을 제안한다.
 */
function buildBashScript() {
  const cmds = COMMANDS.join(" ");
  const opts = COMMON_OPTS.join(" ");

  // 주의: 셸 변수 ${COMP_WORDS[...]}, $cword 등이 JS 템플릿 보간과 충돌하지 않도록
  // 해당 부분만 문자열 연결로 조합한다.
  const curExpr  = '"${COMP_WORDS[COMP_CWORD]}"';
  const prevExpr = '"${COMP_WORDS[COMP_CWORD-1]}"';
  const wordsExpr = '("${COMP_WORDS[@]}")';

  return [
    "# bash completion for memento-mcp",
    "# source this file or add to ~/.bash_completion",
    "# Usage: source <(memento-mcp completion bash)",
    "",
    "_memento_mcp_complete() {",
    "  local cur prev words cword",
    "  _init_completion 2>/dev/null || {",
    `    cur=${curExpr}`,
    `    prev=${prevExpr}`,
    `    words=${wordsExpr}`,
    "    cword=$COMP_CWORD",
    "  }",
    "",
    `  local commands="${cmds}"`,
    `  local opts="${opts}"`,
    "",
    '  if [ "$cword" -eq 1 ]; then',
    '    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )',
    "    return 0",
    "  fi",
    "",
    '  case "$prev" in',
    "    --format)",
    '      COMPREPLY=( $(compgen -W "json table text" -- "$cur") )',
    "      return 0",
    "      ;;",
    "    --remote|--key|--timeout|--topic|--type|--input|--output|--limit|--since)",
    "      COMPREPLY=()",
    "      return 0",
    "      ;;",
    "  esac",
    "",
    '  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )',
    "}",
    "",
    "complete -F _memento_mcp_complete memento-mcp",
    "",
  ].join("\n");
}

/**
 * zsh 자동완성 스크립트를 반환한다.
 * bash 호환 모드(compinit + bashcompinit)를 사용한다.
 */
function buildZshScript() {
  const cmds = COMMANDS.join(" ");
  const opts = COMMON_OPTS.join(" ");

  const curExpr  = '"${COMP_WORDS[COMP_CWORD]}"';
  const prevExpr = '"${COMP_WORDS[COMP_CWORD-1]}"';

  return [
    "# zsh completion for memento-mcp (bash-compat mode)",
    "# source this file or add to ~/.zshrc",
    "# Usage: source <(memento-mcp completion zsh)",
    "",
    "autoload -U +X compinit    2>/dev/null; compinit    -u 2>/dev/null || true",
    "autoload -U +X bashcompinit 2>/dev/null; bashcompinit 2>/dev/null || true",
    "",
    "_memento_mcp_complete() {",
    `  local cur=${curExpr}`,
    `  local prev=${prevExpr}`,
    "",
    `  local commands="${cmds}"`,
    `  local opts="${opts}"`,
    "",
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    '    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )',
    "    return 0",
    "  fi",
    "",
    '  case "$prev" in',
    "    --format)",
    '      COMPREPLY=( $(compgen -W "json table text" -- "$cur") )',
    "      return 0",
    "      ;;",
    "    --remote|--key|--timeout|--topic|--type|--input|--output|--limit|--since)",
    "      COMPREPLY=()",
    "      return 0",
    "      ;;",
    "  esac",
    "",
    '  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )',
    "}",
    "",
    "complete -F _memento_mcp_complete memento-mcp",
    "",
  ].join("\n");
}

/**
 * completion 서브명령 진입점.
 * args._[0] 이 지원 shell 이름이어야 한다.
 */
export default function completion(args) {
  const shell = args._[0];

  if (!shell) {
    console.error(usage);
    process.exit(1);
  }

  switch (shell.toLowerCase()) {
    case "bash":
      process.stdout.write(buildBashScript());
      break;

    case "zsh":
      process.stdout.write(buildZshScript());
      break;

    default:
      console.error(`[completion] Unsupported shell: "${shell}"`);
      console.error("Supported shells: bash, zsh");
      console.error("");
      console.error(usage);
      process.exit(1);
  }
}

/** 완성 스크립트가 인식하는 서브명령 개수 (테스트용 export) */
export const COMMAND_COUNT = COMMANDS.length;
export { COMMANDS, COMMON_OPTS };
