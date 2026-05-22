/**
 * MorphemeIndex - 형태소 사전 관리 및 형태소 기반 임베딩 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-10
 * 수정일: 2026-05-22 (로컬 형태소 분석기 전환: MorphemeTokenizer 라우팅)
 *
 * tokenize()는 MorphemeTokenizer의 로컬 스크립트 라우팅 분석기에 위임한다.
 * 입력 텍스트를 유니코드 스크립트 런(한글/라틴/한자/가나)으로 분할하고
 * 각 런을 해당 언어 분석기(garu-ko/PorterStemmer/jieba/kuromoji)로 라우팅한다.
 * 분석기는 최초 사용 시 지연 로드되는 싱글톤이다.
 *
 * 토크나이저 경로는 MEMENTO_MORPHEME_TOKENIZER 환경변수로 선택한다.
 *   - local (기본값): 로컬 분석기 경유, 평균 ~1 ms/call, 한글+영어 상주 RSS ~25 MB
 *   - llm: 레거시 Gemini CLI 경로(_tokenizeViaLLM), 환경변수 미설정 시 _fallbackTokenize로 degrade
 *
 * agent_memory.morpheme_dict 테이블에 형태소별 임베딩을 캐시한다.
 *
 * Phase 4 변경:
 *   - getOrRegisterEmbeddings: generateBatchEmbeddings 1회 호출로 hot-path 지연 제거
 *   - multi-row INSERT 1회 (ON CONFLICT DO NOTHING)
 *   - 배치 실패 시 regex 파싱으로 문제 항목 격리 후 재시도 또는 단건 fallback
 *   - 청크 크기: 200건 또는 256KB 누적 중 먼저 도달
 */

import { getPrimaryPool }                                     from "../../tools/db.js";
import { generateEmbedding, generateBatchEmbeddings,
         vectorToSql, EMBEDDING_ENABLED }                    from "../../tools/embedding.js";
import { tokenizeLocal }                                     from "./MorphemeTokenizer.js";
import { MEMORY_CONFIG }                                     from "../../../config/memory.js";
import { logInfo, logWarn }                                  from "../../logger.js";

/** 배치 임베딩 생성 상한 (200건 또는 256KB 누적 중 먼저 도달) */
const MAX_BATCH_MORPHEMES = 200;
const MAX_BATCH_CHARS     = 256 * 1024;

const SCHEMA = "agent_memory";

export class MorphemeIndex {

  /**
   * 텍스트를 형태소 목록으로 분리
   *
   * MEMENTO_MORPHEME_TOKENIZER=local(기본값) 시 MorphemeTokenizer 로컬 분석기 경유.
   * MEMENTO_MORPHEME_TOKENIZER=llm 시 레거시 Gemini CLI 경로(_tokenizeViaLLM) 사용.
   * 분석기 오류 발생 시 _fallbackTokenize로 graceful degrade.
   *
   * @param {string} text
   * @returns {Promise<string[]>} 형태소 목록 (기본형)
   */
  async tokenize(text) {
    const cfg     = MEMORY_CONFIG.morphemeIndex || {};
    const maxMorp = cfg.maxMorphemes || 10;

    if ((cfg.tokenizer || "local") === "local") {
      try {
        const m = await tokenizeLocal(text, maxMorp);
        return m.length > 0 ? m : this._fallbackTokenize(text);
      } catch (err) {
        logWarn(`[MorphemeIndex] local tokenize failed: ${err.message}`);
        return this._fallbackTokenize(text);
      }
    }
    return this._tokenizeViaLLM(text, maxMorp);   // 롤백 경로 (env=llm)
  }

