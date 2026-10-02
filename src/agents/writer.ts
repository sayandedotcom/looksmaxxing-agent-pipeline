import { generateText } from 'ai';
import { MODELS, model, type Brief, type Review } from '../schemas.ts';

const VOICE = `You write for looksmaxxing.guide. Readers are men 18-35 who already know the slang and have read
the Reddit threads. Write like an older brother who reads the studies: direct, a little dry, zero
moralizing, never condescending. Use their vocabulary (mewing, jawline, hunter eyes) but don't adopt
blackpill framing ("it's over", "subhuman", ratings out of 10). Give them something practical to do.`;

export async function write(brief: Brief, previous?: { draft: string; review: Review }) {

  const task = previous
    ? `Revise your draft. Fix every issue the editor raised; change nothing else.

EDITOR ISSUES:
${previous.review.issues.map((i, n) => `${n + 1}. [${i.kind}] "${i.excerpt}" -> ${i.fix}`).join('\n')}

YOUR PREVIOUS DRAFT:
${previous.draft}`
    : `Write an article of 700-1000 words in Markdown, starting with a "# " title.`;

  const { text } = await generateText({
    model: model(MODELS.writer),
    system: VOICE,
    prompt: `${task}

VERIFIED CLAIMS (the only factual statements you may make; already narrowed by the fact-checker,
so don't widen them back):
${JSON.stringify(brief.claims, null, 2)}

ADVICE (practical guidance, not fact-checked; use it as advice, and don't add medical or factual
detail to it):
${brief.advice.map((a) => `- ${a}`).join('\n')}

Cite with [PMID:12345678] right after the sentence it supports, using only PMIDs from that claim's evidence.
Claims with "searches" and no evidence are absence-of-evidence findings: say plainly that we searched PubMed
(name the search terms) and found no study testing it. Give no citation for them.
Output only the article Markdown.`,
  });
  return text.trim();
}
