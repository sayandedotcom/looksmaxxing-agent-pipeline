// Thin PubMed E-utilities client. No key needed, but NCBI caps anonymous use at
// 3 req/s, so every call goes through one throttled queue.

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GAP_MS = 400;
let last = 0;

async function ncbi(path: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, last + GAP_MS - Date.now());
    last = Date.now() + wait;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(`${BASE}/${path}&tool=looksmaxxing-pipeline`);
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`NCBI ${res.status} for ${path}`);
    return res.text();
  }
  throw new Error(`NCBI kept failing for ${path}`);
}

export type PaperSummary = {
  pmid: string;
  title: string;
  year: string;
  journal: string;
  pubTypes: string[];
};

export async function searchPubMed(query: string, max = 8): Promise<PaperSummary[]> {
  const search = JSON.parse(
    await ncbi(`esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${max}&term=${encodeURIComponent(query)}`),
  );
  const ids: string[] = search.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const summary = JSON.parse(await ncbi(`esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`));
  return ids
    .map((id) => summary.result?.[id])
    .filter(Boolean)
    .map((p: any) => ({
      pmid: p.uid,
      title: p.title,
      year: (p.pubdate ?? '').slice(0, 4),
      journal: p.fulljournalname ?? p.source,
      pubTypes: p.pubtype ?? [],
    }));
}

export type Abstract = { pmid: string; title: string; abstract: string } | null;

const cache = new Map<string, Abstract>();

function decode(s: string) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export async function getAbstract(pmid: string): Promise<Abstract> {
  if (!/^\d{1,9}$/.test(pmid)) return null;
  if (cache.has(pmid)) return cache.get(pmid)!;
  const xml = await ncbi(`efetch.fcgi?db=pubmed&retmode=xml&id=${pmid}`);
  if (!/<PubmedArticle[\s>]/.test(xml)) {
    cache.set(pmid, null);
    return null;
  }
  const title = decode(xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? '');
  const parts = [...xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attrs, body]) => {
    const label = attrs.match(/Label="([^"]+)"/)?.[1];
    return (label ? `${label}: ` : '') + decode(body);
  });
  const out = { pmid, title, abstract: parts.join('\n') };
  cache.set(pmid, out);
  return out;
}
