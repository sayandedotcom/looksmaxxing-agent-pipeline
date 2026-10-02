# looksmaxxing.guide: evidence-checked article pipeline

A five-step agent pipeline that turns a topic ("does mewing actually change your jawline") into a
published article where every factual sentence traces back to a PubMed abstract. Drafts that the
editor never passes are held for a human instead of published.

**Live site with articles and full run traces:** https://looksmaxxing-pipeline-five.vercel.app

---

## 1. Ship a multi-step agentic workflow for looksmaxxing.guide

### What I built (one sentence)
A pipeline that turns a looksmaxxing topic into a published article where every factual sentence traces back to a real PubMed abstract. Drafts that don't pass review are held for a human instead of published.

### The workflow: steps, tools, handoffs
1. **Research.** *Trigger:* I run it with a topic, e.g. `pnpm pipeline "does mewing change your jawline"`. *Tool:* an AI SDK `ToolLoopAgent` on Claude Sonnet calls `searchPubMed` and `getAbstract` (NCBI E-utilities). *Output:* a typed brief. It contains claims, each with a stance, a PMID and an exact quote from the abstract, plus practical advice. *Handoff:* the brief goes to step 2.
2. **Verify.** This step treats the brief as untrusted.
   - Code checks that each PMID exists and that the quote is really in that abstract. For "no study shows X" claims, it checks that the searches were actually run, against the agent's tool-call log.
   - Claude Opus judges whether the sources back each claim, and rewrites partly backed claims down to what's backed. Unbacked claims are cut.
   - *Handoff:* the verified brief goes to step 3.
3. **Write.** Sonnet drafts the article from verified claims only, citing `[PMID:x]`. *Handoff:* the draft goes to step 4.
4. **Editor review.**
   - Code splits the draft into numbered sentences. Opus must rule on every one: which claim it rests on, or advice, or not factual, and whether it's unsupported, overstated, badly cited, harmful or off-tone.
   - Code checks citation placement and decides pass or revise.
   - *Handoff:* flagged sentences and fixes go back to step 3, up to 3 rounds.
5. **Publish.** Builds a static page with PubMed footnotes and a public trace page showing every step's input and output. If the draft never passed, the run is held and gets only a trace page.

### Link
- Live: https://looksmaxxing-pipeline-five.vercel.app
- Code: https://github.com/sayandedotcom/looksmaxxing-agent-pipeline

### Where the pipeline broke and exactly what I changed to fix it
- **A green run was still wrong (F2).** Run 1 passed every check, but the article said bone smashing "risks fractures, nerve damage… infection", which no cited abstract says. The cause was a `safetyNotes` field I'd added: it skipped verification but went to the writer labeled "verified research". I replaced it with an `advice` field that can't hold facts, and the editor now treats advice as non-evidence.
- **The "no trial exists" claim cited an unrelated paper (F3).** You can't quote-check a lack of evidence. Absence claims now carry search receipts, checked against the agent's real tool-call log.
- **The editor said "pass" while listing an issue, and that sentence shipped (F4).** Code now decides the verdict from issue types instead of trusting the model's verdict field.
- **The revise loop never converged (F6 → F7).** The editor reported only about 2 issues per pass, then flipped on unchanged sentences between rounds. I switched to sentence-level rulings with enforced coverage, and rulings now stick by sentence text. See section 2.
- **My absence-claim fix created a new bug (F8).** One stance meant both "tested, no effect" and "never tested", so the verifier dropped a real 6-month null-result trial. I split it into `tested_no_effect` and `untested`.
- **Deliberately not fixed:** research depth varies from run to run (7 claims vs 3). Forcing a minimum claim count would bring back F3's padded citations.

The broken runs (v1, v3) are archived on the live site next to the fixed ones. The full log is in [`notes/failure-log.md`](notes/failure-log.md).

---

## 2. Failure autopsy: the most complex agent failure I've debugged

### What I was building and what failed
A five-step pipeline for looksmaxxing.guide: a PubMed research agent, citation verification, a writer, an editor, and publish. The writer ⇄ editor revise loop never converged. Every topic hit the 3-round cap and was held, even though each round reported only 1–2 small, fixable issues.

### My diagnostic process: how I isolated the root cause
It looked like the writer adding new errors on each revision. Before touching prompts, I diffed the drafts.

- **First finding:** the writer had left 51 of 54 sentences untouched, and all 5 flagged sentences were already in draft 0. So the editor was drip-feeding issues, about 2 per pass.
- **First fix and result:** I made the editor rule on every numbered sentence. The run was still held.
- **Second finding:** comparing rulings across rounds showed the editor flagging sentences, word for word unchanged, that it had passed in earlier rounds.

That's two separate root causes: incomplete coverage, then an inconsistent judge.

### What I changed and whether the fix held
- Code splits the draft into sentences and rejects any review that skips one.
- Rulings stick by sentence text, so only edited sentences are re-reviewed.
- The verdict is computed in code, not taken from the model.

**It held.** The next runs converged at 4 → 1 → 0 and 2 → 0 issues, and later rounds re-checked only 1–4 sentences. The archived run 3 trace on the live site shows the before state.

---

## How it works

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
