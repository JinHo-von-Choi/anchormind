# Benchmark Report

Results of AnchorMind on four public long-term memory benchmarks: LongMemEval-S, LoCoMo, MemBench and BEAM. The LongMemEval evaluation code is in [longmemeval-memento](https://github.com/JinHo-von-Choi/longmemeval-memento).

> **Every run was measured under conditions unfavorable to AnchorMind.** The conversations were cut into turns or turn pairs and stored verbatim: the chunk ingest of a plain RAG system. AnchorMind normally splits a conversation into atomic fragments of one or two facts, tags them with a type (fact, decision, preference, procedure) and keywords, updates changing values through slots, and links related fragments and sessions. None of that preprocessing was applied, so retrieval worked on rougher material than memory tools that extract facts with an LLM at write time.

## Summary

| Benchmark | Size | Result |
|-|-|-|
| LongMemEval-S | 500 questions | accuracy 0.840 (official GPT-4o judge) |
| LoCoMo | 10 conversations, 1,986 questions | accuracy 0.863, official F1 0.633 (k=50) |
| MemBench | 469 questions | accuracy 0.859 |
| BEAM 1M | 35 conversations, 700 questions | 0.418 (best in the BEAM paper: 0.336) |
| BEAM 100K | 20 conversations, 400 questions | 0.50 (MiniMax judge) |

## LongMemEval-S

| Item | Value |
|-|-|
| Dataset | LongMemEval_S, 500 questions (6 types and abstention) |
| Ingest | each turn pair verbatim, cut at 300 characters, as one fragment; about 620 fragments per question |
| Embedding | bge-m3 (1024 dimensions) |
| Retrieval | recall API, top 10, segment search on, `MEMENTO_RANK_BEFORE_BUDGET=off` |
| Answering model | deepseek-flash |
| Judges | GPT-4o (official setting), MiniMax-M3.1-Flash-Preview, Claude Sonnet 5.5, all with the official prompts |

Accuracy is counted over all 500 questions.

| Metric | Value |
|-|-|
| Accuracy (GPT-4o, official) | 0.840 (95% interval 0.805-0.870) |
| Accuracy (MiniMax) | 0.840 |
| Accuracy (Claude) | 0.780 |
| Task-averaged accuracy (GPT-4o) | 0.868 |
| An answer session in the top 5 (recall_any@5) | 0.984 |
| All evidence turns in the top 10 | 0.912 |
| Recall latency (median / p95) | 0.5 s / 1.1 s |

The official judge and MiniMax give the same verdict on 492 of 500 questions (kappa 0.940).

| Question type | Questions | All evidence in top 10 | Accuracy (GPT-4o) |
|-|-|-|-|
| single-session-assistant | 56 | 1.000 | 1.000 |
| single-session-user | 70 | 0.886 | 0.971 |
| knowledge-update | 78 | 0.885 | 0.885 |
| single-session-preference | 30 | 0.733 | 0.833 |
| temporal-reasoning | 133 | 0.940 | 0.812 |
| multi-session | 133 | 0.917 | 0.707 |

### Segment search

Segment search embeds each part of a long fragment separately, so an evidence sentence buried in a long body is still found. The same 499 questions were run with it off and on.

| Metric | Off | On |
|-|-|-|
| Accuracy (GPT-4o) | 0.784 | 0.842 |
| All evidence in top 5 | 408 / 499 | 439 / 499 |
| Recall latency (median / p95) | 0.63 s / 2.7 s | 0.5 s / 1.1 s |

39 questions are answered correctly only with it on and 10 only with it off (sign test p = 3.8e-5).

## LoCoMo

10 conversations, 1,986 questions. Each dialogue turn is stored as one fragment and k fragments are retrieved for each question. The answering model is deepseek-flash.

| Fragments retrieved (k) | 10 | 20 | 50 |
|-|-|-|-|
| Accuracy (MiniMax judge) | 0.805 | 0.840 | 0.863 |
| Accuracy (Claude judge) | 0.782 | 0.825 | 0.840 |
| Official F1 | 0.605 | 0.630 | 0.633 |
| Share with the answer evidence retrieved | 0.639 | 0.719 | 0.773 |

Accuracy is over the 1,540 questions excluding adversarial. At k=50 the accuracy by category (MiniMax) is single-hop 0.891, temporal 0.882, multi-hop 0.826 and open-domain 0.667. Adversarial questions, which have no answer, score 0.881-0.928.

## MemBench

A benchmark of four-option questions answered from memory. Each step of the dialogue or observation log is stored as a fragment and 10 fragments are retrieved for each question. 469 questions, answering model deepseek-flash.

**Accuracy 0.859** (95% interval 0.825-0.888; chance is 0.25)

| Question kind | Questions | Accuracy |
|-|-|-|
| Single-session assistant | 30 | 1.00 |
| Single hop | 70 | 0.99 |
| Comparison | 50 | 0.94 |
| Multi hop | 69 | 0.87 |
| Aggregation | 50 | 0.60 |

## BEAM

A benchmark of ten memory abilities over long conversations. Each user turn and its reply are stored as one fragment, the same ingest format as the RAG baseline of the [BEAM paper](https://arxiv.org/abs/2510.27246).

### 1M

35 conversations of 1M tokens, 700 questions. The answering model is MiniMax-M3.1-Flash-Preview and the judge is Claude Sonnet 5.5. Each question is answered from the same retrieval with 10, 24 and 50 fragments.

| Ability | k=10 | k=24 | k=50 | Paper, best LIGHT |
|-|-|-|-|-|
| Preference following | 0.689 | 0.698 | 0.658 | 0.610 |
| Knowledge update | 0.639 | 0.604 | 0.636 | 0.414 |
| Information extraction | 0.535 | 0.599 | 0.604 | 0.474 |
| Instruction following | 0.496 | 0.537 | 0.586 | 0.433 |
| Multi-session reasoning | 0.364 | 0.411 | 0.416 | 0.278 |
| Summarization | 0.258 | 0.381 | 0.414 | 0.316 |
| Abstention | 0.271 | 0.314 | 0.243 | 0.735 |
| Temporal reasoning | 0.233 | 0.258 | 0.240 | 0.176 |
| Event ordering | 0.191 | 0.200 | 0.204 | 0.211 |
| Contradiction resolution | 0.150 | 0.180 | 0.161 | 0.042 |
| **Overall (mean of abilities)** | **0.383** | **0.418** | **0.416** | **0.336** |

"Paper, best LIGHT" is the highest value among the four answering models in the paper's 1M results. In the same table the best overall RAG baseline score is 0.307.

- Overall 0.418 (95% interval 0.389-0.448), above the paper's best 1M score (LIGHT 0.336) and 0.111 above the RAG baseline (0.307), which uses the same ingest format.
- Knowledge update 0.604 and contradiction resolution 0.180 are far above the paper's best (0.414, 0.042).
- Recall latency per question is p50 1.79 s and p95 2.35 s.

### 100K

20 conversations of 100K tokens, 400 questions. 24 fragments are retrieved for each question. The answering model is deepseek-flash.

| Judge | Overall score |
|-|-|
| MiniMax | 0.50 |
| Claude | 0.44 |

Preference following (0.71-0.80) and information extraction (0.71-0.74) score highest.

## Retrieval regression measurement

How to compare retrieval quality before and after a change with the repository goldset and evaluation set is described in the [testing guide](testing.md#검색-품질-측정) (Korean).
