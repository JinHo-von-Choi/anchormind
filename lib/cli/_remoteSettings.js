/**
 * hook 명령의 서버 주소와 키 출처 결정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 주소와 키는 언제나 같은 출처의 한 쌍으로 고른다. Claude Code 플러그인 훅 프로세스가 받는 userConfig 값
 * (CLAUDE_PLUGIN_OPTION_SERVER_URL, CLAUDE_PLUGIN_OPTION_API_KEY)은 둘 다 있을 때만 쓰고, 하나만 있으면 둘 다
 * 버리고 경고를 낸 뒤 MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY 쌍을 쓴다. 한 출처의 주소에 다른 출처의 키가 실려
 * 나가지 않게 한다. 환경 객체를 인자로 받는 순수 함수이며 모듈을 가져오지 않는다.
 */

/** Claude Code 플러그인 userConfig(server_url, api_key)가 훅 프로세스에 들어오는 변수 이름 */
export const PLUGIN_REMOTE_VARS = Object.freeze({ remote: "CLAUDE_PLUGIN_OPTION_SERVER_URL", key: "CLAUDE_PLUGIN_OPTION_API_KEY" });

/** 셸 환경의 CLI 원격 설정 변수 이름 */
export const CLI_REMOTE_VARS = Object.freeze({ remote: "MEMENTO_CLI_REMOTE", key: "MEMENTO_CLI_KEY" });

/**
 * @param {Record<string, string|undefined>} env 프로세스 환경
 * @returns {{ remote: string|null, key: string|null, source: "plugin"|"cli", warning: string|null }}
 */
export function resolveHookRemote(env) {
  const pluginRemote = env[PLUGIN_REMOTE_VARS.remote] || null;
  const pluginKey    = env[PLUGIN_REMOTE_VARS.key] || null;
  if (pluginRemote && pluginKey) {
    return { remote: pluginRemote, key: pluginKey, source: "plugin", warning: null };
  }
  const partial = pluginRemote || pluginKey;
  return {
    remote : env[CLI_REMOTE_VARS.remote] || null,
    key    : env[CLI_REMOTE_VARS.key] || null,
    source : "cli",
    warning: partial
      ? `only one of ${PLUGIN_REMOTE_VARS.remote} and ${PLUGIN_REMOTE_VARS.key} is set; both are ignored and ${CLI_REMOTE_VARS.remote}, ${CLI_REMOTE_VARS.key} are used`
      : null
  };
}
