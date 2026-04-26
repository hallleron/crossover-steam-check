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

const RATING_ORDER = [
  'gold',
  'silver',
  'bronze',
  'honorable',
  'limited',
  'untested',
  'wont-run',
  'unknown',
];

const RATING_LABELS = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
  honorable: 'Honorable Mention',
  limited: 'Limited',
  untested: 'Untested',
  'wont-run': "Won't Run",
  unknown: 'Unknown',
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
  if (/won['’]?t\s*run|will not run|does not run|broken/.test(t)) return 'wont-run';
  if (/honorable/.test(t)) return 'honorable';
  if (/gold/.test(t)) return 'gold';
  if (/silver/.test(t)) return 'silver';
  if (/bronze/.test(t)) return 'bronze';
  if (/limited|partial|runs with issues/.test(t)) return 'limited';
  if (/untested/.test(t)) return 'untested';
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
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`CodeWeavers HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
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

function parseAppPage(html) {
  const $ = cheerio.load(html);

  const candidates = [
    $('.medal').first().text(),
    $('.rating').first().text(),
    $('[class*="medal-"]').first().attr('class') || '',
    $('img[alt*="medal" i]').attr('alt') || '',
    $('img[src*="medal" i]').attr('src') || '',
    $('h1, h2').first().text(),
  ];

  let rating = 'unknown';
  for (const c of candidates) {
    const r = classifyRating(c);
    if (r !== 'unknown') {
      rating = r;
      break;
    }
  }

  if (rating === 'unknown') {
    const text = $('main, body').first().text().slice(0, 4000);
    rating = classifyRating(text);
  }

  const title = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  return { rating, title };
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
      cache.set(key, entry);
      scheduleSave();
      return entry;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
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
