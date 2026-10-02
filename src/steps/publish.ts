import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { marked } from 'marked';
import type { Brief } from '../schemas.ts';

// Step 5: render. Citations become numbered footnotes that link to PubMed, and every
// article gets a public trace page showing what each agent did. Held runs get a trace but no article.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const page = (title: string, body: string, depth = 1) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${'../'.repeat(depth)}style.css"></head>
<body><header class="top"><a href="${'../'.repeat(depth)}">looksmaxxing.guide <span>· pipeline demo</span></a></header>
<main>${body}</main></body></html>`;

function renderArticle(draft: string) {
  const order: string[] = [];
  const md = draft.replace(/\s*\[PMID:\s*(\d+)\]/g, (_, id) => {
    if (!order.includes(id)) order.push(id);
    const n = order.indexOf(id) + 1;
    return `<sup><a href="#ref-${n}">${n}</a></sup>`;
  });
  return { html: marked.parse(md) as string, order };
}

export async function publish(trace: any, brief: Brief) {
  trace.brief = brief;
  await render(trace);
  await mkdir('runs', { recursive: true });
  await writeFile(`runs/${trace.slug}.json`, JSON.stringify(trace, null, 2));
  await buildIndex();
}

// Re-render every page from the saved runs (used after changing templates, and for archived runs).
export async function rebuild() {
  const files = (await readdir('runs').catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of files) await render(JSON.parse(await readFile(`runs/${f}`, 'utf8')));
  await buildIndex();
}

async function render(trace: any) {
  const brief: Brief = trace.brief ?? trace.steps.find((s: any) => s.name.startsWith('2'))?.output?.brief;
  const dir = `site/${trace.slug}`;
  await mkdir(dir, { recursive: true });

  if (trace.status === 'published') {
    const { html, order } = renderArticle(trace.finalDraft);
    const refs = order
      .map((id, i) => {
        const claim = brief.claims.find((c) => c.evidence.some((e) => e.pmid === id));
        const quote = claim?.evidence.find((e) => e.pmid === id)?.quote ?? '';
        return `<li id="ref-${i + 1}"><a href="https://pubmed.ncbi.nlm.nih.gov/${id}/">PMID ${id}</a> — “${esc(quote)}”</li>`;
      })
      .join('\n');
    await writeFile(
      `${dir}/index.html`,
      page(
        trace.topic,
        `<article>${html}<h2>Sources</h2><ol class="refs">${refs}</ol>
${trace.note ? `<p class="note">${esc(trace.note)}</p>` : ''}
<p class="meta">Produced by a 5-step agent pipeline. <a href="trace.html">See exactly how →</a></p></article>`,
      ),
    );
  }

  await writeFile(`${dir}/trace.html`, page(`Trace: ${trace.topic}`, renderTrace(trace)));
}

function renderTrace(t: any) {
  const steps = t.steps
    .map((s: any) => {
      let detail = '';
      if (s.name.startsWith('1') && s.output) {
        detail = `<p>${s.output.toolCalls.length} tool calls:</p><ul class="calls">${s.output.toolCalls
          .map((c: any) => `<li><code>${c.tool}</code> ${esc(JSON.stringify(c.input))}</li>`)
          .join('')}</ul><details><summary>Brief (${s.output.brief.claims.length} claims)</summary><pre>${esc(
          JSON.stringify(s.output.brief, null, 2),
        )}</pre></details>`;
      } else if (s.name.startsWith('2') && s.output?.checks?.[0]?.evidence) {
        detail = s.output.checks
          .map((c: any) => {
            const narrowed = c.entailment && c.entailment.narrowed !== c.original;
            return `<div class="claim ${c.kept ? 'ok' : 'cut'}"><b>${c.claimId}</b> · judge: <b>${
              c.entailment?.verdict ?? 'no valid sources'
            }</b> · ${c.kept ? 'kept' : 'dropped'}
