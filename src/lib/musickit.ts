export type AppleMusicSong = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    genreNames?: string[];
    isrc?: string;
    artwork?: { url?: string; width?: number; height?: number };
    playParams?: { id?: string; kind?: string; isLibrary?: boolean; catalogId?: string };
  };
};

export type PlaybackSnapshot = {
  item: any | null;
  state: number | string | null;
  currentTime: number;
  duration: number;
};

declare global {
  interface Window {
    MusicKit: any;
  }
}

let initPromise: Promise<any> | null = null;

async function waitForMusicKit(timeoutMs = 12000) {
  const started = Date.now();
  while (!window.MusicKit) {
    if (Date.now() - started > timeoutMs) throw new Error('MusicKit JS failed to load');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return window.MusicKit;
}

export function musicKitInstance() {
  if (!window.MusicKit) return null;
  try {
    return window.MusicKit.getInstance();
  } catch {
    return null;
  }
}

export async function initializeMusicKit() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const MusicKit = await waitForMusicKit();
    const response = await fetch('/api/musickit/developer-token');
    const body = await response.json();
    if (!response.ok || !body.developerToken) {
      throw new Error(body.error || 'MusicKit credentials are not configured');
    }
    await MusicKit.configure({
      developerToken: body.developerToken,
      app: { name: 'Genre Organizer + Visualizer', build: '0.1.0' }
    });
    return MusicKit.getInstance();
  })();
  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

export async function authorizeMusicKit() {
  const music = await initializeMusicKit();
  await music.authorize();
  return music;
}

export function artworkUrl(item: any, size = 1200) {
  const template = item?.attributes?.artwork?.url || item?.artworkURL || '';
  return String(template).replace('{w}', String(size)).replace('{h}', String(size));
}

function apiHeaders(music: any) {
  if (!music?.developerToken) throw new Error('Missing MusicKit developer token');
  if (!music?.musicUserToken) throw new Error('Sign in to Apple Music first');
  return {
    Authorization: `Bearer ${music.developerToken}`,
    'Music-User-Token': String(music.musicUserToken),
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

async function appleFetch(pathOrUrl: string, init: RequestInit = {}) {
  const music = musicKitInstance();
  if (!music) throw new Error('MusicKit is not initialized');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.music.apple.com${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: { ...apiHeaders(music), ...(init.headers || {}) }
  });
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch { detail = await response.text(); }
    throw new Error(`Apple Music API ${response.status}: ${detail || response.statusText}`);
  }
  if (response.status === 204 || response.status === 202) return null;
  return response.json();
}

export async function fetchAllLibrarySongs(onProgress?: (count: number) => void) {
  const songs: AppleMusicSong[] = [];
  let next: string | null = '/v1/me/library/songs?limit=100&include=catalog';
  while (next) {
    const page: any = await appleFetch(next);
    songs.push(...(page?.data || []));
    onProgress?.(songs.length);
    next = page?.next || null;
  }
  return songs;
}

export async function fetchLibraryPlaylists() {
  const playlists: any[] = [];
  let next: string | null = '/v1/me/library/playlists?limit=100';
  while (next) {
    const page: any = await appleFetch(next);
    playlists.push(...(page?.data || []));
    next = page?.next || null;
  }
  return playlists;
}

export async function fetchPlaylistTracks(playlistId: string, onProgress?: (count: number) => void) {
  const songs: AppleMusicSong[] = [];
  let next: string | null = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&include=catalog`;
  while (next) {
    const page: any = await appleFetch(next);
    songs.push(...(page?.data || []));
    onProgress?.(songs.length);
    next = page?.next || null;
  }
  return songs;
}

export async function createPlaylist(name: string, description: string, tracks: Array<{ id: string; type?: string }> = []) {
  const body: any = { attributes: { name, description } };
  if (tracks.length) {
    body.relationships = {
      tracks: { data: tracks.map(track => ({ id: track.id, type: track.type || 'library-songs' })) }
    };
  }
  return appleFetch('/v1/me/library/playlists', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export async function addTracksToPlaylist(playlistId: string, tracks: Array<{ id: string; type?: string }>) {
  if (!tracks.length) return;
  const chunks: typeof tracks[] = [];
  for (let i = 0; i < tracks.length; i += 100) chunks.push(tracks.slice(i, i + 100));
  for (const chunk of chunks) {
    await appleFetch(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      body: JSON.stringify({
        data: chunk.map(track => ({ id: track.id, type: track.type || 'library-songs' }))
      })
    });
  }
}

export function subscribeToPlayback(listener: (snapshot: PlaybackSnapshot) => void) {
  const music = musicKitInstance();
  const MusicKit = window.MusicKit;
  if (!music || !MusicKit) return () => {};

  const emit = () => listener({
    item: music.nowPlayingItem || music.player?.nowPlayingItem || null,
    state: music.playbackState ?? music.player?.playbackState ?? null,
    currentTime: Number(music.currentPlaybackTime ?? music.player?.currentPlaybackTime ?? 0),
    duration: Number(music.currentPlaybackDuration ?? music.player?.currentPlaybackDuration ?? 0)
  });

  const events = [
    MusicKit.Events?.mediaItemDidChange,
    MusicKit.Events?.playbackStateDidChange,
    MusicKit.Events?.playbackTimeDidChange
  ].filter(Boolean);

  events.forEach((event: any) => music.addEventListener(event, emit));
  emit();
  return () => events.forEach((event: any) => music.removeEventListener(event, emit));
}
