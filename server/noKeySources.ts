import type { GenreEvidence } from './genreEvidence.js';
import type { SourceResult, TrackIdentity } from './genreSources.js';

const USER_AGENT = process.env.METADATA_USER_AGENT?.trim() || 'GenreOrganizerVisualizer/0.1 (genre metadata research)';

type CacheEntry<T> = { expiresAt: number; value: T };
const cache = new Map<string, CacheEntry<any>>();
const TTL_MS = 1000 * 60 * 60 * 24 * 14;

function normalize(value: unknown) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 12_000) {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
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
  const value = await response.json();
  cache.set(url, { expiresAt: Date.now() + TTL_MS, value });
  if (cache.size > 10_000) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return value as any;
}

function storefrontCountry(storefront = 'us') {
  const value = storefront.trim().slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : 'US';
}

export async function iTunesCatalogSearch(term: string, storefront = 'us', limit = 10) {
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'song',
    country: storefrontCountry(storefront),
    limit: String(Math.max(1, Math.min(50, limit)))
  });
  const data = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`);
  return Array.isArray(data?.results) ? data.results : [];
}

export async function iTunesCatalogLookup(id: string, storefront = 'us') {
  const params = new URLSearchParams({
    id,
    entity: 'song',
    country: storefrontCountry(storefront)
  });
  const data = await fetchJson(`https://itunes.apple.com/lookup?${params.toString()}`);
  return Array.isArray(data?.results) ? data.results.find((item: any) => item?.wrapperType === 'track') || data.results[0] || null : null;
}

export async function applePublicGenreEvidence(identity: TrackIdentity): Promise<SourceResult> {
  if (!identity.title || !identity.artist) return { source: 'apple-music', configured: true, evidence: [] };
  try {
    const results = await iTunesCatalogSearch(`${identity.artist} ${identity.title}`, 'us', 8);
    const titleKey = normalize(identity.title);
    const artistKey = normalize(identity.artist);
    const albumKey = normalize(identity.album);
    const scored = results.map((item: any) => {
      const title = normalize(item?.trackName);
      const artist = normalize(item?.artistName);
      const album = normalize(item?.collectionName);
      let score = 0;
      if (title === titleKey) score += 0.55;
      else if (title.includes(titleKey) || titleKey.includes(title)) score += 0.35;
      if (artist === artistKey) score += 0.35;
      else if (artist.includes(artistKey) || artistKey.includes(artist)) score += 0.2;
      if (albumKey && album === albumKey) score += 0.1;
      return { item, score };
    }).sort((a: any, b: any) => b.score - a.score);

    const top = scored[0];
    if (!top || top.score < 0.55 || !top.item?.primaryGenreName) {
      return { source: 'apple-music', configured: true, evidence: [], matched: null };
    }

    const evidence: GenreEvidence[] = [{
      source: 'apple-music',
      genre: String(top.item.primaryGenreName),
      level: 'recording',
      matchConfidence: Math.max(0.6, Math.min(0.9, top.score)),
      tagConfidence: 0.76
    }];

    return {
      source: 'apple-music',
      configured: true,
      evidence,
      matched: {
        mode: 'itunes-search-public-fallback',
        trackId: top.item.trackId || null,
        title: top.item.trackName || null,
        artist: top.item.artistName || null,
        album: top.item.collectionName || null,
        previewUrl: top.item.previewUrl || null,
        score: top.score
      }
    };
  } catch (error) {
    return { source: 'apple-music', configured: true, evidence: [], error: error instanceof Error ? error.message : 'Apple public catalog lookup failed' };
  }
}

function discogsTarget(relations: any[]) {
  for (const relation of relations || []) {
    const resource = String(relation?.url?.resource || relation?.target || '');
    let match = resource.match(/discogs\.com\/(?:[^/]+\/)?release\/(\d+)/i);
    if (match) return { type: 'release' as const, id: match[1], resource };
    match = resource.match(/discogs\.com\/(?:[^/]+\/)?master\/(\d+)/i);
    if (match) return { type: 'master' as const, id: match[1], resource };
  }
  return null;
}

export async function discogsPublicEvidence(identity: TrackIdentity): Promise<SourceResult> {
  if (!identity.mbid) return { source: 'discogs', configured: true, evidence: [] };
  try {
    // MusicBrainz may store a direct Discogs URL relationship for the exact recording.
    // This avoids Discogs database search, which requires authentication.
    const mbUrl = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(identity.mbid)}?inc=url-rels&fmt=json`;
    const recording = await fetchJson(mbUrl, {}, 15_000);
    const target = discogsTarget(Array.isArray(recording?.relations) ? recording.relations : []);
    if (!target) return { source: 'discogs', configured: true, evidence: [], matched: null };

    const endpoint = target.type === 'release'
      ? `https://api.discogs.com/releases/${target.id}`
      : `https://api.discogs.com/masters/${target.id}`;
    const data = await fetchJson(endpoint, {}, 15_000);
    const combined = [
      ...(Array.isArray(data?.genres) ? data.genres.map((genre: string) => ({ genre, strength: 0.78 })) : []),
      ...(Array.isArray(data?.styles) ? data.styles.map((genre: string) => ({ genre, strength: 0.94 })) : [])
    ];
    const evidence: GenreEvidence[] = combined.map(item => ({
      source: 'discogs',
      genre: String(item.genre),
      level: 'release',
      matchConfidence: 0.94,
      tagConfidence: item.strength
    }));

    return {
      source: 'discogs',
      configured: true,
      evidence,
      matched: {
        mode: 'musicbrainz-discogs-public-link',
        type: target.type,
        id: target.id,
        resource: target.resource,
        title: data?.title || null
      }
    };
  } catch (error) {
    return { source: 'discogs', configured: true, evidence: [], error: error instanceof Error ? error.message : 'Discogs public fallback failed' };
  }
}
