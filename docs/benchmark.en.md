# Benchmark Report

Based on [LongMemEval-S](https://arxiv.org/abs/2407.15460) benchmark. Full evaluation code: [longmemeval-memento](https://github.com/JinHo-von-Choi/longmemeval-memento)

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

AnchorMind's pgvector semantic search achieves 88.3% recall_any@5 across all question types. This is competitive with dense retrievers reported in the LongMemEval paper (Stella 1.5B: ~0.7-0.8 range at similar K values). The fragment-based atomic storage with OpenAI embeddings provides strong semantic matching.

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
