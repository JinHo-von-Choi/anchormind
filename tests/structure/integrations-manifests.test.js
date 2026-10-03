/**
 * 하네스 플러그인 매니페스트 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * integrations/ 아래 Claude Code와 Codex 플러그인 파일을 문서화된 형식에서 옮겨 적은 JSON 스키마
 * (tests/structure/schemas)로 검사하고, 훅이 실제로 있는 명령과 옵션만 부르는지, 어떤 파일에도 키나
 * 비밀처럼 보이는 문자열이 없는지 본다. 네트워크를 쓰지 않는다.
 */

import { describe, it }                       from "node:test";
import assert                                 from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path                                   from "node:path";
import { fileURLToPath }                      from "node:url";

import { validateJsonSchema }       from "./_json-schema.js";
import { scanText }                 from "../../lib/security/SensitiveScanner.js";
import { HOOK_CLIENTS, HOOK_EVENTS } from "../../lib/hooks/hook-contract.js";
import { usage as hookUsage }       from "../../lib/cli/hook.js";
import { planInit }                 from "../../lib/cli/init.js";

/** marketplace-reference의 Reserved names 중 이 검사와 관련된 이름 */
const RESERVED_MARKETPLACE_NAMES = new Set([
  "claude-code-marketplace", "claude-code-plugins", "claude-plugins-official", "anthropic-marketplace",
  "anthropic-plugins", "agent-skills", "anthropic-agent-skills", "inline", "builtin", "skills-dir", "synced",
  "claude-plugin-test", "npm", "pip", "uv", "cargo", "github", "gh"
]);

const ROOT         = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INTEGRATIONS = path.join(ROOT, "integrations");
const readJson     = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const schema       = (name) => readJson(`tests/structure/schemas/${name}.schema.json`);

/** 플러그인 디렉터리와 그 하네스의 훅 클라이언트 이름 */
const PLUGINS = Object.freeze([
  { dir: "integrations/claude-code", client: "claude-code", hooksSchema: "claude-code-hooks" },
  { dir: "integrations/codex",       client: "codex",       hooksSchema: "codex-hooks" }
]);

/** 스키마 검사 대상: [파일, 스키마] */
const MANIFESTS = Object.freeze([
  ["integrations/claude-code/.claude-plugin/plugin.json", "claude-code-plugin"],
  ["integrations/claude-code/.mcp.json",                  "claude-code-mcp"],
  ["integrations/claude-code/hooks/hooks.json",           "claude-code-hooks"],
  ["integrations/codex/plugin.json",                      "agent-plugins-plugin"],
  ["integrations/codex/hooks/hooks.json",                 "codex-hooks"]
]);

