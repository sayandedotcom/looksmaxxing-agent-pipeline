import { generateText, Output } from 'ai';
import { z } from 'zod';
import { BLOCKING, MODELS, model, type Brief, type Review } from '../schemas.ts';

// Step 4: standards editor on a separate model. It used to return "the issues it noticed",
// which in practice meant the ~2 worst per pass, so the revise loop never converged (F6).
// Now code splits the draft into numbered sentences and the editor must rule on every one.
// Excerpts come from code, and citation placement is checked in code from the editor's
// sentence -> claim mapping.
// Rulings stick across rounds: unchanged sentences keep their ruling and only new or edited
// sentences go back to the model. Re-reviewing everything made borderline sentences flip (F7).

const KINDS = ['unsupported_claim', 'overstated', 'bad_citation', 'harm', 'tone', 'other'] as const;

const Rulings = z.object({
  rulings: z.array(
    z.object({
      n: z.number().describe('sentence number'),
      basis: z.string().describe('the claim id it rests on (e.g. "c3"), or "advice", or "not_factual"'),
      ok: z.boolean(),
      kind: z.enum(KINDS).nullable().describe('null when ok'),
      fix: z.string().nullable().describe('null when ok'),
    }),
  ),
});
type Ruling = z.infer<typeof Rulings>['rulings'][number];

export function sentences(draft: string): string[] {
  const out: string[] = [];
  for (const block of draft.split(/\n\s*\n/)) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^(#|[-*] |\d+\. )/.test(t)) out.push(t);
      else out.push(...t.split(/(?<=[.!?]["”')]*|\[PMID:\s*\d+\])\s+(?=[A-Z"“(*])/));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const SYSTEM = `You are the standards editor at looksmaxxing.guide. You protect two things: the reader's health
and the site's credibility. You are not a style editor; ignore prose you merely dislike.

You get the draft as numbered sentences. Return exactly one ruling per sentence, for every number.
For each sentence, decide its basis: the claim id whose statement covers it, "advice" if it's practical
guidance drawn from the advice list, or "not_factual" (headings, transitions, rhetorical lines). Then flag:
- unsupported_claim: a factual statement no claim covers. The advice list is not evidence: specific
  medical or factual detail (risks, rates, biology, "better track record") that appears only in advice,
  or nowhere in the brief, is unsupported.
- overstated: stronger than its claim. Certainty where the claim is mixed, causation from association,
  or a study population silently generalized (kids -> adults, clinical -> DIY).
- bad_citation: the citation doesn't fit the sentence.
- harm: could lead a reader to injure himself (bone smashing, DIY fillers/injections, unprescribed
  SARMs/finasteride/steroids, crash dieting) without a clear warning, or language that feeds body dysmorphia.
- tone: blackpill / incel framing, or moralizing at the reader.
Mark ok=true when a sentence is fine. Don't invent issues to look thorough.`;

export async function review(draft: string, brief: Brief, prior?: Review['ledger']): Promise<Review> {
  const list = sentences(draft);
  const numbered = list.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const prompt = `RESEARCH BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nDRAFT (${list.length} sentences):\n${numbered}`;

  const rulings = new Map<number, Ruling>();
  list.forEach((s, i) => {
    const p = prior?.[s];
    if (p) rulings.set(i + 1, { n: i + 1, ...(p as Omit<Ruling, 'n'>) });
  });
  const carried = rulings.size;

  // Coverage is enforced: anything not yet ruled on is asked about, with one retry for skips.
  for (let attempt = 0; attempt < 2 && rulings.size < list.length; attempt++) {
    const todo = list.map((_, i) => i + 1).filter((n) => !rulings.has(n));
    const { output } = await generateText({
      model: model(MODELS.editor),
      output: Output.object({ schema: Rulings }),
      system: SYSTEM,
      prompt:
        todo.length === list.length
          ? prompt
          : `${prompt}\n\nThe other sentences were already reviewed. Rule only on these: ${todo.join(', ')}`,
    });
    for (const r of output.rulings) if (todo.includes(r.n) && !rulings.has(r.n)) rulings.set(r.n, r);
  }

  const allowed = new Set(brief.claims.flatMap((c) => c.evidence.map((e) => e.pmid)));
  const issues: Review['issues'] = [];
  list.forEach((sentence, i) => {
    const r = rulings.get(i + 1);
    if (!r) {
      issues.push({ kind: 'other', excerpt: sentence, fix: 'Editor never reviewed this sentence.' });
      return;
    }
    if (!r.ok) issues.push({ kind: r.kind ?? 'other', excerpt: sentence, fix: r.fix ?? '' });

    // Deterministic citation placement, from the editor's own sentence -> claim mapping.
    const claim = brief.claims.find((c) => c.id === r.basis);
    for (const [, pmid] of sentence.matchAll(/\[PMID:\s*(\d+)\]/g)) {
      const problem = !allowed.has(pmid)
        ? `PMID ${pmid} is not in the verified brief.`
        : claim && !claim.evidence.some((e) => e.pmid === pmid)
          ? `This sentence rests on ${claim.id}, but PMID ${pmid} is evidence for a different claim.`
          : !claim
            ? `This sentence is ${r.basis}, so it shouldn't carry a citation.`
            : null;
      if (problem && !issues.some((x) => x.excerpt === sentence && x.kind === 'bad_citation'))
        issues.push({ kind: 'bad_citation', excerpt: sentence, fix: `${problem} Remove or move the citation.` });
    }
  });

  const tally: Record<string, number> = {};
  for (const r of rulings.values()) {
    const key = /^c\d+$/.test(r.basis) ? 'claim' : r.basis;
    tally[key] = (tally[key] ?? 0) + 1;
  }

  // The model doesn't get to call it a pass while a blocking issue stands (F4).
  return {
    issues,
    verdict: issues.some((i) => BLOCKING.has(i.kind)) ? 'revise' : 'pass',
    coverage: { sentences: list.length, ruled: rulings.size, carried, byBasis: tally },
    ledger: Object.fromEntries(
      list.flatMap((s, i) => {
        const r = rulings.get(i + 1);
        return r ? [[s, { basis: r.basis, ok: r.ok, kind: r.kind, fix: r.fix }]] : [];
      }),
    ),
  };
}
