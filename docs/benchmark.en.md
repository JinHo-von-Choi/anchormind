# Benchmark Report

Based on [LongMemEval-S](https://arxiv.org/abs/2410.10813) benchmark. Full evaluation code: [longmemeval-memento](https://github.com/JinHo-von-Choi/longmemeval-memento)

Date: 2026-03-29
Evaluator: Jinho Choi

## Configuration

| Parameter | Value |
|-----------|-------|
| Dataset | LongMemEval_S (500 questions, 6 types + abstention) |
| Ingestion | round_direct (turn-pair verbatim, 300 char truncation) |
| Storage | PostgreSQL bulk INSERT, pgvector embeddings via OpenAI text-embedding-3-small |
| Retrieval | memento-mcp recall API (3-layer cascade: L1 Redis, L2 PostgreSQL GIN, L3 pgvector HNSW) |
| Top-K | 5 |
| Reader | Gemini 2.5 Flash (direct method, no chain-of-thought) |
| Judge | Gemini 2.5 Flash (LongMemEval official prompts ported verbatim) |
| Total fragments | 89,006 (all with embeddings) |

## Retrieval Performance

| Metric | Score |
|--------|-------|
| recall_any@5 | 0.883 |
| recall_all@5 | 0.649 |

### Per-Type Retrieval (recall_any@5)

| Question Type | n | recall_any@5 |
|--------------|---|-------------|
| multi-session | 121 | 0.983 |
| knowledge-update | 72 | 0.972 |
| single-session-user | 64 | 0.953 |
| temporal-reasoning | 127 | 0.874 |
| single-session-preference | 30 | 0.800 |
| single-session-assistant | 56 | 0.536 |

### Search Path Distribution

| Layer | Hit Rate |
|-------|----------|
| L1 (Redis keyword) | 0.0% |
| L2 (PostgreSQL GIN) | 0.0% |
| L3 (pgvector semantic) | 99.0% |
| RRF fusion | 100.0% |

L1 and L2 show 0% because round_direct ingestion stores session IDs and dates as keywords, not content terms. The 3-layer cascade correctly falls through to L3 semantic search, which handles 99% of queries.

## QA Accuracy

| Metric | Score |
|--------|-------|
| Overall accuracy | 0.404 |
| Task-averaged accuracy | 0.434 |
| Abstention accuracy | 0.467 |

### Per-Type QA Accuracy

| Question Type | n | Accuracy | Retrieval | Gap |
|--------------|---|----------|-----------|-----|
| single-session-user | 64 | 0.797 | 0.953 | 0.156 |
| knowledge-update | 72 | 0.583 | 0.972 | 0.389 |
| single-session-preference | 30 | 0.467 | 0.800 | 0.333 |
| multi-session | 121 | 0.347 | 0.983 | 0.636 |
| temporal-reasoning | 127 | 0.252 | 0.874 | 0.622 |
| single-session-assistant | 56 | 0.161 | 0.536 | 0.375 |

Gap = retrieval recall - QA accuracy. Large gaps indicate the reader fails to extract the answer even when the correct session is retrieved.

## Analysis

### Retrieval Strengths

AnchorMind's pgvector semantic search recorded 88.3% recall_any@5 across all question types. The retrieval table in the LongMemEval paper (Table 3) uses LongMemEval_M with about 500 sessions per question (Stella V5 1.5B base design: session R@5 0.706, round R@5 0.582), so it is not directly comparable with this LongMemEval_S result. Retrieval here is served by fragment-level storage with OpenAI embeddings and pgvector.

Multi-session (98.3%) and knowledge-update (97.2%) retrieval is near-perfect, indicating that AnchorMind handles cross-session information distribution and temporal updates well at the retrieval level.

### Retrieval Weaknesses

single-session-assistant (53.6%) is the weakest retrieval category. The round_direct strategy stores "User: X / Assistant: Y" pairs, but queries about assistant utterances may not match well against this format since the query semantics differ from the stored format.

### QA Gap Analysis

The largest retrieval-to-QA gaps are in multi-session (63.6pp) and temporal-reasoning (62.2pp). These require synthesizing information across multiple retrieved fragments or reasoning about time -- capabilities that depend on the reader LLM rather than retrieval quality.

single-session-user has the smallest gap (15.6pp), confirming that when a direct factual answer exists in a single retrieved fragment, the reader successfully extracts it.

### Abstention

46.7% abstention accuracy is moderate. The system struggles to distinguish between "information not in history" and "information not retrieved" -- a fundamental challenge for retrieval-augmented systems.

## Ablation Study

Three reader conditions tested on the same retrieval results (round_direct, K=5, recall_any@5=0.883).

### Overall Results

| Condition | Overall | Task-Avg | Abstention | Delta (Overall) |
|-----------|---------|----------|------------|-----------------|
| Baseline (direct) | 0.404 | 0.434 | 0.467 | -- |
| + temporal metadata + abstention | 0.449 | 0.460 | 0.533 | +4.5pp |
| CoN v2 (conflict resolution + causal linking + restraint) | 0.406 | 0.416 | 0.267 | +0.2pp |

### Per-Type Breakdown

| Type | Baseline | Improved | CoN v2 | Best Delta |
|------|----------|----------|--------|------------|
| knowledge-update | 0.583 | 0.736 | 0.722 | +15.3pp |
| multi-session | 0.347 | 0.355 | 0.339 | +0.8pp |
| single-session-assistant | 0.161 | 0.161 | 0.143 | 0pp |
| single-session-preference | 0.467 | 0.333 | 0.267 | -13.4pp |
| single-session-user | 0.797 | 0.844 | 0.766 | +4.7pp |
| temporal-reasoning | 0.252 | 0.331 | 0.260 | +7.9pp |

### Ablation Analysis

The "Improved" condition (temporal metadata prefix + abstention detection) delivers the best overall gain at +4.5pp. The largest single improvement is knowledge-update (+15.3pp), where date prefixes allow the reader to identify the most recent answer when a user's information has been updated. Temporal-reasoning also benefits (+7.9pp) from explicit timestamps.

CoN v2 achieves similar knowledge-update gains (+13.9pp) but suffers on single-session-preference (-20pp) and abstention (26.7% vs 46.7%). The "do not guess" instruction in the CoN template suppresses answers that are valid but uncertain, and the multi-step reasoning format dilutes simple factual answers.

single-session-assistant remains unchanged across all conditions (16.1%), confirming the bottleneck is retrieval (53.6% recall), not reading strategy.

### K=10 Retrieval

| Metric | K=5 | K=10 | Delta |
|--------|-----|------|-------|
| recall_any | 0.883 | 0.885 | +0.2pp |
| recall_all | 0.649 | 0.687 | +3.8pp |
| ndcg | 0.775 | 0.785 | +1.0pp |

K=10 marginally improves recall_all (+3.8pp) but has minimal impact on recall_any. The pgvector HNSW index already surfaces the most relevant fragment within top-5 in most cases.

## Judge Calibration

48 stratified samples evaluated by both Gemini 2.5 Flash and GPT-4o.

| Type | Agreement |
|------|-----------|
| knowledge-update | 8/8 (100%) |
| multi-session | 8/8 (100%) |
| single-session-assistant | 8/8 (100%) |
| temporal-reasoning | 8/8 (100%) |
| single-session-user | 7/8 (87.5%) |
| single-session-preference | 5/8 (62.5%) |
| Overall | 44/48 (91.7%) |

Gemini and GPT-4o agree on 91.7% of judgments. The only substantial divergence is on single-session-preference (62.5%), where rubric-based evaluation allows subjective interpretation. All factual question types show near-perfect agreement.

### Limitations

1. Judge difference: Gemini 2.5 Flash instead of GPT-4o. Calibration shows 91.7% agreement, with preference questions as the main divergence point.
2. Single ingestion condition: Only round_direct tested. The atomic_fact condition may improve QA accuracy by distilling relevant facts.
3. 300-char truncation in round_direct loses information from longer turns.
4. L1/L2 search layers inactive due to bulk DB insertion bypassing Redis index construction.
5. Abstention detection limited by lack of confidence/similarity scores in retrieval response.

## Pipeline Execution Time

| Stage | Duration |
|-------|----------|
| Ingestion (DB bulk INSERT) | 27 seconds |
| Embedding backfill (89,006 fragments) | ~15 minutes |
| Retrieval (500 questions, MCP API) | 2 minutes |
| Generation (Gemini API, per condition) | ~27 minutes |
| Evaluation (Gemini API, per condition) | ~15 minutes |
| Total (3 conditions) | ~3 hours |

## Vector Search HNSW Index Enforcement (v4.6.0)

Since v4.6.0, each vector search transaction automatically applies `SET LOCAL enable_seqscan = off`, `SET LOCAL enable_bitmapscan = off`, and `SET LOCAL hnsw.iterative_scan = relaxed_order`. This blocks the PostgreSQL planner from switching to bitmap scan under `valid_to`/`agent_id` filter conditions, reducing latency from **308ms to 7ms** in affected query patterns. This optimization was added after the benchmark evaluation above, so the figures are not directly comparable; treat it as an operational recall-path latency reference.

## MorphemeTokenizer Microbenchmark (v4.3.0)

| Metric | Value |
|-|-|
| Average time per call | 1.06 ms/call |
| Measured on | v4.3.0 |
| Measurement date | 2026-05-22 |

Standalone measurement of the tokenization step in `lib/memory/embedding/MorphemeTokenizer.js`. Used by the morpheme registration path in RememberPostProcessor (matched by L3 semantic search).

## Files

- `results/retrieval_round_direct_k5_mcp.jsonl` -- retrieval results (K=5)
- `results/retrieval_round_direct_k10_mcp.jsonl` -- retrieval results (K=10)
- `results/evaluation_round_direct_k5_mcp.jsonl` -- baseline evaluation
- `results/evaluation_round_direct_k5_improved.jsonl` -- improved (temporal + abstention) evaluation
- `results/evaluation_round_direct_k5_conv2.jsonl` -- CoN v2 evaluation
- `results/judge_calibration.jsonl` -- Gemini vs GPT-4o calibration data

## Offline goldset measurement (2026-08-28)

Unlike LongMemEval-S, which requires an external dataset and a separate harness, this measurement ships with the repository so a change can be compared before and after immediately. Measurement conditions differ, so these numbers are not directly comparable to the LongMemEval figures above.

| Item | Value |
|------|-------|
| Goldset | `tests/fixtures/recall-goldset.jsonl`, 100 entries |
| Construction | (stored text, paraphrased query) pairs, so the expected answer is fixed by construction |
| Query classes | exact_symbol 25, concept_intent 35, hybrid 25, temporal 15 |
| Command | `node bin/memento.js benchmark --repeat 2` |

There are two measurement modes. `isolated` keeps only the seeded goldset fragments as candidates, so results are identical between runs. `corpus` competes against production fragments to show how recall behaves in a real haystack.

### Reproduction

The goldset and the baselines ship together in the repository, so the same numbers can be produced without external assets.

```
npm ci
cp .env.example .env       # fill in POSTGRES_* and MEMENTO_ACCESS_KEY
npm run migrate
node bin/memento.js benchmark --repeat 3
node bin/memento.js benchmark --key-scope corpus --repeat 3
```

| Asset | Path |
|-|-|
| Goldset, 100 entries | `tests/fixtures/recall-goldset.jsonl` |
| Baseline figures | `scripts/baseline-recall.json` |
| Measurement implementation | `lib/memory/signals/RecallBenchmark.js` |

To compare against the baseline, add `--baseline scripts/baseline-recall.json`. Regression decisions are made with this comparison.

Baselines are produced in isolated mode with `Xenova/bge-m3` (1024 dimensions) and `--repeat 3` on a freshly migrated database. `--save-baseline` records the embedding provider, model and dimensions, and `--baseline` warns when the model differs. The regression tolerance is 2pp for Recall and MRR and 15% for p95 latency. Isolated seeding first creates the `benchmark-harness-key` row in `api_keys` (inactive) when it is missing.

To refresh the baseline:

```bash
npm run migrate
EMBEDDING_PROVIDER=transformers EMBEDDING_MODEL=Xenova/bge-m3 EMBEDDING_DIMENSIONS=1024 EMBEDDING_ENABLED=true \
  node bin/memento.js benchmark --repeat 3 --save-baseline scripts/baseline-recall.json
```

| Item (2026-10-03, isolated, bge-m3) | Value |
|-|-|
| Recall@1 / @5 / @10 | 81.0% / 90.0% / 93.0% |
| MRR | 0.8523 |
| Misses | 7 |
| p50 / p95 latency | 88ms / 102ms |

`isolated` keeps only the seeded goldset fragments as candidates, so results are identical between runs. Use this mode for regression decisions. `corpus` fluctuates by about 3 points depending on when it runs, because production data keeps changing. When quoting an absolute figure, state the run time and the repeat count together.

### Intent profile, before and after

| Metric | Profile off | Profile on |
|--------|-------------|------------|
| Recall@1 (isolated) | 52.0% | 68.0% |
| Recall@5 (isolated) | 64.0% | 86.0% |
| MRR (isolated) | 0.5707 | 0.7603 |
| Misses (isolated) | 36 | 13 |
| p95 latency (isolated) | 299ms | 316ms |
| Recall@5 (corpus) | 50.0% | 76.0% |
| p95 latency (corpus) | 1001ms | 996ms |

### Recall@5 by query class (isolated, profile on)

| Class | Entries | Recall@5 |
|-------|---------|----------|
| exact_symbol | 25 | 72.0% |
| concept_intent | 35 | 80.0% |
| hybrid | 25 | 100.0% |
| temporal | 15 | 100.0% |

### Synthetic reverse-query augmentation, before and after

Reverse queries were generated for the first 30 goldset entries and the same queries were re-run. Eligibility was relaxed for measurement (importance 0.5 and up, all types), indexing 75 reverse queries across 30 fragments.

| Metric | Off | On |
|--------|-----|-----|
| Recall@1 | 70.0% | 76.7% |
| Recall@5 | 80.0% | 86.7% |
| MRR | 0.7317 | 0.7983 |
| Misses | 6 | 4 |
| p95 latency | 278.5ms | 311ms |

Every recovered item was an exact_symbol case where the stored text used English technical terms and the query was Korean, so the body vector never brought it into the candidate set.

Running the auxiliary probe sequentially after the body search pushed p95 from 278.5ms to 531ms while Recall@5 reached only 81.7%. Running it in parallel with an adoption cap cut the latency increase to 32ms and raised Recall@5 to 86.7%. Merging auxiliary candidates without a cap displaces exact body matches in result sets that were already good.

The accuracy gain actually came from ordering the auxiliary results. `id = ANY(...)` does not preserve input order, so with an adoption cap in place, taking the first few rows unsorted discards the very fragment scoring 1.0. Parallelisation and the ordering fix were applied together, and the initial write-up attributed the gain to the wrong one.

### Embedding similarity distribution

The default semantic threshold of 0.40 sat above the actual similarity distribution. With text-embedding-3-small, a paraphrase pair mixing a Korean query with an English technical term measured 0.2621 cosine, while the distribution against 5000 arbitrary fragments was p50 0.228 / p95 0.335. Correct fragments were filtered out below the threshold while unrelated fragments in the 0.39 to 0.43 range were returned instead. This measurement is the basis for the intent-based threshold adjustment.

### Embedding model replacement (2026-08-28)

The model was replaced from `text-embedding-3-small` (OpenAI API, 1536 dimensions) with `Xenova/bge-m3` (local transformers, 1024 dimensions), and 13,814 fragments, 28,247 morpheme dictionary entries, and 2,257 auxiliary vectors were re-embedded.

| Metric | Before | After |
|--------|--------|-------|
| Recall@1 (corpus) | 69.0% | 74.0% |
| Recall@5 (corpus) | 76.0% | 94.0% |
| MRR (corpus) | 0.7225 | 0.8249 |
| p95 latency (corpus) | 996ms | 667ms |
| Recall@5 (isolated) | 86.0% | 67.0% |

In corpus competition mode Recall@5 rose by 18pp, and latency dropped because the API round trip is gone. By query class: concept_intent 97.1%, hybrid 100%, temporal 93.3%, exact_symbol 84%.

Isolated mode moved the other way, which reflects a broken harness assumption rather than a quality drop. The final ranking is `importance 0.4 + recency 0.3 + similarity 0.3`, multiplying similarity as a raw 0 to 1 value, and the value bands of the two models differ.

| Model | Similarity range of correct pairs | Ranking contribution width |
|-------|-----------------------------------|----------------------------|
| text-embedding-3-small | 0.26 to 0.52 | 0.078 |
| Xenova/bge-m3 | 0.65 to 0.85 | 0.060 |

bge-m3 values cluster in a high band, which reduces discrimination in a linear weighted sum. In isolated mode the importance and storage time of all 100 candidates are identical, so only this weakness remains and the figure drops sharply. In corpus mode the vector layer pre-filters the top 30, so the effect is small.

The threshold is not the cause. Raising the semantic floor from 0.40 to 0.72 moved the result only from 66% to 67%.

Isolated-mode figures are therefore not compared across the point where the model was replaced. The baselines are also kept separately as `scripts/baseline-recall.json` (isolated) and `scripts/baseline-recall-corpus.json` (corpus).

The follow-up item is score normalization. Making similarity relative within the result set before applying the weights keeps discrimination independent of the model's value band.

### Reproducibility

Before key-scope isolation and the post-seed settle step, two consecutive runs of identical code produced 68% and 57% Recall@5. Competing against the production corpus means the corpus keeps changing, and asynchronous link creation right after seeding means the graph layer injects different neighbours at each evaluation. With both in place the spread across runs is zero.
