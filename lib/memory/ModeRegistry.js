/**
 * ModeRegistry — Mode Preset 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * startup 시 lib/memory/modes/*.json을 일괄 로드하여 Map에 적재한다.
 * filterTools(tools, presetName): excluded_tools 기반 도구 필터링.
 * getSkillGuideOverride(presetName): skill_guide_override 반환.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logWarn } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODES_DIR = path.join(__dirname, "modes");

/** @type {Map<string, import('./ModeRegistry.js').ModePreset>} */
const _presets  = new Map();

let _loaded     = false;

/**
 * modes/*.json 을 읽어 _presets Map에 적재 (멱등).
 * 서버 시작 시 1회 호출; 이후 호출은 무시.
 */
function _load() {
  if (_loaded) return;
  _loaded = true;

  let entries;
  try {
    entries = fs.readdirSync(MODES_DIR).filter(f => f.endsWith(".json"));
  // iron-laws: ignore[IL-301] logWarn으로 기록하고 preset 없이 동작한다
  } catch {
    logWarn("[ModeRegistry] modes/ 디렉터리를 읽을 수 없음 — preset 없이 동작");
    return;
  }

  for (const file of entries) {
    try {
      const raw    = fs.readFileSync(path.join(MODES_DIR, file), "utf8");
      const preset = JSON.parse(raw);

      if (typeof preset.name !== "string" || !preset.name) {
        logWarn(`[ModeRegistry] ${file}: name 필드 없음 — 건너뜀`);
        continue;
      }

      _presets.set(preset.name, {
        name                : preset.name,
        description         : preset.description          ?? "",
        excluded_tools      : Array.isArray(preset.excluded_tools)  ? preset.excluded_tools  : [],
        fixed_tools         : Array.isArray(preset.fixed_tools)     ? preset.fixed_tools     : [],
        skill_guide_override: typeof preset.skill_guide_override === "string"
                              ? preset.skill_guide_override
                              : null,
        requiresMaster      : preset.requiresMaster       === true
      });
    } catch (err) {
      logWarn(`[ModeRegistry] ${file} 파싱 실패: ${err.message} — 건너뜀`);
    }
  }
}

/** 지연 초기화 보장 */
function _ensureLoaded() {
  if (!_loaded) _load();
}

/**
 * preset 조회
 *
 * @param {string} name
 * @returns {import('./ModeRegistry.js').ModePreset | null}
 */
export function getPreset(name) {
  _ensureLoaded();
  return _presets.get(name) ?? null;
}

/**
 * 등록된 preset 이름 목록
 *
 * @returns {string[]}
 */
export function listPresets() {
  _ensureLoaded();
  return [..._presets.keys()];
}

/**
 * excluded_tools 적용 후 도구 목록 반환
 *
 * @param {object[]} tools       - tools/list 후보 배열 (name 필드 필수)
 * @param {string|null} presetName
 * @param {boolean}     isMaster  - keyId === null 여부 (audit 등 requiresMaster 체크)
 * @returns {object[]}
 */
export function filterTools(tools, presetName, isMaster = false) {
  if (!presetName) return tools;

  _ensureLoaded();

  const preset = _presets.get(presetName);
  if (!preset) return tools;

  /** requiresMaster 이지만 master 세션이 아니면 preset 무시 (전체 도구 노출) */
  if (preset.requiresMaster && !isMaster) return tools;

  const excluded = new Set(preset.excluded_tools);
  if (excluded.size === 0) return tools;

  return tools.filter(t => !excluded.has(t.name));
}

/**
 * skill_guide_override 반환
 *
 * @param {string|null} presetName
 * @param {boolean}     isMaster
 * @returns {string | null}
 */
export function getSkillGuideOverride(presetName, isMaster = false) {
  if (!presetName) return null;

  _ensureLoaded();

  const preset = _presets.get(presetName);
  if (!preset) return null;

  if (preset.requiresMaster && !isMaster) return null;

  return preset.skill_guide_override;
}

/**
 * 명시적 초기화 (서버 시작 시 미리 로드해 첫 요청 지연 방지)
 */
export function initModeRegistry() {
  _load();
}
