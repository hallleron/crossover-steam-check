import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';

const CW_BASE = 'https://www.codeweavers.com';
const SEARCH_URL = `${CW_BASE}/compatibility`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Cache entries are reused for 7 days. Older entries are still served
// immediately ("stale") and refreshed in the background on access.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'crossover.json');
const CACHE_VERSION = 1;

const cache = new Map(); // normalized name -> { rating, source, matchedName, fetchedAt }
const inflight = new Map(); // normalized name -> Promise

// CodeWeavers replaced the legacy Gold/Silver/Bronze system with verbal
// verdicts. Order is best → worst, used for sorting + summary tiles.
const RATING_ORDER = [
  'runs-great',
  'runs-well',
  'limited',
  'wont-run',
  'untested',
  'unknown',
];

const RATING_LABELS = {
  'runs-great': 'Runs Great',
  'runs-well': 'Runs Well',
  limited: 'Limited Functionality',
  'wont-run': "Won't Run",
  untested: 'Untested',
  unknown: 'Unbekannt',
};

export function ratingLabel(key) {
  return RATING_LABELS[key] || 'Unknown';
}

export function ratingRank(key) {
  const i = RATING_ORDER.indexOf(key);
  return i === -1 ? RATING_ORDER.length : i;
}

function normalize(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function classifyRating(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'unknown';

  // Modern CodeWeavers verdicts (most specific first).
  if (/won['’]?t\s*(?:run|install)|will\s+not\s+(?:run|install)|does\s+not\s+(?:run|install)/.test(t)) {
    return 'wont-run';
  }
  if (/\bruns\s+great\b/.test(t)) return 'runs-great';
  if (/\bruns\s+well\b/.test(t)) return 'runs-well';
  if (/limited\s+functionality|runs\s+with\s+issues|\bpartial\b/.test(t)) {
    return 'limited';
  }
  if (/\buntested\b/.test(t)) return 'untested';

  // Legacy medal vocabulary, mapped onto the new buckets.
  if (/\bgold\b/.test(t)) return 'runs-great';
  if (/\bsilver\b/.test(t)) return 'runs-well';
  if (/\bbronze\b/.test(t)) return 'limited';
  if (/\bhonorable\b/.test(t)) return 'limited';
  if (/\bbroken\b/.test(t)) return 'wont-run';

  return 'unknown';
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data.version !== CACHE_VERSION || !data.entries) return;
    for (const [k, v] of Object.entries(data.entries)) {
      if (v && typeof v.fetchedAt === 'number') cache.set(k, v);
    }
  } catch (err) {
    console.warn('[crossover] cache load failed:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushCache, 500);
  // Don't keep the event loop alive just for the save timer.
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function flushCache() {
  saveTimer = null;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const data = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(cache),
    };
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.warn('[crossover] cache save failed:', err.message);
  }
}

// Best-effort flush on graceful shutdown so a pending debounced save
// doesn't get lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      flushCache();
    }
    process.exit(0);
  });
}

loadCache();