  /** @private 레거시 LLM 경로 (MEMENTO_MORPHEME_TOKENIZER=llm 시에만 사용) */
  async _tokenizeViaLLM(text, maxMorp) {
    const { geminiCLIJson, isGeminiCLIAvailable } = await import("../../gemini.js");
    if (!await isGeminiCLIAvailable()) return this._fallbackTokenize(text);

    const cfg = MEMORY_CONFIG.morphemeIndex || {};

    const systemPrompt =
      "You are a JSON array generator for morpheme extraction. " +
      "Your ONLY output MUST be a valid JSON array of strings. " +
      "Do NOT include markdown fences, explanations, reasoning, preambles, or ANY other text. " +
      "Output must be directly parseable by JSON.parse(). " +
      "Format: [\"item1\",\"item2\",\"item3\"]";

    const userPrompt =
      `Extract base-form morphemes from the following text (Korean and/or English).\n` +
      `Include: nouns, verb roots, adjective roots\n` +
      `Exclude: particles (조사), endings (어미), conjunctions, pronouns, stopwords\n` +
      `Maximum ${maxMorp} items. Each item 1-20 characters.\n\n` +
      `Example 1:\n` +
      `Input: "나는 오늘 서울에서 커피를 마셨다"\n` +
      `Output: ["오늘","서울","커피","마시"]\n\n` +
      `Example 2:\n` +
      `Input: "The quick brown fox jumps over lazy dog"\n` +
      `Output: ["quick","brown","fox","jump","lazy","dog"]\n\n` +
      `Now process this input:\n` +
      `Input: "${text.replace(/"/g, '\\"')}"\n` +
      `Output:`;

    try {
      const result = await geminiCLIJson(userPrompt, {
        timeoutMs   : cfg.geminiTimeoutMs || 45_000,
        systemPrompt
      });
      if (!Array.isArray(result)) return this._fallbackTokenize(text);
      return result.filter(m => typeof m === "string" && m.trim().length > 0).slice(0, maxMorp);
    } catch (err) {
      logWarn(`[MorphemeIndex] tokenize failed: ${err.message}`);
      return this._fallbackTokenize(text);
    }
  }