<p>${narrowed ? `<del>${esc(c.original)}</del><br><ins>${esc(c.entailment.narrowed)}</ins>` : esc(c.original)}</p>
<ul>${c.evidence
              .map(
                (e: any) =>
                  `<li><a href="https://pubmed.ncbi.nlm.nih.gov/${e.pmid}/">PMID ${e.pmid}</a> exists ${e.exists ? '✓' : '✗'} · quote in abstract ${e.quoteFound ? '✓' : '✗'}</li>`,
              )
              .join('')}${c.searches
              .map((q: any) => `<li>search receipt “${esc(q.query)}” ${q.ran ? `ran ✓ (${q.titles.length} results)` : 'never ran ✗'}</li>`)
              .join('')}</ul>${c.entailment ? `<p class="meta">${esc(c.entailment.reason)}</p>` : ''}</div>`;
          })
          .join('');
      } else if (s.name.startsWith('2') && s.output) {
        // v1 trace format (one row per citation)
        detail = `<table><tr><th>claim</th><th>PMID</th><th>exists</th><th>quote in abstract</th><th>judge</th><th></th></tr>${s.output.checks
          .map(
            (c: any) =>
              `<tr class="${c.kept ? 'ok' : 'cut'}"><td>${c.claimId}</td><td><a href="https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/">${c.pmid}</a></td><td>${c.exists ? '✓' : '✗'}</td><td>${c.quoteFound ? '✓' : '✗'}</td><td title="${esc(c.entailment?.reason ?? '')}">${c.entailment?.verdict ?? '—'}</td><td>${c.kept ? 'kept' : 'dropped'}</td></tr>`,
          )
          .join('')}</table>`;
      } else if (s.name.startsWith('4') && s.output) {
        const cov = s.output.coverage;
        detail = `<p><b>${s.output.verdict}</b>${
          cov ? ` · ${cov.ruled}/${cov.sentences} sentences ruled${cov.carried ? `, ${cov.carried} carried from last round` : ''} (${Object.entries(cov.byBasis).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''
        }</p><ul>${s.output.issues
          .map((i: any) => `<li><code>${i.kind}</code> “${esc(i.excerpt)}” → ${esc(i.fix)}</li>`)
          .join('')}</ul>`;
      } else if (s.name.startsWith('3') && typeof s.output === 'string') {
        detail = `<details><summary>Draft (${s.output.split(/\s+/).length} words)</summary><pre>${esc(s.output)}</pre></details>`;
      }
      return `<section class="step ${s.ok ? '' : 'err'}"><h3>${esc(s.name)} <small>${(s.ms / 1000).toFixed(1)}s</small></h3>${
        s.error ? `<pre>${esc(s.error)}</pre>` : detail
      }</section>`;
    })
    .join('\n');
  return `<h1>Pipeline trace</h1>${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}<p class="meta">${esc(t.topic)} · status <b>${t.status}</b> · ${esc(
    JSON.stringify(t.models),
  )}</p>${t.status === 'published' ? '<p><a href="./">Read the article →</a></p>' : ''}${steps}`;
}

export async function buildIndex() {
  const files = (await readdir('runs').catch(() => [])).filter((f) => f.endsWith('.json'));
  const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(`runs/${f}`, 'utf8'))));
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const rows = runs
    .map(
      (r) =>
        `<li><span class="badge ${r.status}">${r.status}</span> ${
          r.status === 'published' ? `<a href="${r.slug}/">${esc(r.topic)}</a>` : esc(r.topic)
        } · <a href="${r.slug}/trace.html">trace</a>${r.note ? `<br><small class="meta">${esc(r.note)}</small>` : ''}</li>`,
    )
    .join('\n');
  await mkdir('site', { recursive: true });
  const body = await readFile('src/steps/index-intro.html', 'utf8');
  await writeFile('site/index.html', page('looksmaxxing.guide pipeline', `${body}<h2>Runs</h2><ul class="runs">${rows}</ul>`, 0));
}
