import * as cheerio from 'cheerio';

const CW_BASE = 'https://www.codeweavers.com';
const SEARCH_URL = `${CW_BASE}/compatibility`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// In-memory cache. CrossOver ratings change rarely; one day is fine.
const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // normalized name -> { value, expires }

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

  // The compatibility search page renders cards/rows that link to
  // /compatibility/crossover/<slug>. Selectors are kept loose so small
  // markup tweaks on the site don't break us.
  $('a[href*="/compatibility/crossover/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    if (!/\/compatibility\/crossover\/[a-z0-9-]+/i.test(href)) return;
    if (/\/search|\/tips|\/category/i.test(href)) return;

    const name = ($a.text() || '').replace(/\s+/g, ' ').trim();
    if (!name) return;

    // Try to find a rating label nearby (within the same card/row).
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

  // De-duplicate by slug, keep the first occurrence (usually the heading link).
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
      // token overlap
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

  // Try a few selectors for the medal/rating shown on the app page.
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

  // Fall back: scan visible page text once.
  if (rating === 'unknown') {
    const text = $('main, body').first().text().slice(0, 4000);
    rating = classifyRating(text);
  }

  const title = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  return { rating, title };
}

export async function lookupCompatibility(name) {
  const key = normalize(name);
  if (!key) return { rating: 'unknown', source: null, matchedName: null };

  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value = { rating: 'unknown', source: null, matchedName: null };
  try {
    const searchUrl = new URL(SEARCH_URL);
    searchUrl.searchParams.set('name', name);
    const searchHtml = await fetchHtml(searchUrl.toString());
    const results = parseSearchResults(searchHtml);
    const best = pickBestMatch(name, results);

    if (best) {
      let rating = classifyRating(best.ratingHint);
      let matchedName = best.name;

      // If the search snippet didn't reveal a medal, fetch the app page.
      if (rating === 'unknown') {
        try {
          const appHtml = await fetchHtml(best.url);
          const parsed = parseAppPage(appHtml);
          rating = parsed.rating;
          if (parsed.title) matchedName = parsed.title;
        } catch {
          // ignore — keep "unknown"
        }
      }

      value = { rating, source: best.url, matchedName };
    }
  } catch (err) {
    value = {
      rating: 'unknown',
      source: null,
      matchedName: null,
      error: err.message,
    };
  }

  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}
