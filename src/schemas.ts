import type { LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// Model ids are "provider/model". With ANTHROPIC_API_KEY set, anthropic/* goes direct to
// Anthropic; anything else goes through Vercel AI Gateway.
// Ideally the critics run on a different model family from the writer, so the step that
// checks the work isn't the same model grading itself. With only an Anthropic key, the
// next best thing is a different, stronger model (Opus) as judge and editor.
export const MODELS = {
  researcher: process.env.RESEARCH_MODEL ?? 'anthropic/claude-sonnet-5-5',
  writer: process.env.WRITER_MODEL ?? 'anthropic/claude-sonnet-5-5',
  judge: process.env.JUDGE_MODEL ?? 'anthropic/claude-opus-5-5',
  editor: process.env.EDITOR_MODEL ?? 'anthropic/claude-opus-5-5',
};

export function model(id: string): LanguageModel {
  const [provider, name] = id.split('/');
  if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) return anthropic(name);
  return id;
}

export const Evidence = z.object({
  pmid: z.string().describe('PubMed ID returned by a tool call. Never invent one.'),
  quote: z.string().describe('Exact sentence copied verbatim from that abstract'),
});

export const Claim = z.object({
  id: z.string().describe('short id like c1, c2'),
  statement: z.string(),
  // "tested, no effect" and "never tested" used to share one stance, and the verifier
  // dropped a real null-result RCT because of it (F8).
  stance: z
    .enum(['supported', 'tested_no_effect', 'mixed', 'untested', 'harmful'])
    .describe('tested_no_effect = studies looked and found nothing (cite them); untested = no study found (use searches)'),
  evidence: z.array(Evidence).describe('Required unless stance is untested'),
  searches: z
    .array(z.string())
    .describe('For untested claims: the exact searchPubMed queries you ran that found nothing relevant'),
});

export const Brief = z.object({
  topic: z.string(),
  readerQuestion: z.string().describe('The question a guy actually types into Google / Reddit'),
  claims: z.array(Claim).min(3).max(10),
  advice: z
    .array(z.string())
    .describe(
      'Practical next steps: who to see, what not to do. No factual or medical claims here (rates, risks, ' +
        'biology); anything factual must be a claim with evidence, because advice is not fact-checked.',
    ),
});

export type Brief = z.infer<typeof Brief>;
export type Claim = z.infer<typeof Claim>;

export const Entailment = z.object({
  verdict: z.enum(['backs', 'partial', 'does_not_back']),
  reason: z.string(),
  narrowed: z.string().describe('The claim rewritten to say only what the sources support. Repeat it unchanged if "backs".'),
});

export const Review = z.object({
  issues: z.array(
    z.object({
      kind: z.enum(['unsupported_claim', 'overstated', 'bad_citation', 'harm', 'tone', 'other']),
      excerpt: z.string().describe('Exact text from the draft'),
      fix: z.string(),
    }),
  ),
});
export type Review = z.infer<typeof Review> & {
  verdict: 'pass' | 'revise';
  coverage?: { sentences: number; ruled: number; carried: number; byBasis: Record<string, number> };
  // Rulings by exact sentence text, carried into the next round (F7).
  ledger?: Record<string, { basis: string; ok: boolean; kind: string | null; fix: string | null }>;
};
// Everything except tone/other blocks publishing. Decided in code, not by the model (see F4).
export const BLOCKING = new Set(['unsupported_claim', 'overstated', 'bad_citation', 'harm']);
