import type { GenreEvidence } from './genreEvidence.js';

export type TrackIdentity = {
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
  mbid?: string;
  appleGenres?: string[];
  allMusicGenres?: string[];
};

export type SourceResult = {
  source: string;
  configured: boolean;
  evidence: GenreEvidence[];
  matched?: Record<string, unknown> | null;
  error?: string;
};

type CacheEntry<T> = { expiresAt: number; value: T };
const sourceCache = new Map<string, CacheEntry<SourceResult>>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const USER_AGENT = process.env.METADATA_USER_AGENT?.trim() || 'GenreOrganizerVisualizer/0.1 (genre metadata research)';

function normalize(value: unknown) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(source: string, identity: TrackIdentity) {
  return [source, identity.isrc?.toUpperCase(), identity.mbid, normalize(identity.artist), normalize(identity.title), normalize(identity.album)].join('|');
}

function cached(source: string, identity: TrackIdentity) {
  const key = cacheKey(source, identity);
  const hit = sourceCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    sourceCache.delete(key);
    return null;
  }
  return hit.value;
}

function putCache(source: string, identity: TrackIdentity, value: SourceResult) {
  sourceCache.set(cacheKey(source, identity), { expiresAt: Date.now() + CACHE_TTL_MS, value });
  if (sourceCache.size > 20_000) {
    const first = sourceCache.keys().next().value;
    if (first) sourceCache.delete(first);
  }
  return value;
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 12_000) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<any>;
}

function tagStrength(count: unknown, maxCount: number) {
  const parsed = Math.max(0, Number(count) || 0);
  if (!maxCount) return 0.72;
  return Math.max(0.45, Math.min(1, parsed / maxCount));
}

function likelyGenreTag(tag: string) {
  const key = normalize(tag);
  if (!key || key.length < 2) return false;
  const blocked = new Set([
    'favorites', 'favourite', 'favorite', 'seen live', 'male vocalists', 'female vocalists',
    'american', 'british', 'canadian', 'australian', '80s', '90s', '00s', '10s', '20s',
    'spotify', 'under 2000 listeners', 'songs i love', 'awesome', 'beautiful', 'chill'
  ]);
  return !blocked.has(key);
}

let musicBrainzNextAt = 0;
let musicBrainzQueue = Promise.resolve();
async function musicBrainzJson(url: string) {
  let release!: () => void;
  const previous = musicBrainzQueue;
  musicBrainzQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, musicBrainzNextAt - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const value = await fetchJson(url, {}, 15_000);
    musicBrainzNextAt = Date.now() + 1100;
    return value;
  } finally {
    release();
  }
}

