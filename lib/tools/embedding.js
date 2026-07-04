/**
 * 문서 임베딩 유틸리티 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 설명: OpenAI 호환 임베딩 API 래퍼. EMBEDDING_PROVIDER 환경변수로 OpenAI/Gemini/Ollama 전환.
 *       SHA-256 해시를 통한 변경 감지 및 중복 탐지
 */

import { createHash } from "crypto";
import OpenAI from "openai";
import {
  OPENAI_API_KEY,
  EMBEDDING_API_KEY,
  EMBEDDING_ENABLED,
  EMBEDDING_BASE_URL,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_SUPPORTS_DIMS_PARAM,
  EMBEDDING_PROVIDER
} from "../config.js";

/** OpenAI / 호환 클라이언트 (lazy 초기화) */
let openaiClient = null;

/**
 * 벡터 L2 정규화 (단위 벡터 변환)
 *
 * @param {number[]} vec - 입력 벡터
 * @returns {number[]}    - 단위 벡터 (영벡터 입력 시 그대로 반환)
 */
export function normalizeL2(vec) {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (!isFinite(norm) || norm === 0) return vec;
  return vec.map(v => v / norm);
}

/**
 * OpenAI / 호환 클라이언트 싱글톤
 * EMBEDDING_BASE_URL 설정 시 Ollama, LocalAI, LM Studio, llama.cpp 등 호환 서버를 사용한다
 */
function getOpenAIClient() {
  if (!openaiClient) {
    if (!EMBEDDING_ENABLED) {
      throw new Error(
        "임베딩 API가 설정되지 않았습니다. EMBEDDING_API_KEY(또는 OPENAI_API_KEY) 또는 EMBEDDING_BASE_URL을 설정하세요."
      );
    }
    // EMBEDDING_BASE_URL만 설정된 경우(Ollama, LocalAI 등) 로컬 서버는 키 검증 없음
    const apiKey  = EMBEDDING_API_KEY || "sk-local";
    const options = { apiKey };
    if (EMBEDDING_BASE_URL) options.baseURL = EMBEDDING_BASE_URL;
    openaiClient  = new OpenAI(options);
  }
  return openaiClient;
}

/**
 * 문서 콘텐츠의 SHA-256 해시 생성
 *
 * @param {string} content - 원본 텍스트
 * @returns {string} hex 해시값
 */
export function computeContentHash(content) {
  return createHash("sha256")
    .update(content, "utf8")
    .digest("hex");
}

/**
 * 문서에서 임베딩에 사용할 텍스트 추출
 * frontmatter 제거, 코드 블록 축약, 링크 정리 후 적절한 길이로 자르기
 *
 * @param {string} content    - 마크다운 원본
 * @param {number} maxTokens  - 대략적인 최대 토큰 수 (기본 8000)
 * @returns {string} 정제된 텍스트
 */
export function prepareTextForEmbedding(content, maxTokens = 8000) {
  let text = content;

  /** frontmatter 제거 */
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  /** 코드 블록을 [CODE] 플레이스홀더로 축약 */
  text = text.replace(/```[\s\S]*?```/g, "[CODE]");

  /** 마크다운 링크에서 URL 제거, 텍스트만 유지 */
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  /** HTML 태그 제거 */
  text = text.replace(/<[^>]+>/g, "");

  /** 연속 공백/개행 정리 */
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  /** 대략적으로 maxTokens * 4 글자까지 (영문 기준 1 token ~ 4 chars) */
  const maxChars = maxTokens * 4;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }

  return text;
}

/**
 * 단일 텍스트의 임베딩 벡터 생성
 *
 * @param {string} text - 임베딩할 텍스트
 * @returns {Promise<number[]>} L2 정규화된 임베딩 벡터 (차원 수는 EMBEDDING_DIMENSIONS 설정값)
 */
