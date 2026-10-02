import { mkdir, writeFile } from 'node:fs/promises';
import { researcher } from './agents/researcher.ts';
import { verifyBrief } from './steps/verify.ts';
import { write } from './agents/writer.ts';
import { review } from './agents/editor.ts';
import { publish } from './steps/publish.ts';
import { MODELS, type Review } from './schemas.ts';

const MAX_ROUNDS = 3;

const topic = process.argv.slice(2).join(' ');
if (!topic) {
  console.error('usage: pnpm pipeline "<topic>"');
  process.exit(1);
}
const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const trace: any = { topic, slug, models: MODELS, startedAt: new Date().toISOString(), steps: [] };
const log = (msg: string) => console.log(`[${((Date.now() - Date.parse(trace.startedAt)) / 1000).toFixed(1)}s] ${msg}`);

async function step<T>(name: string, fn: () => Promise<T>, summarize: (r: T) => any = (r) => r): Promise<T> {
  log(`▶ ${name}`);
  const t0 = Date.now();
  try {
    const out = await fn();
    trace.steps.push({ name, ms: Date.now() - t0, ok: true, output: summarize(out) });
    return out;
  } catch (err: any) {
    trace.steps.push({ name, ms: Date.now() - t0, ok: false, error: String(err?.message ?? err) });
    throw err;
  }
}

async function save() {
  await mkdir('runs', { recursive: true });
  await writeFile(`runs/${slug}.json`, JSON.stringify(trace, null, 2));
}

try {
  // 1. Research agent: tool loop over PubMed, returns a structured brief.
  const research = await step(
    '1 · research',
    () => researcher.generate({ prompt: `Topic: ${topic}` }),
    (r) => ({
      toolCalls: r.steps.flatMap((s: any) => s.toolCalls.map((c: any) => ({ tool: c.toolName, input: c.input }))),
      brief: r.output,
      usage: r.totalUsage,
    }),
  );

  // 2. Verify every citation (code + independent judge model).
  const verified = await step('2 · verify citations', () => verifyBrief(research.output));
  log(`  kept ${verified.brief.claims.length}/${research.output.claims.length} claims`);
  if (verified.brief.claims.length < 3) throw new Error('Fewer than 3 claims survived verification; not enough to write on.');

  // 3 ⇄ 4. Writer drafts, editor reviews, loop until pass or out of rounds.
  let draft = await step('3 · write', () => write(verified.brief));
  let verdict: Review | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prior = verdict?.ledger;
    verdict = await step(`4 · editor review (round ${round})`, () => review(draft, verified.brief, prior), ({ ledger, ...rest }) => rest);
    log(`  ${verdict.verdict}, ${verdict.issues.length} issues`);
    if (verdict.verdict === 'pass') break;
    if (round === MAX_ROUNDS) break;
    const prev = { draft, review: verdict };
    draft = await step(`3 · revise (round ${round})`, () => write(verified.brief, prev));
  }

  trace.status = verdict?.verdict === 'pass' ? 'published' : 'held';
  trace.finalDraft = draft;
  // 5. Publish only what passed; anything else is held for a human.
  await step('5 · publish', () => publish(trace, verified.brief), () => ({ status: trace.status }));
  log(trace.status === 'published' ? `✓ published site/${slug}/` : '✗ held for human review (editor never passed it)');
} catch (err: any) {
  trace.status = 'failed';
  log(`✗ ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  trace.finishedAt = new Date().toISOString();
  await save();
}
