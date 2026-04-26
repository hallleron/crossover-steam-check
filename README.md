# CrossOver Mac Check für deine Steam-Bibliothek

Kleine Web-App, die deine (öffentliche) Steam-Bibliothek über die Steam Web API
ausliest und für jedes Spiel in der
[CodeWeavers-Compatibility-DB](https://www.codeweavers.com/compatibility)
nachschlägt, wie gut es unter **CrossOver auf macOS** läuft. Ergebnisse landen
in einer hübschen, sortier-/filterbaren Karten-Liste.

## Features

- 🔎 Steam-Library laden per Vanity-Name, SteamID64 oder Profil-URL
- 🥇 CrossOver-Rating pro Spiel: Gold / Silver / Bronze / Honorable / Limited /
  Untested / Won't Run
- 📊 Live-Übersicht der Verteilung deiner Bibliothek
- 🔤 Filter nach Rating + Volltext-Suche, Sortierung nach Rating, Spielzeit oder
  Name
- ⚡ Persistenter Cache der CrossOver-Lookups in `.cache/crossover.json`
  mit 7-Tage-Stale-While-Revalidate: einmal aufgelöste Titel überleben
  Server-Restarts, alte Einträge werden sofort ausgeliefert und im
  Hintergrund aufgefrischt

## Voraussetzungen

- Node.js ≥ 18 (für eingebautes `fetch`)
- Steam Web API Key — kostenlos unter
  <https://steamcommunity.com/dev/apikey>
- Dein Steam-Profil **und** die Spieldetails müssen auf „Öffentlich" stehen,
  sonst gibt die Steam-API keine Daten heraus.

## Setup

```bash
npm install
cp .env.example .env
# STEAM_API_KEY=... in .env eintragen
npm start
```

Dann <http://localhost:3000> öffnen.

## Wie das CrossOver-Lookup funktioniert

CodeWeavers bietet keine offizielle JSON-API. Der Scraper in
`lib/crossover.js`:

1. ruft die Suchseite `https://www.codeweavers.com/compatibility?name=<spiel>`
   ab,
2. extrahiert Treffer-Links (`/compatibility/crossover/<slug>`),
3. wählt den ähnlichsten Treffer (exakte/Substring-/Token-Matches),
4. liest, falls nötig, die Detailseite und klassifiziert das Medaillen-Rating
   (Gold/Silver/Bronze/...).

Ergebnisse werden in `.cache/crossover.json` persistiert. Einträge gelten
7 Tage als frisch; ältere Einträge werden sofort aus dem Cache geliefert
und parallel im Hintergrund neu geholt (Stale-While-Revalidate).
Concurrent-Requests für denselben Titel werden dedupliziert. Cache
löschen: `rm .cache/crossover.json`.

Wenn die Markup-Struktur sich ändert, sind die Selektoren in
`parseSearchResults` / `parseAppPage` absichtlich locker — typischerweise
reicht ein kleiner Patch dort.

## Endpoints

- `GET /api/library?user=<vanity|steamid64|profile-url>` → Spieleliste
- `GET /api/compat?name=<game-name>` → `{ rating, label, source, matchedName }`

## Hinweis

Diese App ist nicht mit Valve, Steam oder CodeWeavers verbunden. Sie nutzt nur
öffentlich zugängliche Endpunkte bzw. die öffentliche Compatibility-Seite.