export async function generateEmbedding(text) {
  if (EMBEDDING_PROVIDER === "transformers") {
    const { getLocalEmbedder } = await import("../embeddings/LocalTransformersEmbedder.js");
    const embedder = getLocalEmbedder(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
    return embedder.embed(text);
  }

  const client = getOpenAIClient();

  const params = { model: EMBEDDING_MODEL, input: text };
  if (EMBEDDING_SUPPORTS_DIMS_PARAM && EMBEDDING_DIMENSIONS) {
    params.dimensions = parseInt(EMBEDDING_DIMENSIONS, 10);
  }
  const response = await client.embeddings.create(params);

  return normalizeL2(response.data[0].embedding);
}

/**
 * 배치 임베딩 생성 (여러 텍스트 동시 처리)
 * OpenAI API는 한 번의 호출로 최대 2048개 입력을 처리할 수 있다.
 * transformers provider는 embedBatch를 통해 batchSize 단위 청크로 배치 추론한다.
 *
 * @param {string[]} texts      - 임베딩할 텍스트 배열
 * @param {number}   batchSize  - 호출당 처리 단위 (기본 100)
 * @returns {Promise<number[][]>} 각 텍스트의 벡터 배열
 */
export async function generateBatchEmbeddings(texts, batchSize = 100) {
  if (EMBEDDING_PROVIDER === "transformers") {
    const { getLocalEmbedder } = await import("../embeddings/LocalTransformersEmbedder.js");
    const embedder             = getLocalEmbedder(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
    const allVectors           = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      allVectors.push(...await embedder.embedBatch(chunk));
    }
    return allVectors;
  }

  const client    = getOpenAIClient();
  const allVectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch    = texts.slice(i, i + batchSize);
    const batchParams = { model: EMBEDDING_MODEL, input: batch };
    if (EMBEDDING_SUPPORTS_DIMS_PARAM && EMBEDDING_DIMENSIONS) {
      batchParams.dimensions = parseInt(EMBEDDING_DIMENSIONS, 10);
    }
    const response = await client.embeddings.create(batchParams);

    const sorted = response.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      allVectors.push(normalizeL2(item.embedding));
    }

    /** rate limit 방어: 배치 간 100ms 대기 */
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return allVectors;
}

/**
 * 마크다운 문서에서 메타데이터 추출
 *
 * @param {string} content      - 마크다운 원본
 * @param {string} relativePath - 문서 상대 경로
 * @returns {Object} 추출된 메타데이터
 */
export function extractDocumentMetadata(content, relativePath) {
  /** H1 타이틀 추출 */
  const h1Matches = [...content.matchAll(/^#\s+(.+)$/gm)];
  const h1Titles  = h1Matches.map(m => m[1].trim());

  /** frontmatter에서 title/category 추출 */
  let fmTitle    = null;
  let fmCategory = null;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm        = fmMatch[1];
    const titleLine = fm.match(/title:\s*["']?(.+?)["']?\s*$/m);
    const catLine   = fm.match(/category:\s*["']?(.+?)["']?\s*$/m);
    if (titleLine) fmTitle    = titleLine[1].trim();
    if (catLine)   fmCategory = catLine[1].trim();
  }

  /** 경로 기반 카테고리 추론 */
  const pathParts  = relativePath.split("/");
  const pathCategory = pathParts.length > 1 ? pathParts[0] : "root";

  /** 단어 수 (공백 기준 대략적 계산) */
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    title     : fmTitle || h1Titles[0] || null,
    category  : fmCategory || pathCategory,
    h1Titles,
    wordCount,
    fileSize  : Buffer.byteLength(content, "utf8")
  };
}

/**
 * 두 벡터 간 코사인 유사도 계산 (JS 레벨)
 * DB의 vector_cosine_ops와 동일한 결과
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} 0~1 사이 유사도 (1이 완전 동일)
 */
export function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error(`벡터 차원 불일치: ${vecA.length} vs ${vecB.length}`);
  }

  let dotProduct = 0;
  let normA      = 0;
  let normB      = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA      += vecA[i] * vecA[i];
    normB      += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * pgvector 형식 문자열 변환
 * number[] -> '[0.1,0.2,...]' 형식
 *
 * @param {number[]} vector
 * @returns {string}
 */
export function vectorToSql(vector) {
  return `[${vector.join(",")}]`;
}

export { OPENAI_API_KEY, EMBEDDING_API_KEY, EMBEDDING_ENABLED, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_SUPPORTS_DIMS_PARAM, EMBEDDING_PROVIDER };
