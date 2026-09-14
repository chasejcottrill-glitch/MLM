import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';
import { MusicKit as NodeMusicKit } from 'node-musickit-api';
import {
  analyzeWithGenreGuru,
  genreGuruAnalysisMode,
  genreGuruConfigured,
  genreGuruEvidencePower,
  getCachedGenreGuruAnalysis
} from './genreGuru.js';
import {
  combineGenreEvidence,
  LEVEL_POWER,
  SOURCE_RELIABILITY,
  type GenreEvidence
} from './genreEvidence.js';
import {
  collectGenreEvidenceParallel,
  getSourceAvailability,
  type TrackIdentity
} from './genreSources.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function credentials() {
  const keyId = process.env.APPLE_MUSICKIT_KEY_ID?.trim();
  const teamId = process.env.APPLE_MUSICKIT_TEAM_ID?.trim();
  const privateKey = process.env.APPLE_MUSICKIT_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!keyId || !teamId || !privateKey) return null;
  return { keyId, teamId, privateKey };
}

async function makeDeveloperToken() {
  const creds = credentials();
  if (!creds) throw new Error('MusicKit credentials are not configured');

  const key = await importPKCS8(creds.privateKey, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  const allowedOrigins = (process.env.MUSICKIT_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const claims: Record<string, unknown> = {
    iss: creds.teamId,
    iat: now,
    exp: now + 60 * 60 * 24 * 30
  };

  if (allowedOrigins.length) claims.origin = allowedOrigins;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: creds.keyId })
    .sign(key);
}

let nodeMusicKit: NodeMusicKit | null = null;
async function getNodeMusicKit() {
  const creds = credentials();
  if (!creds) throw new Error('MusicKit credentials are not configured');
  if (!nodeMusicKit) {
    nodeMusicKit = new NodeMusicKit({
      key: { id: creds.keyId, teamId: creds.teamId, p8: creds.privateKey }
    });
    await nodeMusicKit.auth();
  }
  return nodeMusicKit;
}

app.get('/api/health', (_req, res) => {
  const sources = getSourceAvailability();
  res.json({
    ok: true,
    musicKitConfigured: Boolean(credentials()),
    genreGuruConfigured: genreGuruConfigured(),
    genreGuruMode: 'selective-apple-preview-adjudication',
    genreGuruStrategy: 'profile-guided-when-known; auto-two-pass-fallback; ISRC-cache; in-flight-deduplication',
    sources: sources.map(src => ({
      source: src.source,
      configured: src.configured,
      automation: src.automation
    }))
  });
});

app.get('/api/genre/reliability', (_req, res) => {
  res.json({
    model: 'evidence-power-v1',
    warning: 'Power coefficients are provenance/granularity weights, not published database accuracy percentages.',
    sources: SOURCE_RELIABILITY,
    levels: LEVEL_POWER,
    thresholds: {
      autoAssign: 'confidence >= 0.84 and at least 2 independent sources',
      review: 'confidence >= 0.62',
      unclassified: 'below review threshold'
    }
  });
});

app.post('/api/genre/score', (req, res) => {
  const evidence = Array.isArray(req.body?.evidence) ? req.body.evidence as GenreEvidence[] : null;
  if (!evidence) return res.status(400).json({ error: 'evidence array is required' });
  if (evidence.length > 100) return res.status(413).json({ error: 'At most 100 evidence items are allowed per score request' });

  res.json(combineGenreEvidence(evidence));
});

app.post('/api/genre/research', async (req, res) => {
  try {
    // Validate input: require either mbid/isrc or title+artist
    const mbid = req.body?.mbid ? String(req.body.mbid).trim() : undefined;
    const isrc = req.body?.isrc ? String(req.body.isrc).trim() : undefined;
    const title = req.body?.title ? String(req.body.title).trim() : undefined;
    const artist = req.body?.artist ? String(req.body.artist).trim() : undefined;
    const album = req.body?.album ? String(req.body.album).trim() : undefined;
    const appleGenres = Array.isArray(req.body?.appleGenres) ? req.body.appleGenres.filter(Boolean) : undefined;
    const allMusicGenres = Array.isArray(req.body?.allMusicGenres) ? req.body.allMusicGenres.filter(Boolean) : undefined;

    if (!mbid && !isrc && (!title || !artist)) {
      return res.status(400).json({
        error: 'Either mbid/isrc or both title and artist are required'
      });
    }

    const identity: TrackIdentity = {
      title: title || '',
      artist: artist || '',
      ...(album ? { album } : {}),
      ...(isrc ? { isrc } : {}),
      ...(mbid ? { mbid } : {}),
      ...(appleGenres?.length ? { appleGenres } : {}),
      ...(allMusicGenres?.length ? { allMusicGenres } : {})
    };

    // Collect evidence: resolve MusicBrainz first, then parallel lookups
    const sourceResults = await collectGenreEvidenceParallel(identity);

    // Flatten all evidence
    const flattenedEvidence = sourceResults.flatMap(sr => sr.evidence);

    // Combine evidence and get final genre/confidence
    const combined = combineGenreEvidence(flattenedEvidence);

    res.json({
      query: identity,
      sourceResults: sourceResults.map(sr => ({
        source: sr.source,
        configured: sr.configured,
        evidence: sr.evidence,
        matched: sr.matched || undefined,
        error: sr.error || undefined
      })),
      flattenedEvidence,
      result: {
        genre: combined.genre,
        confidence: combined.confidence,
        interval90: combined.interval90,
        sourceCount: combined.sourceCount,
        status: combined.status,
        ranked: combined.ranked
      }
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Genre research failed'
    });
  }
});

