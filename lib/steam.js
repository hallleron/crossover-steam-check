const STEAM_API = 'https://api.steampowered.com';

export class SteamError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function requireKey() {
  const key = process.env.STEAM_API_KEY;
  if (!key) {
    throw new SteamError(
      'STEAM_API_KEY is not configured on the server. Get one at https://steamcommunity.com/dev/apikey and put it in .env',
      500,
    );
  }
  return key;
}

export async function resolveSteamId(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new SteamError('Missing Steam ID or vanity name', 400);

  // Already a SteamID64 (17 digits, starts with 7656119...)
  if (/^\d{17}$/.test(trimmed)) return trimmed;

  // Allow pasting a profile URL
  let vanity = trimmed;
  const urlMatch = trimmed.match(
    /steamcommunity\.com\/(?:id|profiles)\/([^/?#]+)/i,
  );
  if (urlMatch) {
    const seg = urlMatch[1];
    if (/^\d{17}$/.test(seg)) return seg;
    vanity = seg;
  }

  const key = requireKey();
  const url = new URL(`${STEAM_API}/ISteamUser/ResolveVanityURL/v1/`);
  url.searchParams.set('key', key);
  url.searchParams.set('vanityurl', vanity);

  const res = await fetch(url);
  if (!res.ok) throw new SteamError(`Steam API error ${res.status}`, 502);
  const json = await res.json();
  const r = json.response || {};
  if (r.success !== 1 || !r.steamid) {
    throw new SteamError(`Could not resolve "${vanity}" to a Steam account`, 404);
  }
  return r.steamid;
}

export async function getOwnedGames(steamId) {
  const key = requireKey();
  const url = new URL(`${STEAM_API}/IPlayerService/GetOwnedGames/v1/`);
  url.searchParams.set('key', key);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', '1');
  url.searchParams.set('include_played_free_games', '1');

  const res = await fetch(url);
  if (!res.ok) throw new SteamError(`Steam API error ${res.status}`, 502);
  const json = await res.json();
  const r = json.response || {};

  // Steam returns an empty object {} when the profile/library is private
  if (!r.games) {
    throw new SteamError(
      'No games returned. Make sure your Steam profile and game details are set to Public.',
      403,
    );
  }

  return r.games.map((g) => ({
    appid: g.appid,
    name: g.name,
    playtimeMinutes: g.playtime_forever || 0,
    iconUrl: g.img_icon_url
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
      : null,
    headerUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
    storeUrl: `https://store.steampowered.com/app/${g.appid}`,
  }));
}
