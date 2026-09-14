import {
  addTracksToPlaylist,
  authorizeMusicKit,
  createPlaylist,
  fetchLibraryPlaylists,
  fetchPlaylistTracks,
  musicKitInstance,
  subscribeToPlayback,
  type AppleMusicSong,
  type PlaybackSnapshot
} from './musickit';

export type MusicAppSong = AppleMusicSong;

export type MusicAppPlaylist = {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    description?: { standard?: string; short?: string } | string;
    artwork?: { url?: string; width?: number; height?: number };
    canEdit?: boolean;
    playParams?: { id?: string; kind?: string; isLibrary?: boolean };
  };
};

export type MusicAppOverrideData = {
  authorized?: boolean;
  playlists?: MusicAppPlaylist[];
  playlistTracks?: Record<string, MusicAppSong[]>;
  playback?: PlaybackSnapshot;
};

const OVERRIDE_KEY = 'genre-organizer.music-app-override.v1';

function readOverride(): MusicAppOverrideData | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return raw ? JSON.parse(raw) as MusicAppOverrideData : null;
  } catch {
    return null;
  }
}

function writeOverride(data: MusicAppOverrideData) {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(data));
}

export function providerMode(): 'override' | 'musickit' {
  return readOverride() ? 'override' : 'musickit';
}

export function installOverrideData(data: MusicAppOverrideData) {
  writeOverride({
    authorized: data.authorized ?? true,
    playlists: data.playlists || [],
    playlistTracks: data.playlistTracks || {},
    playback: data.playback
  });
}

export function clearOverrideData() {
  localStorage.removeItem(OVERRIDE_KEY);
}

export function exportOverrideData() {
  return readOverride();
}

export async function connectMusicProvider() {
  const override = readOverride();
  if (override) return { authorized: override.authorized !== false, mode: 'override' as const };
  const music = await authorizeMusicKit();
  return { authorized: Boolean(music.isAuthorized ?? music.musicUserToken), mode: 'musickit' as const };
}

export async function listProviderPlaylists(): Promise<MusicAppPlaylist[]> {
  const override = readOverride();
  if (override) return override.playlists || [];
  return fetchLibraryPlaylists();
}

export async function loadProviderPlaylistTracks(playlistId: string, onProgress?: (count: number) => void): Promise<MusicAppSong[]> {
  const override = readOverride();
  if (override) {
    const songs = override.playlistTracks?.[playlistId] || [];
    onProgress?.(songs.length);
    return songs;
  }
  return fetchPlaylistTracks(playlistId, onProgress);
}

export async function createProviderPlaylist(name: string, description: string, tracks: Array<{ id: string; type?: string }>) {
  const override = readOverride();
  if (!override) return createPlaylist(name, description, tracks);

  const id = `override-playlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const playlist: MusicAppPlaylist = {
    id,
    type: 'library-playlists',
    attributes: { name, description, canEdit: true }
  };
  const knownSongs = Object.values(override.playlistTracks || {}).flat();
  const selected = tracks
    .map(track => knownSongs.find(song => song.id === track.id))
    .filter((song): song is MusicAppSong => Boolean(song));

  const next: MusicAppOverrideData = {
    ...override,
    playlists: [...(override.playlists || []), playlist],
    playlistTracks: { ...(override.playlistTracks || {}), [id]: selected }
  };
  writeOverride(next);
  return { data: [playlist] };
}

export async function addProviderTracksToPlaylist(playlistId: string, tracks: Array<{ id: string; type?: string }>) {
  const override = readOverride();
  if (!override) return addTracksToPlaylist(playlistId, tracks);

  const knownSongs = Object.values(override.playlistTracks || {}).flat();
  const existing = override.playlistTracks?.[playlistId] || [];
  const additions = tracks
    .map(track => knownSongs.find(song => song.id === track.id))
    .filter((song): song is MusicAppSong => Boolean(song));
  const deduped = [...existing];
  for (const song of additions) if (!deduped.some(item => item.id === song.id)) deduped.push(song);
  writeOverride({
    ...override,
    playlistTracks: { ...(override.playlistTracks || {}), [playlistId]: deduped }
  });
}

export function subscribeProviderPlayback(listener: (snapshot: PlaybackSnapshot) => void) {
  const override = readOverride();
  if (override) {
    listener(override.playback || { item: null, state: null, currentTime: 0, duration: 0 });
    return () => {};
  }
  return subscribeToPlayback(listener);
}

export async function providerPlaybackAction(action: 'play' | 'pause' | 'next' | 'previous') {
  const override = readOverride();
  if (override) return;
  const music = musicKitInstance();
  if (!music) return;
  if (action === 'play') await (music.play?.() ?? music.player?.play?.());
  if (action === 'pause') await (music.pause?.() ?? music.player?.pause?.());
  if (action === 'next') await (music.skipToNextItem?.() ?? music.player?.skipToNextItem?.());
  if (action === 'previous') await (music.skipToPreviousItem?.() ?? music.player?.skipToPreviousItem?.());
}
