# looksmaxxing.guide: evidence-checked article pipeline

A five-step agent pipeline that turns a topic ("does mewing actually change your jawline") into a
published article where every factual sentence traces back to a PubMed abstract. Drafts that the
editor never passes are held for a human instead of published.

**Live site with articles and full run traces:** see the Vercel link in the repo description.

```
topic
  │
  ▼
1. research ── ToolLoopAgent (Claude Sonnet 5.5) + tools: searchPubMed, getAbstract (NCBI E-utilities)
  │            → Brief { claims[ {statement, stance, evidence[{pmid, exact quote}], searches[]} ], advice[] }
  ▼
2. verify ──── code:  PMID exists? quote is literally in that abstract? search receipts in the real search log?
  │            judge (Claude Opus 5.5): do the surviving sources back the claim? → narrowed claim replaces original
  │            → verified Brief (unbacked claims cut, partial ones narrowed)
  ▼
3. write ───── Claude Sonnet 5.5, may only state verified claims; cites [PMID:x]
  │      ▲
  ▼      │ issues (exact sentences + fixes), max 3 rounds
4. editor ──── code splits draft into numbered sentences; Opus must rule on every one
  │            (basis: claim id | advice | not_factual); citation placement checked in code;
  │            verdict computed in code; rulings stick across rounds
  ▼
5. publish ─── static HTML: article with PubMed footnotes + public trace page. Held runs get a trace only.
```

## Where it broke

The real failure notes, written as each thing broke, are in [`notes/failure-log.md`](notes/failure-log.md).
Short version:

| # | Symptom | Cause | Fix |
|---|---------|-------|-----|
| F1 | Fake PMIDs "existed" | `includes('<PubmedArticle')` matched the `<PubmedArticleSet>` wrapper | regex + minimum quote length |
| F2 | Unsourced medical facts in a green run | `safetyNotes` field skipped verification but went to the writer as "verified" | `advice` can't hold facts; editor treats advice as non-evidence |
| F3 | "No trial exists" cited an unrelated paper | absence claims can't be quote-checked | absence claims carry search receipts, checked against the real tool log |
| F4 | Editor said "pass" while listing an issue | trusted the model's verdict field | verdict computed in code from issue kinds |
| F5 | "Partial" support kept the whole claim | partial meant "keep + note" | judge writes a narrowed claim that replaces the original |
| F6 | Revise loop never converged | editor reported ~2 issues/pass; all 5 were in draft 0 | per-sentence rulings with enforced coverage |
| F7 | Still didn't converge | editor flipped on unchanged sentences between rounds | rulings stick by sentence text; only edited text is re-reviewed |

Archived traces of the broken runs (v1, v3) are on the live site next to the fixed ones.

## Run it

```bash
pnpm install
echo 'ANTHROPIC_API_KEY=...' > .env.local    # or AI_GATEWAY_API_KEY to route via Vercel AI Gateway
pnpm pipeline "does mewing actually change your jawline"
pnpm rebuild                                  # re-render site/ from runs/*.json
```

Models are set in `src/schemas.ts` (override with `RESEARCH_MODEL`, `WRITER_MODEL`, `JUDGE_MODEL`, `EDITOR_MODEL`).
Ideally the judge and editor run on a different model family than the writer; with only an Anthropic key,
they use a separate, stronger model (Opus) instead.

```
src/pipeline.ts         orchestrator, trace capture, revise loop
src/agents/researcher   step 1  (ToolLoopAgent + PubMed tools)
src/steps/verify        step 2  (code checks + judge)
src/agents/writer       step 3
src/agents/editor       step 4  (sentence-level review)
src/steps/publish       step 5  (static site + traces)
runs/*.json             full trace of every run
```
