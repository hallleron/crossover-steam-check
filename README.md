# CrossOver Mac Check for your Steam library

Small web app that pulls your (public) Steam library via the Steam Web
API and looks up each game in the
[CodeWeavers compatibility database](https://www.codeweavers.com/compatibility)
to see how well it runs under **CrossOver on macOS**. Results land in a
sortable, filterable card list.

## Features

- Load your Steam library by vanity name, SteamID64, or profile URL
- Per-game CrossOver rating: Runs Great / Runs Well / Limited
  Functionality / Won't Run / Untested
- Live distribution summary across your library
- Rating filters + full-text search, sort by rating, playtime, or name
- Persistent CrossOver lookup cache in `.cache/crossover.json` with
  7-day stale-while-revalidate: once-resolved titles survive server
  restarts; older entries are served immediately and refreshed in the
  background

## Requirements

- Node.js ≥ 18 (for built-in `fetch`)
- Steam Web API key — free at
  <https://steamcommunity.com/dev/apikey>
- Your Steam profile **and** game details must be set to "Public",
  otherwise the Steam API returns no data.

## Setup

```bash
npm install
cp .env.example .env
# put STEAM_API_KEY=... into .env
npm start
```

Then open <http://localhost:3000>.

## Running in a container

The image is plain OCI and works with **Docker** as well as Apple's new
**`container`** CLI (macOS 26+, Apple Silicon).

### Build

```bash
docker build -t crossover-steam-check .
# or
container build -t crossover-steam-check .
```

### Run

```bash
docker run --rm -p 3000:3000 \
  -e STEAM_API_KEY=your_key_here \
  -v crossover_cache:/app/.cache \
  crossover-steam-check
```

With Apple's `container` CLI, identical syntax:

```bash
container run --rm -p 3000:3000 \
  -e STEAM_API_KEY=your_key_here \
  -v crossover_cache:/app/.cache \
  crossover-steam-check
```

The `crossover_cache` volume (or a bind mount of your choice) preserves
the lookup cache across container restarts.

## How the CrossOver lookup works

CodeWeavers does not publish an official JSON API. The scraper in
`lib/crossover.js`:

1. fetches the search page
   `https://www.codeweavers.com/compatibility?name=<game>`,
2. extracts hit links (`/compatibility/crossover/<slug>`),
3. picks the closest match (exact / substring / token overlap),
4. loads the detail page and extracts the verdict from
   `.appdb-rating-box` (Runs Great / Runs Well / Limited Functionality
   / Won't Run / Untested).

Results are persisted in `.cache/crossover.json`. Entries are
considered fresh for 7 days; older entries are served from the cache
immediately and refreshed in parallel in the background
(stale-while-revalidate). Concurrent requests for the same title are
deduplicated. Clear the cache with `rm .cache/crossover.json`.

If the page markup changes, the selectors in `parseSearchResults` /
`parseAppPage` are intentionally loose — usually a small patch there
is enough.

## Endpoints

- `GET /api/library?user=<vanity|steamid64|profile-url>` → game list
- `GET /api/compat?name=<game-name>` → `{ rating, label, source, matchedName }`
- `GET /api/compat/debug?name=<game-name>` → diagnostic dump (search
  HTML head, parsed candidates, chosen match, app-page probe) for
  reverse-engineering selectors when CodeWeavers' markup changes

## Disclaimer

This app is not affiliated with Valve, Steam, or CodeWeavers. It only
uses publicly accessible endpoints / the public compatibility pages.