  /**
   * Gemini 불가 시 단순 공백 분리 fallback
   */
  _fallbackTokenize(text) {
    const stopwords = new Set(["이", "그", "저", "것", "수", "등", "및", "를", "을", "에",
      "의", "가", "는", "은", "도", "로", "와", "과", "한", "하",
      "the", "a", "an", "is", "are", "was", "were"]);
    return text.toLowerCase()
      .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w))
      .slice(0, 10);
  }

  /**
   * 형태소 목록의 임베딩을 사전에서 조회.
   * 사전에 없는 형태소는 배치 임베딩 API 1회 호출 후 multi-row INSERT로 등록한다.
   *
   * - 사전 검증: 빈 문자열/null/non-string 형태소 제거
   * - generateBatchEmbeddings 1회 호출 (transformers provider는 내부 단건 fallback 자동)
   * - HTTP 400 부분 실패 시 /Invalid 'input\[N\]'/ 파싱으로 문제 항목 격리 후 나머지 재시도
   * - 인덱스 미명시 에러는 단건 fallback 경로
   * - multi-row INSERT 1회: ON CONFLICT DO NOTHING으로 중복 안전
   * - 청크: MAX_BATCH_MORPHEMES(200건) 또는 누적 MAX_BATCH_CHARS(256KB) 중 먼저 도달
   * - 반환 vectors[]는 입력 morphemes 순서 보존 (기존 계약)
   *
   * @param {string[]} morphemes
   * @returns {Promise<number[][]>} 임베딩 벡터 목록
   */
  async getOrRegisterEmbeddings(morphemes) {
    if (!EMBEDDING_ENABLED || morphemes.length === 0) return [];

    const pool = getPrimaryPool();
    if (!pool) return [];

    /** 사전 검증: non-string / 공백만 형태소 제거 */
    const valid = morphemes.filter(m => typeof m === "string" && m.trim().length > 0);
    if (valid.length === 0) return [];

    const existing = await pool.query(
      `SELECT morpheme, embedding::text FROM ${SCHEMA}.morpheme_dict
       WHERE morpheme = ANY($1)`,
      [valid]
    );

    const found   = new Map(existing.rows.map(r => [r.morpheme, r.embedding]));
    const missing = valid.filter(m => !found.has(m));

    if (missing.length > 0) {
      await this._batchRegister(missing, found, pool);
    }

    /** 입력 순서 유지하여 벡터 목록 반환 (invalid 항목은 결과에서 제외) */
    const vectors = [];
    for (const m of morphemes) {
      if (typeof m !== "string" || m.trim().length === 0) continue;
      const v = found.get(m);
      if (v) {
        vectors.push(typeof v === "string" ? JSON.parse(v) : v);
      }
    }

    return vectors;
  }

  /**
   * 신규 형태소 목록을 청크 단위로 나눠 배치 등록.
   *
   * @param {string[]}                     missing
   * @param {Map<string, number[]|string>} found
   * @param {import('pg').Pool}            pool
   */
  async _batchRegister(missing, found, pool) {
    const chunks = [];
    let   chunk  = [];
    let   chars  = 0;

    for (const m of missing) {
      if (chunk.length >= MAX_BATCH_MORPHEMES ||
          (chars + m.length > MAX_BATCH_CHARS && chunk.length > 0)) {
        chunks.push(chunk);
        chunk = [];
        chars = 0;
      }
      chunk.push(m);
      chars += m.length;
    }
    if (chunk.length > 0) chunks.push(chunk);

    for (const c of chunks) {
      await this._registerChunk(c, found, pool);
    }
  }

  /**
   * 단일 청크: 배치 임베딩 생성 → multi-row INSERT 1회.
   * 배치 실패 시 문제 항목 격리 또는 단건 fallback.
   *
   * @param {string[]}                     batch
   * @param {Map<string, number[]|string>} found
   * @param {import('pg').Pool}            pool
   */
  async _registerChunk(batch, found, pool) {
    let vecs;
    try {
      vecs = await generateBatchEmbeddings(batch);
    } catch (err) {
      const badIdxs = this._parseBadIndexes(err.message ?? String(err));
      if (badIdxs.size > 0) {
        const cleaned = batch.filter((_, i) => !badIdxs.has(i));
        for (const idx of badIdxs) {
          logWarn(`[MorphemeIndex] 배치 오류로 형태소 격리: "${batch[idx]}"`);
        }
        if (cleaned.length > 0) {
          logWarn(`[MorphemeIndex] ${badIdxs.size}개 격리 후 ${cleaned.length}개 재시도`);
          await this._registerChunk(cleaned, found, pool);
        }
      } else {
        logWarn(`[MorphemeIndex] 배치 실패, 단건 fallback: ${err.message}`);
        await this._fallbackSingleRegister(batch, found, pool);
      }
      return;
    }

    if (!vecs || vecs.length !== batch.length) {
      logWarn("[MorphemeIndex] 배치 응답 길이 불일치 — 단건 fallback");
      await this._fallbackSingleRegister(batch, found, pool);
      return;
    }

    /** multi-row INSERT: VALUES ($1,$2::vector), ($3,$4::vector), ... */
    const valuePlaceholders = [];
    const params            = [];
    let   pidx              = 1;

    for (let i = 0; i < batch.length; i++) {
      valuePlaceholders.push(`($${pidx}, $${pidx + 1}::vector)`);
      params.push(batch[i], vectorToSql(vecs[i]));
      pidx += 2;
      found.set(batch[i], vecs[i]);
    }

    try {
      await pool.query(
        `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
         VALUES ${valuePlaceholders.join(", ")}
         ON CONFLICT (morpheme) DO NOTHING`,
        params
      );
      logInfo(`[MorphemeIndex] ${batch.length}개 형태소 일괄 등록 완료`);
    } catch (insertErr) {
      logWarn(`[MorphemeIndex] multi-row INSERT 실패: ${insertErr.message}`);
    }
  }

  /**
   * 배치 실패 시 단건 fallback: 형태소 하나씩 개별 처리.
   *
   * @param {string[]}                     batch
   * @param {Map<string, number[]|string>} found
   * @param {import('pg').Pool}            pool
   */
  async _fallbackSingleRegister(batch, found, pool) {
    for (const morpheme of batch) {
      try {
        const vec    = await generateEmbedding(morpheme);
        const vecStr = vectorToSql(vec);
        await pool.query(
          `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (morpheme) DO NOTHING`,
          [morpheme, vecStr]
        );
        found.set(morpheme, vec);
        logInfo(`[MorphemeIndex] 단건 등록: "${morpheme}"`);
      } catch (err) {
        logWarn(`[MorphemeIndex] embed 실패 "${morpheme}": ${err.message}`);
      }
    }
  }

  /**
   * OpenAI HTTP 400 에러 메시지에서 문제 입력 인덱스를 파싱한다.
   * 형식: "Invalid 'input[N]': ..."
   *
   * @param {string} errMsg
   * @returns {Set<number>}
   */
  _parseBadIndexes(errMsg) {
    const badSet = new Set();
    const re     = /Invalid\s+'input\[(\d+)\]'/gi;
    let   m;
    while ((m = re.exec(errMsg)) !== null) {
      badSet.add(parseInt(m[1], 10));
    }
    return badSet;
  }

  /**
   * 벡터 목록의 평균 벡터 계산
   *
   * @param {number[][]} vectors
   * @returns {number[]|null}
   */
  averageVectors(vectors) {
    if (vectors.length === 0) return null;
    const dim = vectors[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) sum[i] += v[i];
    }
    return sum.map(x => x / vectors.length);
  }

  /**
   * 텍스트 → 형태소 분리 → 임베딩 평균 벡터 반환
   * remember() 시 비동기 형태소 등록에도 사용
   *
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async textToMorphemeVector(text) {
    const morphemes = await this.tokenize(text);
    if (morphemes.length === 0) return null;
    const vectors = await this.getOrRegisterEmbeddings(morphemes);
    return this.averageVectors(vectors);
  }
}
