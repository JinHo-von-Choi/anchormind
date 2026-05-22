/**
 * 형태소 토크나이저 지연·메모리 벤치마크
 *
 * 작성자: 최진호
 * 작성일: 2026-05-22
 */

import { MorphemeIndex } from "../lib/memory/embedding/MorphemeIndex.js";

const idx     = new MorphemeIndex();
const samples = [
  "memento-mcp 서버의 L3 형태소 분석기를 마이그레이션하여 OpenAI 임베딩 비용을 절감했다",
  "embedding workers caching morphemes efficiently",
];

// 워밍업
for (let i = 0; i < 20; i++) await idx.tokenize(samples[i % 2]);

const rss0 = process.memoryUsage().rss;
const t0   = performance.now();
for (let i = 0; i < 500; i++) await idx.tokenize(samples[i % 2]);
const ms = (performance.now() - t0) / 500;

console.log(`평균 ${ms.toFixed(3)} ms/call, RSS +${((process.memoryUsage().rss - rss0) / 1_048_576).toFixed(1)} MB`);
console.log(await idx.tokenize(samples[0]));
