# CrossOver Mac Check

Read your Steam library and check, game by game, whether each title runs on
[CrossOver for macOS](https://www.codeweavers.com/crossover) according to the
[CodeWeavers compatibility database](https://www.codeweavers.com/compatibility).
Results land in a sortable, filterable card list.

## Features

- Load a Steam library by vanity name, SteamID64, or full profile URL
- Per-game CrossOver verdict: **Runs Great** / **Runs Well** /
  **Limited Functionality** / **Won't Run** / **Untested**
- Live distribution summary across the library
- Rating filters, full-text search, and sorting (rating / playtime / name)
- Persistent disk cache with 7-day stale-while-revalidate so repeat runs
  stay fast and don't hammer CodeWeavers
- Built-in diagnostic endpoint for when CodeWeavers changes its markup

## Quick start (container)

The image is plain OCI, so it works the same way under Docker and Apple's
new `container` CLI (macOS 26+, Apple Silicon).

### 1. Get a Steam Web API key

Free and takes about 30 seconds: <https://steamcommunity.com/dev/apikey>
(any domain like `localhost` works).

### 2. Make your Steam profile public

Steam &rarr; *Settings* &rarr; *Privacy* &rarr; set **My profile** and
**Game details** to *Public*. The Steam Web API returns nothing
otherwise.

### 3. Clone, build, run

```bash
git clone https://github.com/hallleron/crossover-steam-check.git
cd crossover-steam-check
```

**With Docker:**

```bash
docker build -t crossover-steam-check .
docker run --rm -p 3000:3000 \
  -e STEAM_API_KEY=your_key_here \
  -v crossover_cache:/app/.cache \
  crossover-steam-check
```

**With Apple's `container` CLI** (identical apart from the binary name):

```bash
container build -t crossover-steam-check .
container run --rm -p 3000:3000 \
  -e STEAM_API_KEY=your_key_here \
  -v crossover_cache:/app/.cache \
  crossover-steam-check
```

Open <http://localhost:3000> and enter your Steam vanity name,
SteamID64, or profile URL.

The `crossover_cache` volume keeps the lookup cache across container
restarts. Drop the `-v` flag if you don't care about persistence.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `STEAM_API_KEY` | yes | &mdash; | Get one at <https://steamcommunity.com/dev/apikey> |
| `PORT` | no | `3000` | Port the server listens on |

When running from source, these can also be supplied via a `.env` file
(see `.env.example`).

## Run from source

Skip the container if you'd rather run it natively. Requires Node.js
18+ (for built-in `fetch`).

```bash
npm install
cp .env.example .env
# put STEAM_API_KEY=... into .env
npm start
```

Then open <http://localhost:3000>.

## How the lookup works

CodeWeavers does not publish a public JSON API, so the scraper in
`lib/crossover.js` does the following per game:

1. Fetches the search page
   `https://www.codeweavers.com/compatibility?name=<game>`.
2. Extracts hit links matching `/compatibility/crossover/<slug>`.
3. Picks the closest match using exact / substring / token-overlap
   scoring against the Steam-side title.
4. Loads the chosen detail page and reads the headline verdict out of
   `.appdb-rating-box`.

Successful lookups are persisted to `.cache/crossover.json`. Entries
stay fresh for **7 days**; older entries are returned immediately and
refreshed in the background (stale-while-revalidate). Concurrent
lookups for the same title are deduplicated. Wipe the cache with
`rm .cache/crossover.json` or delete the named volume.

### Debugging when CodeWeavers changes its markup

There's a diagnostic endpoint that surfaces every step of the lookup
for one title:

```
http://localhost:3000/api/compat/debug?name=The%20Witcher%203
```

It returns the search HTML head, the parsed candidate list, the chosen
match, and a probe of the detail page (JSON-LD blocks, rating-related
class names, image alt/src values, and text snippets around rating
words). Usually enough to spot which selector in `parseSearchResults`
or `parseAppPage` needs updating.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/library?user=<vanity\|steamid64\|profile-url>` | Resolves and returns the user's owned games |
| `GET` | `/api/compat?name=<game-name>` | CrossOver verdict for a single title |
| `GET` | `/api/compat/debug?name=<game-name>` | Diagnostic dump (see above) |

## Troubleshooting

**`STEAM_API_KEY is not configured`** &mdash; the server didn't see the
variable. In a container, double-check the `-e STEAM_API_KEY=...`
flag. From source, make sure `.env` exists in the project root and
the server was restarted after editing it.

**`No games returned. Make sure your Steam profile and game details
are set to Public.`** &mdash; both *My profile* and *Game details* under
Steam Privacy need to be *Public*. *Friends only* is not enough.

**Most games show as "Unknown"** &mdash; the scraper is finding entries
but failing to read the verdict, usually because CodeWeavers changed
the page markup. Hit the debug endpoint above and open an issue with
the JSON output.

**`[crossover] /app/.cache is not writable`** &mdash; the mounted volume
isn't writable by the container. The image runs as root by default to
sidestep this on Apple's `container` (which provisions named volumes
as root-owned). If you've customized the container user, either fix
the volume's owner or drop the `-v` flag (cache will then be
in-memory only and the app keeps working).

**`Password authentication is not supported`** when cloning &mdash;
GitHub disabled HTTPS password auth in 2021. Use a Personal Access
Token, the `gh` CLI (`gh auth login`), or SSH keys.

## Security notes

This is a small personal tool, not a hardened public service. If you
plan to run it anywhere other than `localhost` on your own machine,
read this section first.

- **Steam API key** &mdash; the key is only used server-side and never
  reaches the browser. Keep it that way: never commit `.env` (already
  gitignored), never bake it into the image. If a key leaks, rotate
  it at <https://steamcommunity.com/dev/apikey>.
- **Network exposure** &mdash; `docker run -p 3000:3000 ...` binds the
  host port to `0.0.0.0`, i.e. the app is reachable from anywhere on
  your LAN. To restrict it to localhost only, use
  `-p 127.0.0.1:3000:3000`.
- **No rate limiting** &mdash; the API endpoints are unauthenticated and
  unthrottled. That's fine for a single-user local tool. If you put
  this behind a public hostname, add a rate limiter (e.g. nginx, a
  reverse proxy, or `express-rate-limit`) before someone discovers
  `/api/compat?name=...` and uses it as a free CodeWeavers proxy.
- **Diagnostic endpoint** &mdash; `/api/compat/debug` returns scraped HTML
  and internal parser state. It does not leak credentials, but it is
  meant for the operator. Don't expose it on a public host without a
  good reason.
- **Container runs as root** &mdash; deliberate, see the troubleshooting
  note above. Acceptable in Apple's `container` (each container is
  its own VM); in Docker on Linux it's a slightly weaker default. If
  this matters to you, switch back to `USER node` in the Dockerfile
  and run `chown -R 1000:1000` on the cache volume after creation.
- **Public Steam profiles only** &mdash; the app intentionally only works
  with libraries the user has marked public. It can't see private
  profiles, even your own.

## Disclaimer

This project is not affiliated with Valve, Steam, or CodeWeavers. It
uses Steam's public Web API and scrapes the public CodeWeavers
compatibility pages. The built-in 7-day cache is there to be a good
citizen &mdash; please don't tear it out.

## License

[MIT](LICENSE).
