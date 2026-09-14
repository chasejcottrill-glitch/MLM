type GenreGuruResult = {
  result?: {
    primary_genre?: { genre?: string; confidence?: number };
    secondary_genres?: Array<{ genre?: string; confidence?: number }>;
    vibe_vector?: Record<string, number>;
    instruments?: { detected?: string[] };
    description?: string;
    sonic_dna?: string;
    similar_artists?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type CachedValue = { expiresAt: number; value: GenreGuruResult };

const cache = new Map<string, CachedValue>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_CACHE_ENTRIES = 5000;
const GENRE_GURU_URL = 'https://genreguru.com/analyze';

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function genreGuruConfigured() {
  return Boolean(process.env.GENREGURU_ANTHROPIC_API_KEY?.trim());
}

export function genreGuruEvidencePower(rawConfidence: unknown) {
  const confidence = Math.max(0, Math.min(1, Number(rawConfidence) || 0));
  // Model-reported confidence is not the same thing as measured calibration.
  // Until we have our own benchmark, cap the acoustic source at 0.80 power.
  return Math.min(0.8, 0.35 + confidence * 0.5);
}

export async function analyzeWithGenreGuru(options: {
  cacheKey: string;
  audio: ArrayBuffer;
  filename?: string;
  mimeType?: string;
  profile?: string;
}) {
  const apiKey = process.env.GENREGURU_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('Genre Guru is not configured');

  pruneCache();
  const existing = cache.get(options.cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return { ...existing.value, cached: true };
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([options.audio], { type: options.mimeType || 'audio/mp4' }),
    options.filename || 'apple-music-preview.m4a'
  );
  form.append('api_key', apiKey);
  if (options.profile) form.append('profile', options.profile);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(GENRE_GURU_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Genre Guru ${response.status}: ${text.slice(0, 500)}`);
    }

    const value = (await response.json()) as GenreGuruResult;
    cache.set(options.cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });

    return { ...value, cached: false };
  } finally {
    clearTimeout(timeout);
  }
}
