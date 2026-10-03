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

Baselines are produced in isolated mode with `Xenova/bge-m3` (1024 dimensions) and `--repeat 3` on a freshly migrated database. `--save-baseline` records the embedding provider, model and dimensions, and `--baseline` warns when the model differs. When the baseline file has no `embedding` field, no warning is printed, so the absence of a warning does not mean the models match. A run that embedded 0 fragments is refused by `--save-baseline` and exits with code 1. A `--no-seed` run neither seeds nor embeds anything, so it cannot be saved as a baseline, and the refusal message says so. The regression tolerance is 2pp for Recall and MRR and 15% for p95 latency.

`scripts/baseline-recall.json` is the stored baseline. It is refreshed by running the procedure below with an embedding model and overwriting it with `--save-baseline`. The table below holds measurements taken on 2026-10-03 on a fresh isolated database with `Xenova/bge-m3`, the 100-entry goldset and `--repeat 3`; it is separate from the contents of the stored baseline file.

| Item (2026-10-03, isolated, bge-m3) | Value |
|-|-|
| Recall@1 / @5 / @10 | 81.0% / 90.0% / 93.0% |
| MRR | 0.8523 |
| Misses | 7 |
| p50 / p95 latency | 88ms / 102ms |

Baseline refresh procedure: the run migrates, seeds and deletes data, so `DATABASE_URL` and `POSTGRES_*` must point at a throwaway or staging database and never at production. The benchmark prints one stderr line with the target host, port and database name at start. Check that line before seeding.

```bash
export DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<throwaway_db>
export POSTGRES_HOST=<host> POSTGRES_PORT=<port> POSTGRES_DB=<throwaway_db> POSTGRES_USER=<user> POSTGRES_PASSWORD=<password>
export EMBEDDING_PROVIDER=transformers EMBEDDING_MODEL=Xenova/bge-m3 EMBEDDING_DIMENSIONS=1024
npm run migrate
node scripts/post-migrate-flexible-embedding-dims.js
EMBEDDING_ENABLED=true node bin/memento.js benchmark --repeat 3 --save-baseline scripts/baseline-recall.json
```

Seeding creates one `api_keys` row with id `benchmark-harness-key` and status `inactive`. This is expected. To remove it, first confirm that no fragments reference the key, then run:

```sql
DELETE FROM agent_memory.api_keys WHERE id = 'benchmark-harness-key' AND status = 'inactive';
```

Deleting the `api_keys` row sets `key_id` of the remaining fragments to NULL, which makes them master-scope. A row in `link_reconsolidations` that references the key makes the DELETE fail. A run with `--no-seed` has no embedded fragments, so the benchmark refuses `--save-baseline` together with `--no-seed`.

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

## Evaluation set v2 measurement (metric JSON)

`scripts/measure/recall-metrics.mjs` runs the queries in `tests/fixtures/recall-eval-v2` against a target database and prints metrics as JSON. Unlike the goldset measurement above, which seeds stored text to define the answers, the answers are ids of fragments that already exist in the target database with a relevance grade (1 related, 2 useful, 3 direct answer). It is run by hand and is not part of CI.

### What it measures

| Item | Content |
|-|-|
| Subsets | human-written Korean (`human_ko`, target 150 or more), exact identifier, time holdout, blind paraphrase, hard negative, synthetic (auxiliary, left out of the overall figures and reported separately) |
| Stratification | tags for spacing, particle variants, English identifier, Korean-English mixture, and per-domain figures (research, coding, ops, schedule) |
| Metrics | R@1/5/10, MRR, nDCG within the token budget, share of queries where a distractor outranks the answer (hard negative). R@k is a hit rate: the share of queries with at least one relevant fragment in the top k. For queries with several answers, `recall_fraction_at_k` reports the mean of (relevant fragments in the top k) / (relevant fragments of the query) separately. The field name `recall_at_k` means hit rate and does not change |
| nDCG | gain 2^grade - 1, position discount 1/log2(2 + x) where x is the tokens used by earlier items divided by a 100-token unit, items past the budget earn nothing. With 100 tokens per item it equals the usual nDCG. The ideal order is greedy (gain descending, fewer tokens first on ties, packed into the budget) and is not always optimal. The reported value `ndcg_at_budget` is therefore capped at 1, and the value before the cap, `ndcg_uncapped_at_budget`, is printed next to it. The cap only lowers a value and keeps the direction of paired differences between two runs (a difference can shrink to zero). A repeated id counts once, at its first occurrence, for rank and nDCG alike. Fragment tokens come from one source, `countTokens` over the stored content, and a relevant fragment uses the same value in the returned list and in the ideal order |
| Latency | p50, p95 and max for three passes: cold, warm at concurrency 1, warm at concurrency 8. Cold is the first pass after process start and no cache is flushed |
| Embeddings | `--embeddings off` (default) disables the query embedding channel. `on` uses the provider from the environment |