async function resolveMusicBrainzRecording(identity: TrackIdentity) {
  if (identity.mbid) return { id: identity.mbid, match: 1 };

  let query = '';
  if (identity.isrc) {
    query = `isrc:${identity.isrc.replace(/[^A-Za-z0-9]/g, '')}`;
  } else {
    const escapedTitle = identity.title.replace(/"/g, '\\"');
    const escapedArtist = identity.artist.replace(/"/g, '\\"');
    query = `recording:"${escapedTitle}" AND artist:"${escapedArtist}"`;
  }

  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=5&fmt=json`;
  const data = await musicBrainzJson(url);
  const candidates = Array.isArray(data?.recordings) ? data.recordings : [];
  const top = candidates[0];
  if (!top?.id) return null;
  return { id: String(top.id), match: Math.max(0.5, Math.min(1, Number(top.score || 70) / 100)) };
}

export async function musicBrainzEvidence(identity: TrackIdentity): Promise<SourceResult> {
  const hit = cached('musicbrainz', identity);
  if (hit) return hit;
  try {
    const resolved = await resolveMusicBrainzRecording(identity);
    if (!resolved) return putCache('musicbrainz', identity, { source: 'musicbrainz', configured: true, evidence: [], matched: null });

    const detailUrl = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(resolved.id)}?inc=genres+artist-credits&fmt=json`;
    const detail = await musicBrainzJson(detailUrl);
    const genres = Array.isArray(detail?.genres) ? detail.genres : [];
    const maxCount = Math.max(0, ...genres.map((item: any) => Number(item?.count) || 0));
    const evidence: GenreEvidence[] = genres
      .filter((item: any) => likelyGenreTag(String(item?.name || '')))
      .slice(0, 12)
      .map((item: any) => ({
        source: 'musicbrainz',
        genre: String(item.name),
        level: 'recording',
        matchConfidence: resolved.match,
        tagConfidence: tagStrength(item.count, maxCount)
      }));

    return putCache('musicbrainz', identity, {
      source: 'musicbrainz', configured: true, evidence,
      matched: { mbid: resolved.id, title: detail?.title || null, score: resolved.match }
    });
  } catch (error) {
    return { source: 'musicbrainz', configured: true, evidence: [], error: error instanceof Error ? error.message : 'MusicBrainz lookup failed' };
  }
}

export async function lastFmEvidence(identity: TrackIdentity): Promise<SourceResult> {
  const key = process.env.LASTFM_API_KEY?.trim();
  if (!key) return { source: 'lastfm', configured: false, evidence: [] };
  const hit = cached('lastfm', identity);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({ method: 'track.getTopTags', api_key: key, format: 'json', autocorrect: '1' });
    if (identity.mbid) params.set('mbid', identity.mbid);
    else {
      params.set('artist', identity.artist);
      params.set('track', identity.title);
    }
    const data = await fetchJson(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
    const tags = Array.isArray(data?.toptags?.tag) ? data.toptags.tag : [];
    const maxCount = Math.max(0, ...tags.map((item: any) => Number(item?.count) || 0));
    const evidence: GenreEvidence[] = tags
      .filter((item: any) => likelyGenreTag(String(item?.name || '')))
      .slice(0, 10)
      .map((item: any) => ({
        source: 'lastfm', genre: String(item.name), level: 'recording',
        matchConfidence: 0.92, tagConfidence: tagStrength(item.count, maxCount)
      }));
    return putCache('lastfm', identity, { source: 'lastfm', configured: true, evidence });
  } catch (error) {
    return { source: 'lastfm', configured: true, evidence: [], error: error instanceof Error ? error.message : 'Last.fm lookup failed' };
  }
}

export async function audioDbEvidence(identity: TrackIdentity): Promise<SourceResult> {
  const apiKey = process.env.THEAUDIODB_API_KEY?.trim() || '123';
  const hit = cached('theaudiodb', identity);
  if (hit) return hit;
  try {
    let url: string;
    if (identity.mbid) {
      url = `https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(apiKey)}/track-mb.php?i=${encodeURIComponent(identity.mbid)}`;
    } else {
      const params = new URLSearchParams({ s: identity.artist, t: identity.title });
      url = `https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(apiKey)}/searchtrack.php?${params.toString()}`;
    }
    const data = await fetchJson(url);
    const track = Array.isArray(data?.track) ? data.track[0] : null;
    if (!track) return putCache('theaudiodb', identity, { source: 'theaudiodb', configured: true, evidence: [], matched: null });

    const evidence: GenreEvidence[] = [];
    for (const genre of [track.strGenre, track.strStyle]) {
      if (!genre) continue;
      for (const label of String(genre).split(/[,;/]/).map(value => value.trim()).filter(Boolean)) {
        evidence.push({ source: 'theaudiodb', genre: label, level: 'recording', matchConfidence: identity.mbid ? 1 : 0.82, tagConfidence: 0.9 });
      }
    }
    return putCache('theaudiodb', identity, {
      source: 'theaudiodb', configured: true, evidence,
      matched: { idTrack: track.idTrack || null, mbid: track.strMusicBrainzID || null }
    });
  } catch (error) {
    return { source: 'theaudiodb', configured: true, evidence: [], error: error instanceof Error ? error.message : 'TheAudioDB lookup failed' };
  }
}

export async function wikidataEvidence(identity: TrackIdentity): Promise<SourceResult> {
  if (!identity.mbid && !identity.isrc) return { source: 'wikidata', configured: true, evidence: [] };
  const hit = cached('wikidata', identity);
  if (hit) return hit;
  try {
    const property = identity.mbid ? 'P4404' : 'P1243';
    const identifier = String(identity.mbid || identity.isrc || '').replace(/"/g, '');
    const query = `SELECT ?item ?genre ?genreLabel WHERE { ?item wdt:${property} "${identifier}"; wdt:P136 ?genre. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 20`;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
    const data = await fetchJson(url, {}, 15_000);
    const bindings = Array.isArray(data?.results?.bindings) ? data.results.bindings : [];
    const labels = [...new Set(bindings.map((row: any) => String(row?.genreLabel?.value || '').trim()).filter(Boolean))];
    const evidence: GenreEvidence[] = labels.map(label => ({
      source: 'wikidata', genre: label, level: 'recording', matchConfidence: 1, tagConfidence: 0.86
    }));
    return putCache('wikidata', identity, { source: 'wikidata', configured: true, evidence });
  } catch (error) {
    return { source: 'wikidata', configured: true, evidence: [], error: error instanceof Error ? error.message : 'Wikidata lookup failed' };
  }
}

export async function discogsEvidence(identity: TrackIdentity): Promise<SourceResult> {
  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!token) return { source: 'discogs', configured: false, evidence: [] };
  const hit = cached('discogs', identity);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({ q: `${identity.artist} ${identity.title}`, type: 'release', per_page: '5', page: '1' });
    const data = await fetchJson(`https://api.discogs.com/database/search?${params.toString()}`, {
      headers: { Authorization: `Discogs token=${token}` }
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    const top = results[0];
    if (!top) return putCache('discogs', identity, { source: 'discogs', configured: true, evidence: [], matched: null });

    const combined = [
      ...(Array.isArray(top.genre) ? top.genre.map((genre: string) => ({ genre, strength: 0.78 })) : []),
      ...(Array.isArray(top.style) ? top.style.map((genre: string) => ({ genre, strength: 0.96 })) : [])
    ];
    const titleMatch = normalize(top.title).includes(normalize(identity.artist)) ? 0.88 : 0.72;
    const evidence: GenreEvidence[] = combined
      .filter(item => likelyGenreTag(item.genre))
      .map(item => ({ source: 'discogs', genre: item.genre, level: 'release', matchConfidence: titleMatch, tagConfidence: item.strength }));
    return putCache('discogs', identity, { source: 'discogs', configured: true, evidence, matched: { id: top.id || null, title: top.title || null } });
  } catch (error) {
    return { source: 'discogs', configured: true, evidence: [], error: error instanceof Error ? error.message : 'Discogs lookup failed' };
  }
}

export function callerEvidence(identity: TrackIdentity): SourceResult[] {
  const results: SourceResult[] = [];
  if (identity.appleGenres?.length) {
    results.push({
      source: 'apple-music', configured: true,
      evidence: identity.appleGenres.filter(Boolean).map(genre => ({ source: 'apple-music', genre, level: 'recording', matchConfidence: 1, tagConfidence: 0.9 }))
    });
  }
  if (identity.allMusicGenres?.length) {
    results.push({
      source: 'allmusic', configured: true,
      evidence: identity.allMusicGenres.filter(Boolean).map(genre => ({ source: 'allmusic', genre, level: 'recording', matchConfidence: 1, tagConfidence: 0.96 }))
    });
  }
  return results;
}

export async function collectGenreEvidence(identity: TrackIdentity) {
  const sourceResults = await Promise.all([
    musicBrainzEvidence(identity),
    discogsEvidence(identity),
    lastFmEvidence(identity),
    audioDbEvidence(identity),
    wikidataEvidence(identity)
  ]);
  sourceResults.push(...callerEvidence(identity));
  return sourceResults;
}
