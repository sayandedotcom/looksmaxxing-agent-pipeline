import { ToolLoopAgent, Output, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { searchPubMed, getAbstract } from '../pubmed.ts';
import { Brief, MODELS, model } from '../schemas.ts';

// Every search the agent actually ran, with what came back. Step 2 checks
// "we searched and found nothing" claims against this log (see F3).
export const searchLog: { query: string; results: { pmid: string; title: string }[] }[] = [];

export const researcher = new ToolLoopAgent({
  model: model(MODELS.researcher),
  stopWhen: isStepCount(24),
  instructions: `You research topics for looksmaxxing.guide, a site for men 18-35 trying to look better.
The audience gets most of its info from Reddit and TikTok, where folk claims ("mewing rebuilds your jaw",
"bone smashing", "SARMs for a leaner face") spread without evidence. Your job is to find out what the
peer-reviewed literature actually says.

Process:
1. Run several searchPubMed queries (clinical terms work better than slang: "orofacial myofunctional therapy"
   not "mewing").
2. Call getAbstract on every paper you intend to cite and read it.
3. Produce 4-8 claims. Each claim must cite evidence with an exact sentence copied from an abstract you fetched.
   Keep each claim to one finding. Don't add background knowledge to a claim that its quote doesn't cover.
4. If a study tested something and found no effect, that's stance "tested_no_effect" with the study as evidence.
   If no study has tested it at all, make an "untested" claim with an empty evidence list and
   put the exact queries you ran in "searches". Don't cite an unrelated paper to fill the evidence slot.
5. Write claims about the literature, not about your process ("I searched..." belongs in "searches").

Rules:
- Only cite PMIDs returned by your tools, and only quote text that appears in an abstract you fetched.
- If evidence is thin, say so with stance "mixed", "tested_no_effect" or "untested". Don't stretch a study on adolescents in
  orthodontic treatment into a claim about adults doing something at home.
- Use stance "harmful" for practices with documented injury risk.`,
  tools: {
    searchPubMed: tool({
      description: 'Search PubMed. Returns PMID, title, year, journal, publication types.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const results = await searchPubMed(query);
        searchLog.push({ query, results: results.map((r) => ({ pmid: r.pmid, title: r.title })) });
        return results;
      },
    }),
    getAbstract: tool({
      description: 'Fetch the full abstract text for a PMID.',
      inputSchema: z.object({ pmid: z.string() }),
      execute: async ({ pmid }) => (await getAbstract(pmid)) ?? { error: `No PubMed record for ${pmid}` },
    }),
  },
  output: Output.object({ schema: Brief }),
});
