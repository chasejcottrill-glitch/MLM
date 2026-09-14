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
const inFlight = new Map<string, Promise<GenreGuruResult & { cached: boolean }>>();
const CACHE_TTL_MS = Number(process.env.GENREGURU_CACHE_TTL_MS || 1000 * 60 * 60 * 24 * 90);
const MAX_CACHE_ENTRIES = Number(process.env.GENREGURU_MAX_CACHE_ENTRIES || 10_000);
const GENRE_GURU_URL = 'https://genreguru.com/analyze';
const MAX_CONCURRENT = Math.max(1, Number(process.env.GENREGURU_MAX_CONCURRENT || 2));

let activeRequests = 0;
const waiters: Array<() => void> = [];

async function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>(resolve => waiters.push(resolve));
  activeRequests += 1;
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  waiters.shift()?.();
}

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

export function genreGuruAnalysisMode(profile?: string) {
  return profile ? 'profile-guided-single-classification' : 'auto-detect-two-pass';
}

export function genreGuruEvidencePower(rawConfidence: unknown) {
  const confidence = Math.max(0, Math.min(1, Number(rawConfidence) || 0));
  // Model-reported confidence is not a measured accuracy statistic. Keep Genre Guru
  // as corroborating acoustic evidence until we have a labelled calibration set.
  return Math.min(0.82, 0.35 + confidence * 0.52);
}

async function runGenreGuru(options: {
  audio: ArrayBuffer;
  filename?: string;
  mimeType?: string;
  profile?: string;
}) {
  const apiKey = process.env.GENREGURU_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('Genre Guru is not configured');

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

  await acquireSlot();
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

    return (await response.json()) as GenreGuruResult;
  } finally {
    clearTimeout(timeout);
    releaseSlot();
  }
}

export async function analyzeWithGenreGuru(options: {
  cacheKey: string;
  audio: ArrayBuffer;
  filename?: string;
  mimeType?: string;
  profile?: string;
}) {
  if (!genreGuruConfigured()) throw new Error('Genre Guru is not configured');

  pruneCache();
  const existing = cache.get(options.cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return { ...existing.value, cached: true };
  }

  const duplicate = inFlight.get(options.cacheKey);
  if (duplicate) return duplicate;

  const request = runGenreGuru(options)
    .then(value => {
      cache.set(options.cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return { ...value, cached: false };
    })
    .finally(() => {
      inFlight.delete(options.cacheKey);
    });

  inFlight.set(options.cacheKey, request);
  return request;
}