app.get('/api/musickit/developer-token', async (_req, res) => {
  try {
    const developerToken = await makeDeveloperToken();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({ developerToken });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : 'MusicKit token unavailable',
      setupRequired: true
    });
  }
});

app.get('/api/musickit/catalog/search', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    const storefront = String(req.query.storefront || 'us').trim();
    if (!term) return res.status(400).json({ error: 'Missing q parameter' });
    const kit = await getNodeMusicKit();
    const result = await kit.search(storefront, {
      term,
      types: ['songs', 'albums', 'artists'],
      limit: 10
    });
    res.status(result.status || 200).json(result.data ?? { error: result.error });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Catalog search unavailable' });
  }
});

app.post('/api/genre-guru/analyze-catalog', async (req, res) => {
  try {
    if (!genreGuruConfigured()) {
      return res.status(503).json({ error: 'Genre Guru is not configured', setupRequired: true });
    }

    const storefront = String(req.body?.storefront || 'us').trim().toLowerCase();
    const catalogId = String(req.body?.catalogId || '').trim();
    const profile = req.body?.profile ? String(req.body.profile).trim() : undefined;
    if (!catalogId) return res.status(400).json({ error: 'catalogId is required' });

    const kit = await getNodeMusicKit();
    const songResponse = await kit.songs.get(storefront, catalogId, true);
    if (!songResponse.data) {
      return res.status(songResponse.status || 404).json({ error: songResponse.error || 'Apple catalog song not found' });
    }

    const raw: any = songResponse.data;
    const song = Array.isArray(raw?.data) ? raw.data[0] : raw?.data?.[0] ?? raw;
    const attributes = song?.attributes || {};
    const isrc = String(attributes?.isrc || '').trim().toUpperCase() || null;
    const cacheKey = isrc
      ? `isrc:${isrc}:${profile || 'auto'}`
      : `catalog:${storefront}:${catalogId}:${profile || 'auto'}`;

    const cached = getCachedGenreGuruAnalysis(cacheKey) as any;
    let analysis: any = cached;

    if (!analysis) {
      const previewUrl = attributes?.previews?.[0]?.url || attributes?.previews?.[0]?.hlsUrl;
      if (!previewUrl) {
        return res.status(422).json({ error: 'No Apple Music preview is available for this catalog song' });
      }

      const previewResponse = await fetch(previewUrl, { signal: AbortSignal.timeout(30_000) });
      if (!previewResponse.ok) {
        return res.status(502).json({ error: `Apple preview fetch failed with ${previewResponse.status}` });
      }

      const declaredBytes = Number(previewResponse.headers.get('content-length') || 0);
      if (declaredBytes > 20 * 1024 * 1024) {
        return res.status(413).json({ error: 'Preview asset is larger than the 20 MB analysis limit' });
      }

      const audio = await previewResponse.arrayBuffer();
      if (audio.byteLength > 20 * 1024 * 1024) {
        return res.status(413).json({ error: 'Preview asset is larger than the 20 MB analysis limit' });
      }

      analysis = await analyzeWithGenreGuru({
        cacheKey,
        audio,
        filename: `${isrc || catalogId}.m4a`,
        mimeType: previewResponse.headers.get('content-type') || 'audio/mp4',
        profile
      });
    }

    const primary = analysis?.result?.primary_genre;
    const rawConfidence = Number(primary?.confidence) || 0;

    res.json({
      source: 'Genre Guru',
      evidenceType: 'acoustic-analysis-of-apple-preview',
      catalogId,
      isrc,
      profile: profile || 'auto',
      analysisMode: genreGuruAnalysisMode(profile),
      primaryGenre: primary || null,
      secondaryGenres: analysis?.result?.secondary_genres || [],
      evidencePower: genreGuruEvidencePower(rawConfidence),
      rawModelConfidence: rawConfidence,
      cached: Boolean(analysis?.cached),
      result: analysis?.result || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Genre Guru analysis failed';
    const status = message.includes('aborted') || message.includes('timeout') ? 504 : 502;
    res.status(status).json({ error: message });
  }
});

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Genre Organizer + Visualizer listening on :${port}`);
});