async function fetchHtml(url) {
  const res = await fetchHtmlRaw(url);
  if (!res.ok) {
    const err = new Error(`CodeWeavers HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function fetchHtmlRaw(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    redirect: 'follow',
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, finalUrl: res.url, body };
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('a[href*="/compatibility/crossover/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    if (!/\/compatibility\/crossover\/[a-z0-9-]+/i.test(href)) return;
    if (/\/search|\/tips|\/category/i.test(href)) return;

    const name = ($a.text() || '').replace(/\s+/g, ' ').trim();
    if (!name) return;

    const $card = $a.closest(
      '.compatibility-result, .card, li, tr, .result, article',
    );
    const ratingText = ($card.find('.medal, .rating, .badge').text() ||
      $card.text() ||
      '').trim();

    results.push({
      name,
      url: href.startsWith('http') ? href : `${CW_BASE}${href}`,
      slug: href.split('/').filter(Boolean).pop(),
      ratingHint: ratingText,
    });
  });

  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });
}

function pickBestMatch(query, results) {
  if (!results.length) return null;
  const nq = normalize(query);
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const nr = normalize(r.name);
    let score = 0;
    if (nr === nq) score = 1000;
    else if (nr.startsWith(nq)) score = 500 - Math.abs(nr.length - nq.length);
    else if (nr.includes(nq)) score = 200 - Math.abs(nr.length - nq.length);
    else {
      const a = new Set(nq.split(' '));
      const b = new Set(nr.split(' '));
      let common = 0;
      for (const t of a) if (b.has(t)) common++;
      score = common * 10 - Math.abs(nr.length - nq.length);
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// Replace block-level tag boundaries with spaces so siblings like
// "<span>Runs Well</span><small>Last Tested</small>" don't collapse
// into "Runs WellLast Tested" when we read .text().
function nodeText($node) {
  return $node
    .html()
    ? $node
        .html()
        .replace(/<\/?(?:br|p|div|span|li|td|tr|h\d|small|i|b|strong)[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
}

function parseAppPage(html) {
  const $ = cheerio.load(html);
  const title = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();

  // 1) Primary signal: the headline rating widget. As of 2026 the Mac
  //    verdict (e.g. "Runs Great Last Tested: 26.1.0") sits inside
  //    .appdb-rating-box.
  const containers = [
    '.appdb-rating-box',
    '.card-header.showMedal',
    '[class*="rating-box"]',
    '[class*="appdb-rating"]',
  ];
  for (const sel of containers) {
    const $node = $(sel).first();
    if (!$node.length) continue;
    const r = classifyRating(nodeText($node));
    if (r !== 'unknown') return { rating: r, title };
  }

  // 2) Fallback: take the first verdict phrase that appears anywhere in
  //    the main content. The page may also list per-version test rows
  //    further down — we deliberately stop at the first match because
  //    the headline rating is rendered before the breakdown table.
  const main = nodeText($('main').first()) || nodeText($('body').first());
  return { rating: classifyRating(main), title };
}

async function performLookup(name) {
  const searchUrl = new URL(SEARCH_URL);
  searchUrl.searchParams.set('name', name);
  const searchHtml = await fetchHtml(searchUrl.toString());
  const results = parseSearchResults(searchHtml);
  const best = pickBestMatch(name, results);

  if (!best) return { rating: 'unknown', source: null, matchedName: null };

  let rating = classifyRating(best.ratingHint);
  let matchedName = best.name;

  if (rating === 'unknown') {
    try {
      const appHtml = await fetchHtml(best.url);
      const parsed = parseAppPage(appHtml);
      rating = parsed.rating;
      if (parsed.title) matchedName = parsed.title;
    } catch {
      // keep rating=unknown but we still have a source URL
    }
  }

  return { rating, source: best.url, matchedName };
}

function refreshAndStore(key, name) {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await performLookup(name);
      const entry = { ...value, fetchedAt: Date.now() };
      // Only cache results we actually learned something from. A bare
      // "unknown / no source / no name" looks identical to a parser
      // mismatch or a rate-limited empty page — don't poison the cache
      // with that for 7 days.
      if (value.source || value.matchedName || value.rating !== 'unknown') {
        cache.set(key, entry);
        scheduleSave();
      }
      return entry;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function probe(html) {
  const $ = cheerio.load(html);
  const out = {};

  // 1. JSON-LD blocks (often contain ratings/reviews for SEO)
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonLd.push(JSON.parse($(el).text()));
    } catch {
      jsonLd.push({ raw: $(el).text().slice(0, 500) });
    }
  });
  out.jsonLd = jsonLd;

  // 2. Class attributes that look rating-related
  const classes = new Set();
  $('[class]').each((_, el) => {
    const c = ($(el).attr('class') || '').trim();
    if (
      /medal|rating|star|score|compat|grade|verdict|review|runs|works|status|badge|level/i.test(
        c,
      )
    ) {
      classes.add(c);
    }
  });
  out.interestingClasses = [...classes].slice(0, 40);

  // 3. Images that look rating-related
  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    const alt = $(el).attr('alt') || '';
    if (
      /medal|rating|star|score|compat|grade|gold|silver|bronze|trophy|thumb/i.test(
        src + ' ' + alt,
      )
    ) {
      images.push({ src, alt });
    }
  });
  out.interestingImages = images.slice(0, 12);

  // 4. Snippets around rating-y words in the rendered text + raw HTML
  const text = $('main').text() || $('body').text();
  const snippets = [];
  const words = [
    'gold',
    'silver',
    'bronze',
    'honorable',
    "won't run",
    'wont run',
    'limited',
    'untested',
    'rating',
    'medal',
    'verdict',
    'runs great',
    'runs well',
    'has issues',
    'compat',
    'star',
    'score',
    '★',
    '☆',
  ];
  for (const w of words) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(w);
    if (idx !== -1) {
      const around = text
        .slice(Math.max(0, idx - 80), idx + 160)
        .replace(/\s+/g, ' ')
        .trim();
      snippets.push({ word: w, snippet: around });
    }
  }
  out.snippets = snippets;

  // 5. Common semantic landmarks
  out.h1 = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  out.h2s = $('h2')
    .slice(0, 6)
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get();

  return out;
}

export async function diagnose(name) {
  const out = {
    input: name,
    normalized: normalize(name),
    cached: cache.get(normalize(name)) || null,
    search: null,
    candidates: [],
    chosen: null,
    appPage: null,
    final: null,
  };

  try {
    const searchUrl = new URL(SEARCH_URL);
    searchUrl.searchParams.set('name', name);
    const search = await fetchHtmlRaw(searchUrl.toString());
    out.search = {
      url: searchUrl.toString(),
      finalUrl: search.finalUrl,
      status: search.status,
      bodyLength: search.body.length,
      bodyHead: search.body.slice(0, 1500),
    };
    if (!search.ok) return out;

    const results = parseSearchResults(search.body);
    out.candidates = results.slice(0, 10).map((r) => ({
      name: r.name,
      url: r.url,
      slug: r.slug,
      ratingHint: r.ratingHint.slice(0, 200),
      classifiedFromHint: classifyRating(r.ratingHint),
    }));

    const best = pickBestMatch(name, results);
    out.chosen = best
      ? { name: best.name, url: best.url, slug: best.slug }
      : null;
    if (!best) return out;

    let rating = classifyRating(best.ratingHint);
    let matchedName = best.name;
    if (rating === 'unknown') {
      try {
        const app = await fetchHtmlRaw(best.url);
        out.appPage = {
          url: best.url,
          finalUrl: app.finalUrl,
          status: app.status,
          bodyLength: app.body.length,
          bodyHead: app.body.slice(0, 4000),
          probe: app.ok ? probe(app.body) : null,
        };
        if (app.ok) {
          const parsed = parseAppPage(app.body);
          rating = parsed.rating;
          if (parsed.title) matchedName = parsed.title;
        }
      } catch (err) {
        out.appPage = { error: err.message };
      }
    }

    out.final = { rating, source: best.url, matchedName };
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

export async function lookupCompatibility(name) {
  const key = normalize(name);
  if (!key) return { rating: 'unknown', source: null, matchedName: null };

  const entry = cache.get(key);
  const now = Date.now();

  if (entry) {
    const age = now - (entry.fetchedAt || 0);
    if (age >= TTL_MS) {
      // Stale: serve cached value, refresh in background.
      refreshAndStore(key, name).catch(() => {});
    }
    return entry;
  }

  try {
    return await refreshAndStore(key, name);
  } catch (err) {
    // Don't poison the cache on transient failures — let the next call retry.
    return {
      rating: 'unknown',
      source: null,
      matchedName: null,
      error: err.message,
    };
  }
}