The file format and the procedure for adding human-written queries are in `tests/fixtures/recall-eval-v2/README.md`. Real queries and labels go in `tests/fixtures/recall-eval-v2/private/`, which git ignores and the script also reads. Labels are not found with the retrieval system under test. The structure of the set is checked with `node --test tests/unit/recall-eval-set.test.js`.

### Running

```bash
node scripts/measure/recall-metrics.mjs --target localhost:35433/<restored_db> --out run-a.json
```

`--target` must be a database on a disposable test server (the test container on port 35433, or one place named with `DB_LANE_SERVER_ALLOW=<host:port>`). Any other target is refused with exit code 3 before a connection is opened. The connection settings come from `--target` alone, and Redis, caching and metrics collection are off. The production database is never contacted. Recall records access on the restored copy, so each run starts from a fresh restore.

In the output JSON, `metrics`, `rows`, `coverage` and `labels` hold the same values for the same database and the same set, while timestamps and latency sit under `volatile`. Sending only the query sentence leaves the lexical channel empty with embeddings off, so `--query-keywords whitespace` (default) also sends the query split on spaces as keywords. A `keywords` field in an entry takes precedence. Recall is called with `includeLinks=false` by default; with `--include-links on`, linked fragments join the result.

### Comparison rules

- Nothing is compared against fixed strings or fixed expected values. The script does not judge pass or fail.
- Two runs are compared with a paired bootstrap 95% interval over queries. For each group (overall, subset, tag, domain) and metric it reports the mean difference candidate - baseline and the interval. A difference counts only when the interval excludes zero.
- A group with fewer paired queries than `--min-n` (default 10) is marked `insufficient_n: true` and `excludes_zero` is not judged (false). Do not cite the interval of such a group as a finding.
- `--compare` reports a difference in `token_budget`, `query_keywords` or `include_links` between the two files in `warnings` of the output JSON and on standard error. Compare runs made under the same conditions.
- The random generator takes a seed, so the same input and seed give the same interval. Default seed 20261003, 2000 resamples.
- Identical values outside `volatile` across two runs on the same database confirm reproducibility and are not a quality criterion.

```bash
node scripts/measure/recall-metrics.mjs --compare run-a.json run-b.json --out compare.json
```

### Rank-before-budget comparison (`MEMENTO_RANK_BEFORE_BUDGET`)

Compares recall budget selection (`MEMENTO_RANK_BEFORE_BUDGET=on`) with the search-order cut (`off`) on the same set under the same conditions. The switch is read at call time, so it is set through the environment of each run, and the applied value is recorded in `params.rank_before_budget` of the metric JSON. When the budget does not bind, both paths return the same result, so keep `--token-budget` at or below the recall default 1000 and use the same value in both runs. To include the effect of selecting linked fragments within the budget, pass `--include-links on` to both runs. The real run needs a restored database and embeddings (`--embeddings on`) and is an owner step; the procedure below has not been measured yet.

```bash
# 1. Baseline run on fresh restore A (search-order cut)
MEMENTO_RANK_BEFORE_BUDGET=off node scripts/measure/recall-metrics.mjs \
  --target localhost:35433/<restore_a> --embeddings on --token-budget 1000 --include-links on --out budget-off.json

# 2. Candidate run on fresh restore B (rank before budget)
MEMENTO_RANK_BEFORE_BUDGET=on node scripts/measure/recall-metrics.mjs \
  --target localhost:35433/<restore_b> --embeddings on --token-budget 1000 --include-links on --out budget-on.json

# 3. Paired bootstrap comparison of the budgeted nDCG only
node scripts/measure/recall-metrics.mjs --compare budget-off.json budget-on.json --metric ndcg_at_budget --out budget-compare.json
```

- `--metric ndcg_at_budget` keeps only that metric in the comparison output. The interval values are the same as when all metrics are compared.
- Reading: the budgeted nDCG improved when the `comparisons` entry with `group` `overall` has `ci_low` above 0 and `insufficient_n` false. Subset, tag and domain groups are read with the same rule.
- When `warnings` lists a difference in `token_budget`, `query_keywords` or `include_links`, the runs were made under different conditions and are not compared.
- With migration 051 applied to the restored copy (`DATABASE_URL=postgresql://<user>:<password>@localhost:35433/<restore_b> npm run migrate`; set `DATABASE_URL` explicitly so that no connection value from another settings file is used), `search_events.candidate_count` and `budget_kept` of the candidate run show the share of recalls where the budget bound (`SELECT count(*) FILTER (WHERE budget_kept < candidate_count), count(*) FROM agent_memory.search_events WHERE candidate_count IS NOT NULL`). Without it, recall and the metrics are the same and search events are recorded without the two columns.
