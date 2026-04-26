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
  unknown: 'Unbekannt',
};

const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const userInput = $('#user');
const submitBtn = $('#submit');
const statusEl = $('#status');
const summaryEl = $('#summary');
const summaryGrid = summaryEl.querySelector('.summary-grid');
const controlsEl = $('#controls');
const filterText = $('#filterText');
const sortSelect = $('#sort');
const list = $('#games');

const state = {
  games: [],
  compat: new Map(), // appid -> { rating, label, source, matchedName, status }
  ratingsEnabled: new Set(RATING_ORDER),
};

function setStatus(message, kind = 'info') {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    return;
  }
  statusEl.hidden = false;
  statusEl.classList.toggle('error', kind === 'error');
  statusEl.innerHTML = message;
}

function fmtPlaytime(min) {
  if (!min) return 'noch nie gespielt';
  if (min < 60) return `${min} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${h} h`;
}

function gameCard(game) {
  const c = state.compat.get(game.appid) || { rating: 'unknown', label: '…' };
  const li = document.createElement('li');
  li.className = 'game';
  li.dataset.appid = game.appid;
  li.dataset.rating = c.rating;
  li.dataset.name = game.name.toLowerCase();

  const badgeLabel =
    c.status === 'loading'
      ? '<span class="spinner"></span>Prüfe…'
      : c.label || RATING_LABELS[c.rating] || 'Unbekannt';

  const sourceLink = c.source
    ? `<a href="${c.source}" target="_blank" rel="noopener">CrossOver-Eintrag</a>`
    : '';

  li.innerHTML = `
    <div class="header">
      <a href="${game.storeUrl}" target="_blank" rel="noopener">
        <img loading="lazy" src="${game.headerUrl}" alt="" onerror="this.style.display='none'" />
      </a>
    </div>
    <div class="body">
      <div class="title" title="${escapeAttr(game.name)}">${escapeHtml(
        game.name,
      )}</div>
      <span class="badge ${c.rating}">${badgeLabel}</span>
      <div class="meta">
        <span>⏱ ${fmtPlaytime(game.playtimeMinutes)}</span>
        <span>App-ID ${game.appid}</span>
      </div>
      <div class="links">
        <a href="${game.storeUrl}" target="_blank" rel="noopener">Steam</a>
        ${sourceLink}
      </div>
    </div>
  `;
  return li;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function renderAll() {
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const g of currentSortedFiltered()) frag.appendChild(gameCard(g));
  list.appendChild(frag);
  renderSummary();
}

function updateCard(appid) {
  const card = list.querySelector(`.game[data-appid="${appid}"]`);
  if (!card) return;
  const game = state.games.find((g) => g.appid === appid);
  if (!game) return;
  const fresh = gameCard(game);
  card.replaceWith(fresh);
  renderSummary();
  applyFilters();
}

function renderSummary() {
  const counts = Object.fromEntries(RATING_ORDER.map((k) => [k, 0]));
  for (const g of state.games) {
    const c = state.compat.get(g.appid);
    counts[c?.rating || 'unknown']++;
  }
  summaryEl.hidden = false;
  summaryGrid.innerHTML = RATING_ORDER.map(
    (k) => `
      <div class="summary-tile">
        <span class="dot ${k}"></span>
        <div>
          <div class="count">${counts[k]}</div>
          <div class="label">${RATING_LABELS[k]}</div>
        </div>
      </div>`,
  ).join('');
}

function currentSortedFiltered() {
  const games = [...state.games];
  const sortBy = sortSelect.value;
  if (sortBy === 'name') {
    games.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === 'playtime') {
    games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
  } else {
    games.sort((a, b) => {
      const ra = state.compat.get(a.appid)?.rank ?? 99;
      const rb = state.compat.get(b.appid)?.rank ?? 99;
      if (ra !== rb) return ra - rb;
      return b.playtimeMinutes - a.playtimeMinutes;
    });
  }
  return games;
}

function applyFilters() {
  const q = filterText.value.trim().toLowerCase();
  for (const li of list.children) {
    const r = li.dataset.rating;
    const name = li.dataset.name;
    const ratingOk = state.ratingsEnabled.has(r);
    const textOk = !q || name.includes(q);
    li.style.display = ratingOk && textOk ? '' : 'none';
  }
}

async function fetchCompat(game) {
  state.compat.set(game.appid, {
    rating: 'unknown',
    label: 'Prüfe…',
    rank: 99,
    status: 'loading',
  });
  updateCard(game.appid);
  try {
    const url = `/api/compat?name=${encodeURIComponent(game.name)}`;
    const res = await fetch(url);
    const json = await res.json();
    state.compat.set(game.appid, {
      rating: json.rating || 'unknown',
      label: json.label || RATING_LABELS[json.rating] || 'Unbekannt',
      rank: typeof json.rank === 'number' ? json.rank : 99,
      source: json.source || null,
      matchedName: json.matchedName || null,
      status: 'done',
    });
  } catch {
    state.compat.set(game.appid, {
      rating: 'unknown',
      label: 'Fehler',
      rank: 99,
      status: 'error',
    });
  }
  updateCard(game.appid);
}

async function runWithLimit(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = userInput.value.trim();
  if (!user) return;
  submitBtn.disabled = true;
  setStatus('<span class="spinner"></span>Lade Steam-Bibliothek…');
  list.innerHTML = '';
  controlsEl.hidden = true;
  summaryEl.hidden = true;
  state.games = [];
  state.compat.clear();

  try {
    const res = await fetch(`/api/library?user=${encodeURIComponent(user)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.games = json.games || [];
    if (!state.games.length) {
      setStatus('Keine Spiele gefunden.', 'error');
      return;
    }
    setStatus(
      `<span class="spinner"></span>${state.games.length} Spiele geladen — prüfe CrossOver-Kompatibilität…`,
    );
    controlsEl.hidden = false;
    renderAll();

    await runWithLimit(state.games, 4, fetchCompat);

    setStatus(
      `Fertig: ${state.games.length} Spiele aus der Steam-Bibliothek geprüft.`,
    );
    renderAll();
    applyFilters();
  } catch (err) {
    setStatus(escapeHtml(err.message || String(err)), 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

filterText.addEventListener('input', applyFilters);
sortSelect.addEventListener('change', renderAll);

document.querySelectorAll('.filters input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    const r = cb.dataset.rating;
    if (cb.checked) state.ratingsEnabled.add(r);
    else state.ratingsEnabled.delete(r);
    applyFilters();
  });
});
