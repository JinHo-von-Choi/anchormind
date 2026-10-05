/**
 * normalize-vectors.js — 기존 임베딩 벡터 일괄 L2 정규화
 *
 * 작성자: 최진호
 * 작성일: 2026-03-03
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: agent_memory.fragments 테이블의 모든 임베딩 벡터를 L2 정규화한다.
 * 호출 조건: 임베딩 제공자 전환 직후 또는 신규 설치 후 1회 실행. 멱등 실행 가능.
 * 빈도: 조건부 1회
 * 의존: DATABASE_URL
 * 관련 문서: docs/operations/upgrade-notes.md#버전별-업그레이드-절차, docs/operations/maintenance.md
 */

import pg from "pg";
import { normalizeL2 } from "../lib/tools/embedding.js";

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SCHEMA = "agent_memory";
const BATCH  = 100;

async function run() {
    let offset  = 0;
    let updated = 0;

    console.log("기존 임베딩 벡터 L2 정규화 시작...");

    const extra = process.env.PGVECTOR_SCHEMA ? `, ${process.env.PGVECTOR_SCHEMA}` : "";
    await pool.query(`SET search_path TO agent_memory${extra}, public`);

    while (true) {
        const { rows } = await pool.query(
            `SELECT id, embedding FROM ${SCHEMA}.fragments
             WHERE  embedding IS NOT NULL
             ORDER  BY id
             LIMIT  $1 OFFSET $2`,
            [BATCH, offset]
        );

        if (rows.length === 0) break;

        for (const row of rows) {
            /** pg 드라이버는 vector 컬럼을 '[0.1,0.2,...]' 또는 '{0.1,0.2,...}' 문자열로 반환 */
            let vec;
            if (typeof row.embedding === "string") {
                const cleaned = row.embedding.startsWith("{")
                    ? `[${row.embedding.slice(1, -1)}]`
                    : row.embedding;
                vec = JSON.parse(cleaned);
            } else {
                vec = row.embedding;
            }
            const normalized = normalizeL2(vec);
            await pool.query(
                `UPDATE ${SCHEMA}.fragments SET embedding = $1::vector WHERE id = $2`,
                [`[${normalized.join(",")}]`, row.id]
            );
            updated++;
        }

        console.log(`  처리: ${updated}개`);
        offset += BATCH;
    }

    console.log(`완료: 총 ${updated}개 벡터 정규화됨`);
}

run()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => pool.end());