/** 디렉터리 아래 모든 파일 경로 */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/** bin/memento.js의 COMMANDS 표에 있는 명령 이름 */
function registeredCommands() {
  const src   = readFileSync(path.join(ROOT, "bin", "memento.js"), "utf8");
  const block = src.match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  assert.ok(block, "bin/memento.js에서 COMMANDS 표를 찾지 못했다");
  return new Set([...block[1].matchAll(/^\s*['"]?([a-z][a-z-]*)['"]?\s*:/gm)].map(m => m[1]));
}

/** hooks.json의 [이벤트, 처리기] 쌍 */
function handlers(hooksFile) {
  return Object.entries(hooksFile.hooks).flatMap(([event, groups]) =>
    groups.flatMap(group => group.hooks.map(handler => ({ event, handler }))));
}

describe("매니페스트 스키마", () => {
  for (const [file, name] of MANIFESTS) {
    it(`${file}이 ${name} 스키마에 맞는다`, () => {
      assert.deepEqual(validateJsonSchema(schema(name), readJson(file)), []);
    });
  }

  it("스키마는 문서화된 제약을 어긴 매니페스트를 거른다", () => {
    const plugin = readJson("integrations/claude-code/.claude-plugin/plugin.json");
    const broken = structuredClone(plugin);
    delete broken.userConfig.api_key.title;
    broken.userConfig.api_key.secret = true;
    broken.name = "claude-anchormind";
    const errors = validateJsonSchema(schema("claude-code-plugin"), broken);
    assert.ok(errors.some(e => e.includes("missing title")), errors.join("\n"));
    assert.ok(errors.some(e => e.includes("secret: unknown property")), errors.join("\n"));
    assert.ok(errors.some(e => e.startsWith("$.name")), errors.join("\n"));

    const hooks = readJson("integrations/codex/hooks/hooks.json");
    hooks.hooks.Unknown = hooks.hooks.SessionStart;
    hooks.hooks.SessionStart[0].hooks[0].type = "http";
    assert.ok(validateJsonSchema(schema("codex-hooks"), hooks).length >= 2);
  });

  it("init이 만드는 마켓플레이스가 각 하네스 스키마에 맞는다", () => {
    const pick = (target, file) => JSON.parse(planInit({ target, dir: "/scratch/x" }).files.find(f => f.path === file).content);
    const claude = pick("claude", ".claude-plugin/marketplace.json");
    assert.deepEqual(validateJsonSchema(schema("claude-code-marketplace"), claude), []);
    assert.ok(!RESERVED_MARKETPLACE_NAMES.has(claude.name) && !/^claudeai-/.test(claude.name));
    assert.deepEqual(validateJsonSchema(schema("codex-marketplace"), pick("codex", ".agents/plugins/marketplace.json")), []);
  });

  it("npm 패키지가 init이 읽는 integrations/를 담는다", () => {
    assert.ok(readJson("package.json").files.includes("integrations/"));
  });

  it("Claude Code와 Codex 플러그인 이름이 같다", () => {
    const claude = readJson("integrations/claude-code/.claude-plugin/plugin.json");
    const codex  = readJson("integrations/codex/plugin.json");
    assert.equal(claude.name, "anchormind");
    assert.equal(codex.name, claude.name);
  });
});

describe("Claude Code 플러그인 설정값", () => {
  const plugin = readJson("integrations/claude-code/.claude-plugin/plugin.json");
  const mcp    = readJson("integrations/claude-code/.mcp.json");

  it("api_key는 보안 저장소에 두는 sensitive 값이고 기본값이 없다", () => {
    assert.equal(plugin.userConfig.api_key.sensitive, true);
    assert.equal("default" in plugin.userConfig.api_key, false);
  });

  it(".mcp.json의 ${user_config.*} 참조는 모두 선언된 userConfig 키다", () => {
    const refs = [...JSON.stringify(mcp).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]);
    assert.ok(refs.length >= 2, "서버 주소와 키를 userConfig에서 받아야 한다");
    for (const ref of refs) assert.ok(ref in plugin.userConfig, `${ref} 미선언`);
  });

  it("Authorization 헤더는 userConfig 키를 참조한다", () => {
    for (const server of Object.values(mcp.mcpServers)) {
      for (const [name, value] of Object.entries(server.headers ?? {})) {
        if (name.toLowerCase() === "authorization") assert.equal(value, "Bearer ${user_config.api_key}");
      }
    }
  });
});

describe("훅이 부르는 명령", () => {
  const binNames = new Set(Object.keys(readJson("package.json").bin));
  const commands = registeredCommands();

  for (const plugin of PLUGINS) {
    it(`${plugin.dir} 훅은 등록된 anchormind hook 명령과 옵션만 쓴다`, () => {
      const hooksFile = readJson(`${plugin.dir}/hooks/hooks.json`);
      const list      = handlers(hooksFile);
      assert.ok(list.length > 0);
      for (const { event, handler } of list) {
        assert.equal(handler.type, "command");
        const argv = handler.args ? [handler.command, ...handler.args] : handler.command.trim().split(/\s+/);
        assert.ok(binNames.has(argv[0]), `${argv[0]}은 package.json bin에 없다`);
        assert.ok(commands.has(argv[1]), `${argv[1]}은 CLI 명령 표에 없다`);
        assert.equal(argv[1], "hook");
        assert.ok(HOOK_EVENTS.includes(argv[2]), `${argv[2]}은 서버가 받는 이벤트가 아니다`);
        assert.equal(argv[2], event, "훅 이벤트와 명령의 이벤트 인자가 같아야 한다");
        const client = argv[argv.indexOf("--client") + 1];
        assert.ok(HOOK_CLIENTS.includes(client));
        assert.equal(client, plugin.client);
        for (const flag of argv.filter(a => a.startsWith("--"))) {
          assert.ok(hookUsage.includes(`${flag} `), `${flag}은 hook 명령 옵션이 아니다`);
        }
      }
    });
  }

  it("두 플러그인 모두 세션 시작 주입과 세션 종료 회고를 건다", () => {
    for (const plugin of PLUGINS) {
      const events = Object.keys(readJson(`${plugin.dir}/hooks/hooks.json`).hooks);
      assert.ok(events.includes("SessionStart"), plugin.dir);
      assert.ok(events.includes("SessionEnd"), plugin.dir);
    }
  });
});

describe("integrations의 비밀 문자열", () => {
  const files = listFiles(INTEGRATIONS);

  it("검사할 파일이 있다", () => {
    assert.ok(files.length >= MANIFESTS.length);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    it(`${rel}에 키나 비밀처럼 보이는 문자열이 없다`, () => {
      const text = readFileSync(file, "utf8");
      const high = scanText(text).rules.filter(r => r.severity === "high").map(r => r.id);
      assert.deepEqual(high, [], `민감 정보 규칙 일치: ${high.join(", ")}`);
      const tokens = (text.replace(/\$\{[^}]*\}/g, "").match(/[A-Za-z0-9_+/=-]{32,}/g) ?? [])
        .filter(t => /\d/.test(t) && /[A-Za-z]/.test(t) && !t.startsWith("http"));
      assert.deepEqual(tokens, [], "긴 무작위 토큰처럼 보이는 문자열");
      for (const m of text.matchAll(/"([A-Za-z_]*(?:key|token|secret|password)[A-Za-z_]*)"\s*:\s*"([^"]*)"/gi)) {
        assert.ok(m[2] === "" || /^\$\{[^}]+\}$/.test(m[2]) || /^Bearer \$\{[^}]+\}$/.test(m[2]),
          `${m[1]}에 문자 그대로의 값이 있다`);
      }
    });
  }
});
