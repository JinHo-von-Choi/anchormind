/**
 * MorphemeTokenizer — 유니코드 스크립트 분할 + 언어별 로컬 분석기 라우팅
 *
 * 작성자: 최진호
 * 작성일: 2026-05-22
 * 수정일: 2026-05-22 (kana kuromoji 메모리 가드 추가)
 */

import { MEMORY_CONFIG } from "../../../config/memory.js";

/** 분석기 싱글톤 (최초 사용 시 지연 로드). 한글·영어만 평시 상주, 한자·가나는 등장 시 로드. */
const _loaders = { garu: null, jieba: null, kuromoji: null };

async function getGaru() {
  if (!_loaders.garu) _loaders.garu = (async () => {
    const { Garu } = await import("garu-ko");
    return Garu.load();
  })();
  return _loaders.garu;
}

async function getJieba() {
  if (!_loaders.jieba) _loaders.jieba = (async () => {
    const { Jieba } = await import("@node-rs/jieba");
    const { dict }  = await import("@node-rs/jieba/dict.js");
    return Jieba.withDict(dict);
  })();
  return _loaders.jieba;
}

async function getKuromoji() {
  if (!_loaders.kuromoji) _loaders.kuromoji = (async () => {
    const kuromoji = (await import("kuromoji")).default;
    const dicPath  = new URL("../../../node_modules/kuromoji/dict", import.meta.url).pathname;
    return new Promise((res, rej) =>
      kuromoji.builder({ dicPath }).build((e, t) => e ? rej(e) : res(t)));
  })();
  return _loaders.kuromoji;
}

/** 영어 PorterStemmer는 동기·무상태 */
let _porter = null;
async function getPorter() {
  if (!_porter) _porter = (await import("natural")).default.PorterStemmer;
  return _porter;
}

/**
 * 한국어 기능 형태소 stopword (조사·어미·접사·의존명사).
 * garu-ko는 품사 필터링기가 아니라 형태소 분리기라 조사/어미를 그대로 출력하므로,
 * 기존 Gemini 프롬프트의 "조사/어미 제외" 출력 계약을 이 세트로 재현한다.
 * 단음절 형태소는 별도로 길이 필터(length > 1)로 거른다.
 */
const KO_STOPWORDS = new Set([
  "에서", "으로", "까지", "부터", "에게", "한테", "처럼", "보다", "마다", "조차",
  "이다", "하다", "되다", "있다", "없다", "같다", "않다",
]);

/** garu-ko 출력에서 단음절·기능 형태소를 제거해 의미 형태소만 남긴다. */
function filterHangulMorphemes(tokens) {
  return tokens.filter(t => t.length > 1 && !KO_STOPWORDS.has(t));
}

/** 런 1개를 해당 분석기로 형태소화. 실패 시 공백/문자 분리 degrade. */
async function tokenizeSegment(seg) {
  try {
    switch (seg.script) {
      case "hangul":  return filterHangulMorphemes((await getGaru()).tokenize(seg.text));
      case "han":     return (await getJieba()).cut(seg.text, true);
      case "kana": {
        const cfg = MEMORY_CONFIG.morphemeIndex || {};
        if (cfg.enableKuromoji === false || seg.text.length < (cfg.kanaMinChars ?? 2))
          return seg.text.split("").filter(c => c.trim());
        const tk = await getKuromoji();
        return tk.tokenize(seg.text).map(x => x.basic_form === "*" ? x.surface_form : x.basic_form);
      }
      case "latin":   return (await getPorter()).tokenizeAndStem(seg.text);
      default:        return [];
    }
  } catch {
    return seg.text.split(/\s+/).filter(t => t.length > 1);
  }
}

/**
 * 로컬 분석기로 텍스트를 형태소 목록으로 변환한다 (Gemini CLI 대체).
 * @param {string} text
 * @param {number} maxMorphemes
 * @returns {Promise<string[]>}
 */
export async function tokenizeLocal(text, maxMorphemes = 10) {
  const segs = segmentByScript(text);
  if (segs.length === 0) return [];
  const perSeg = await Promise.all(segs.map(tokenizeSegment));
  const seen = new Set();
  const out  = [];
  for (const arr of perSeg) {
    for (const t of arr) {
      const s = (t || "").trim();
      if (s.length > 0 && !seen.has(s)) { seen.add(s); out.push(s); }
      if (out.length >= maxMorphemes) return out;
    }
  }
  return out;
}

/** 스크립트 분류용 유니코드 범위 */
const RANGES = [
  ["hangul", /[가-힣ᄀ-ᇿ㄰-㆏]/],
  ["kana",   /[぀-ヿㇰ-ㇿ]/],
  ["han",    /[一-鿿㐀-䶿]/],
  ["latin",  /[A-Za-z]/],
];

/** 라틴 런에서 코드 식별자(memento-mcp, L3)를 보존하기 위해 영숫자·하이픈·언더스코어를 한 런으로 묶는다 */
function scriptOf(ch) {
  for (const [name, re] of RANGES) if (re.test(ch)) return name;
  if (/[0-9]/.test(ch)) return "latinnum";    // 라틴 인접 숫자 — 라틴 런에만 흡수, 단독 시 other
  return "other";
}

/**
 * 텍스트를 동일 스크립트 연속 런으로 분할한다.
 * 라틴 런은 영숫자·하이픈·언더스코어를 포함해 코드 토큰을 보존한다.
 *
 * @param {string} text
 * @returns {{script: string, text: string}[]}
 */
export function segmentByScript(text) {
  const segs = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) segs.push({ script: cur.script === "latinnum" ? "latin" : cur.script, text: cur.text }); cur = null; };

  const latinFamily = (a, b) =>
    (a === "latin" || a === "latinnum") && (b === "latin" || b === "latinnum");

  for (const ch of String(text)) {
    const raw = scriptOf(ch);

    /** 하이픈/언더스코어는 현재 라틴 런 안에서만 연결 문자로 작동 */
    const isLatinGlue = /[-_]/.test(ch) && cur && (cur.script === "latin" || cur.script === "latinnum");

    /**
     * latinnum은 라틴 런 안에 있을 때만 흡수. 그 외(가나·한자 뒤 등)에서는 other로 강등.
     * isLatinGlue이면 현재 라틴 런의 스크립트를 그대로 유지.
     */
    let s;
    if (isLatinGlue) {
      s = cur.script;
    } else if (raw === "latinnum") {
      s = (cur && (cur.script === "latin" || cur.script === "latinnum")) ? "latinnum" : "other";
    } else {
      s = raw;
    }

    if (!cur) {
      if (s !== "other") cur = { script: s, text: ch };
      else if (ch.trim()) cur = { script: "other", text: ch };
      continue;
    }

    /** 같은 스크립트(또는 라틴 패밀리)면 합친다 */
    if (cur.script === s || latinFamily(cur.script, s)) {
      cur.text += ch;
      if (s === "latinnum") cur.script = "latin";
      continue;
    }

    /** 스크립트 전환 — 현재 런 flush 후 새 런 시작 */
    flush();
    if (s !== "other") cur = { script: s, text: ch };
    else if (ch.trim()) cur = { script: "other", text: ch };
  }
  flush();
  return segs;
}
