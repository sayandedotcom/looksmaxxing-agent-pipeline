import { generateText, Output } from 'ai';
import { getAbstract } from '../pubmed.ts';
import { searchLog } from '../agents/researcher.ts';
import { Entailment, MODELS, model, type Brief, type Claim } from '../schemas.ts';

// Step 2: don't trust the researcher.
//   a) in code: does each PMID exist, and is the quote actually in that abstract?
//      For "no study shows X" claims: were those searches actually run?
//   b) one judge call per claim, on a separate model, sees every surviving source and
//      returns a narrowed claim. The narrowed text replaces the original (see F5).
// Claims left with no evidence and no search receipts are cut.

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export type EvidenceCheck = {
  claimId: string;
  pmid: string;
  exists: boolean;
  quoteFound: boolean;
};

export type ClaimCheck = {
  claimId: string;
  original: string;
  evidence: EvidenceCheck[];
  searches: { query: string; ran: boolean; titles: string[] }[];
  entailment?: { verdict: string; reason: string; narrowed: string };
  kept: boolean;
};

export async function verifyBrief(brief: Brief) {
  const checks: ClaimCheck[] = [];
  const claims: Claim[] = [];

  for (const claim of brief.claims) {
    const check: ClaimCheck = { claimId: claim.id, original: claim.statement, evidence: [], searches: [], kept: false };
    const sources: string[] = [];
    const keptEvidence: Claim['evidence'] = [];

    for (const ev of claim.evidence) {
      const paper = await getAbstract(ev.pmid);
      const quoteFound = !!paper && norm(ev.quote).length >= 20 && norm(paper.abstract).includes(norm(ev.quote));
      check.evidence.push({ claimId: claim.id, pmid: ev.pmid, exists: !!paper, quoteFound });
      if (paper && quoteFound) {
        keptEvidence.push(ev);
        sources.push(`ABSTRACT (PMID ${paper.pmid}, "${paper.title}"):\n${paper.abstract}`);
      }
    }

    // Only absence claims may lean on search receipts, and only for searches that really ran.
    const receipts = claim.stance === 'untested' ? claim.searches : [];
    for (const q of receipts) {
      const hit = searchLog.find((s) => norm(s.query) === norm(q));
      check.searches.push({ query: q, ran: !!hit, titles: hit?.results.map((r) => r.title) ?? [] });
      if (hit)
        sources.push(
          `PUBMED SEARCH "${hit.query}" returned:\n${hit.results.map((r) => `- ${r.title}`).join('\n') || '(nothing)'}`,
        );
    }

    if (sources.length) {
      const { output } = await generateText({
        model: model(MODELS.judge),
        output: Output.object({ schema: Entailment }),
        prompt: `Claim: "${claim.statement}"
Stance: ${claim.stance}

${sources.join('\n\n')}

Do these sources back the claim at that stance? Be strict about population (children vs adults,
clinical treatment vs DIY), outcome measured, and effect size. Background knowledge that no source states
does not count. For an untested claim, the search results back it only if none of the listed titles
looks like a study that tests the claim.
"partial" means the sources back a narrower version; put that version in "narrowed", keeping the
writer's plain wording and cutting every part no source states.`,
      });
      check.entailment = output;
      check.kept = output.verdict !== 'does_not_back';
    }
    checks.push(check);
    if (check.kept) {
      claims.push({
        ...claim,
        statement: check.entailment!.narrowed,
        evidence: keptEvidence,
        searches: check.searches.filter((s) => s.ran).map((s) => s.query),
      });
    }
  }

  return { brief: { ...brief, claims }, checks };
}
