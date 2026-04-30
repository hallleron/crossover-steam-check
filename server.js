import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSteamId, getOwnedGames, SteamError } from './lib/steam.js';
import {
  lookupCompatibility,
  ratingLabel,
  ratingRank,
  diagnose,
} from './lib/crossover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/library', async (req, res) => {
  try {
    const steamId = await resolveSteamId(req.query.user);
    const games = await getOwnedGames(steamId);
    games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
    res.json({ steamId, count: games.length, games });
  } catch (err) {
    const status = err instanceof SteamError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/compat', async (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) {
    res.status(400).json({ error: 'Missing "name" parameter' });
    return;
  }
  const result = await lookupCompatibility(name);
  res.json({
    name,
    rating: result.rating,
    label: ratingLabel(result.rating),
    rank: ratingRank(result.rating),
    source: result.source,
    matchedName: result.matchedName,
  });
});

app.get('/api/compat/debug', async (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) {
    res.status(400).json({ error: 'Missing "name" parameter' });
    return;
  }
  res.json(await diagnose(name));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`crossover-steam-check listening on http://localhost:${port}`);
});
