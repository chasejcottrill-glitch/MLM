export type GenreSource =
  | 'allmusic'
  | 'discogs'
  | 'musicbrainz'
  | 'apple-music'
  | 'lastfm'
  | 'theaudiodb'
  | 'wikidata'
  | 'genre-guru';

export type EvidenceLevel = 'recording' | 'release' | 'artist' | 'acoustic';

export type GenreEvidence = {
  source: GenreSource;
  genre: string;
  level: EvidenceLevel;
  matchConfidence?: number;
  tagConfidence?: number;
  sourceReportedConfidence?: number;
};

export const SOURCE_RELIABILITY: Record<GenreSource, {
  power: number;
  automation: 'direct' | 'optional-key' | 'manual-or-licensed';
  note: string;
}> = {
  allmusic: {
    power: 0.95,
    automation: 'manual-or-licensed',
    note: 'Professional editorial genre/style evidence; no public automation path is assumed.'
  },
  discogs: {
    power: 0.86,
    automation: 'optional-key',
    note: 'Release-level community metadata with explicit broad genre and controlled style/subgenre fields.'
  },
  musicbrainz: {
    power: 0.80,
    automation: 'direct',
    note: 'Strong exact-recording identity via MBID/ISRC; genre/tag evidence is community supplied and count-ranked.'
  },
  'apple-music': {
    power: 0.70,
    automation: 'direct',
    note: 'Official catalog genre signal and strong recording identity, but genre labels can be broad.'
  },
  lastfm: {
    power: 0.66,
    automation: 'optional-key',
    note: 'Track tags are crowd supplied and ranked by tag count; useful as corroboration rather than sole authority.'
  },
  theaudiodb: {
    power: 0.60,
    automation: 'direct',
    note: 'Community metadata with track/album/artist genre fields and MusicBrainz-linked lookups.'
  },
  wikidata: {
    power: 0.58,
    automation: 'direct',
    note: 'Structured genre statements are useful corroboration, but granularity and sourcing vary by item.'
  },
  'genre-guru': {
    power: 0.72,
    automation: 'optional-key',
    note: 'Independent acoustic evidence; model confidence is capped because it is not a measured calibration statistic.'
  }
};

export const LEVEL_POWER: Record<EvidenceLevel, number> = {
  recording: 1,
  release: 0.86,
  artist: 0.55,
  acoustic: 0.92
};

function clamp01(value: unknown, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function evidencePower(evidence: GenreEvidence) {
  const source = SOURCE_RELIABILITY[evidence.source]?.power ?? 0.5;
  const level = LEVEL_POWER[evidence.level] ?? 0.5;
  const match = clamp01(evidence.matchConfidence, 1);
  const tag = clamp01(evidence.tagConfidence, 1);

  let reported = clamp01(evidence.sourceReportedConfidence, 1);
  if (evidence.source === 'genre-guru') {
    reported = Math.min(0.82, 0.35 + reported * 0.52);
  }

  return source * level * match * tag * reported;
}

function normalizeGenre(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function combineGenreEvidence(evidence: GenreEvidence[]) {
  const groups = new Map<string, { label: string; score: number; sources: Set<GenreSource>; items: GenreEvidence[] }>();

  for (const item of evidence) {
    const key = normalizeGenre(item.genre);
    if (!key) continue;
    const current = groups.get(key) || { label: item.genre.trim(), score: 0, sources: new Set<GenreSource>(), items: [] };
    current.score += evidencePower(item);
    current.sources.add(item.source);
    current.items.push(item);
    groups.set(key, current);
  }

  const ranked = [...groups.values()].sort((a, b) => b.score - a.score);
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const top = ranked[0];
  const runnerUp = ranked[1];

  if (!top || total <= 0) {
    return {
      genre: null,
      confidence: 0,
      interval90: [0, 0] as [number, number],
      sourceCount: 0,
      status: 'unclassified' as const,
      ranked: []
    };
  }

  const share = top.score / total;
  const margin = top.score - (runnerUp?.score || 0);
  const independentSources = top.sources.size;

  // Heuristic evidence confidence, not a claim of frequentist statistical calibration.
  // Agreement across independent sources tightens the interval; disagreement widens it.
  const agreementBonus = Math.min(0.18, Math.max(0, independentSources - 1) * 0.055);
  const marginBonus = Math.min(0.12, margin / Math.max(1, top.score + (runnerUp?.score || 0)) * 0.12);
  const confidence = Math.max(0, Math.min(0.99, share * 0.72 + agreementBonus + marginBonus));
  const width = Math.max(0.035, 0.18 - independentSources * 0.025 + (1 - share) * 0.12);
  const low = Math.max(0, confidence - width);
  const high = Math.min(0.99, confidence + width);

  return {
    genre: top.label,
    confidence,
    interval90: [low, high] as [number, number],
    sourceCount: independentSources,
    status: confidence >= 0.84 && independentSources >= 2
      ? 'auto-assign'
      : confidence >= 0.62
        ? 'review'
        : 'unclassified',
    ranked: ranked.map(item => ({
      genre: item.label,
      score: item.score,
      sources: [...item.sources]
    }))
  };
}
