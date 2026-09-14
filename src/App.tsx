import { useEffect, useMemo, useState } from 'react';
import Visualizer from './components/Visualizer';
import {
  clearOverrideData,
  connectMusicProvider,
  installOverrideData,
  listProviderPlaylists,
  loadProviderPlaylistTracks,
  providerMode,
  providerPlaybackAction,
  subscribeProviderPlayback,
  type MusicAppOverrideData,
  type MusicAppPlaylist,
  type MusicAppSong
} from './lib/musicProvider';
import type { PlaybackSnapshot } from './lib/musickit';

const emptyPlayback: PlaybackSnapshot = { item: null, state: null, currentTime: 0, duration: 0 };
type View = 'visualizer' | 'organizer';

function playlistName(playlist: MusicAppPlaylist) {
  return playlist.attributes?.name || `Playlist ${playlist.id}`;
}

export default function App() {
  const [view, setView] = useState<View>('visualizer');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [playback, setPlayback] = useState<PlaybackSnapshot>(emptyPlayback);
  const [playlists, setPlaylists] = useState<MusicAppPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [songs, setSongs] = useState<MusicAppSong[]>([]);
  const [playlistProgress, setPlaylistProgress] = useState(0);
  const [mode, setMode] = useState(providerMode());

  const selectedPlaylist = useMemo(
    () => playlists.find(playlist => playlist.id === selectedPlaylistId) || null,
    [playlists, selectedPlaylistId]
  );

  useEffect(() => {
    if (providerMode() === 'override') {
      setConfigured(true);
      return;
    }
    fetch('/api/health')
      .then(r => r.json())
      .then(data => setConfigured(Boolean(data.musicKitConfigured)))
      .catch(() => setConfigured(false));
  }, [mode]);

  useEffect(() => {
    if (!authorized) return;
    return subscribeProviderPlayback(setPlayback);
  }, [authorized, mode]);

  async function refreshPlaylists() {
    const items = await listProviderPlaylists();
    setPlaylists(items);
    setSelectedPlaylistId(current => current && items.some(item => item.id === current) ? current : (items[0]?.id || ''));
  }

  async function connect() {
    setBusy(true);
    setStatus('');
    try {
      const result = await connectMusicProvider();
      setAuthorized(result.authorized);
      setMode(result.mode);
      await refreshPlaylists();
      setStatus(result.mode === 'override' ? 'Override music source connected.' : 'Music provider connected.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Music provider connection failed');
    } finally {
      setBusy(false);
    }
  }

  async function loadPlaylist() {
    if (!selectedPlaylistId) return;
    setBusy(true);
    setSongs([]);
    setPlaylistProgress(0);
    setStatus(`Loading ${selectedPlaylist ? playlistName(selectedPlaylist) : 'playlist'}…`);
    try {
      const tracks = await loadProviderPlaylistTracks(selectedPlaylistId, count => setPlaylistProgress(count));
      setSongs(tracks);
      setStatus(`Loaded ${tracks.length.toLocaleString()} tracks from ${selectedPlaylist ? playlistName(selectedPlaylist) : 'playlist'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Playlist load failed');
    } finally {
      setBusy(false);
    }
  }

  async function playbackAction(action: 'play' | 'pause' | 'next' | 'previous') {
    try {
      await providerPlaybackAction(action);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Playback action failed');
    }
  }

  async function importOverride(file: File) {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as MusicAppOverrideData;
      installOverrideData(parsed);
      setMode('override');
      setConfigured(true);
      setAuthorized(parsed.authorized !== false);
      setSongs([]);
      setPlaylistProgress(0);
      await refreshPlaylists();
      setStatus('Override data loaded. The app is now using the MusicKit-compatible local data source.');
    } catch (error) {
      setStatus(error instanceof Error ? `Override import failed: ${error.message}` : 'Override import failed');
    } finally {
      setBusy(false);
    }
  }

  function removeOverride() {
    clearOverrideData();
    setMode('musickit');
    setAuthorized(false);
    setPlaylists([]);
    setSelectedPlaylistId('');
    setSongs([]);
    setStatus('Override data cleared.');
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <div className="eyebrow">{mode === 'override' ? 'Overrideable Music Source' : 'MusicKit-compatible provider'}</div>
          <h1>Genre Organizer <span>+</span> Visualizer</h1>
        </div>
        <div className="header-actions">
          <span className={`dot ${authorized ? 'online' : ''}`} />
          <button className="connect" onClick={connect} disabled={busy || (mode === 'musickit' && configured === false)}>
            {authorized ? 'Connected' : mode === 'musickit' && configured === false ? 'Provider setup required' : busy ? 'Connecting…' : 'Connect Music Source'}
          </button>
        </div>
      </header>

      <nav className="feature-nav" aria-label="Features">
        <button className={view === 'visualizer' ? 'selected' : ''} onClick={() => setView('visualizer')}>Visualizer</button>
        <button className={view === 'organizer' ? 'selected' : ''} onClick={() => setView('organizer')}>Genre Organizer</button>
      </nav>

      {mode === 'musickit' && configured === false && (
        <aside className="setup-card">
          <strong>The default MusicKit-compatible provider is not configured.</strong>
          <span>You can configure MusicKit credentials, or load override JSON using the same playlist/song resource shape.</span>
        </aside>
      )}

      {view === 'visualizer' ? (
        <section className="feature-panel">
          <Visualizer playback={playback} />
          <div className="player-bar">
            <button onClick={() => playbackAction('previous')} aria-label="Previous">↶</button>
            <button onClick={() => playbackAction('play')} aria-label="Play">▶</button>
            <button onClick={() => playbackAction('pause')} aria-label="Pause">Ⅱ</button>
            <button onClick={() => playbackAction('next')} aria-label="Next">↷</button>
            <div className="track-meta">
              <strong>{playback.item?.attributes?.name || 'Music playback'}</strong>
              <span>{playback.item?.attributes?.artistName || 'Connect a source or use system audio'}</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="organizer feature-panel">
          <div className="organizer-head">
            <div>
              <div className="eyebrow">Playlist sorting source</div>
              <h2>Genre Organizer</h2>
              <p>Select one playlist, load its tracks, then run genre classification against those exact recordings. The provider may be MusicKit or override data with the same resource properties.</p>
            </div>
            <div className="header-actions">
              <label className="connect">
                Load Override JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) void importOverride(file);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              {mode === 'override' && <button className="connect" onClick={removeOverride}>Clear Override</button>}
            </div>
          </div>

          <div className="organizer-head">
            <div style={{ flex: 1 }}>
              <div className="eyebrow">Choose playlist</div>
              <select
                value={selectedPlaylistId}
                onChange={event => setSelectedPlaylistId(event.target.value)}
                disabled={!playlists.length || busy}
                style={{ width: '100%', maxWidth: 520, padding: 12, borderRadius: 10 }}
              >
                {!playlists.length && <option value="">No playlists loaded</option>}
                {playlists.map(playlist => <option key={playlist.id} value={playlist.id}>{playlistName(playlist)}</option>)}
              </select>
            </div>
            <button className="primary" onClick={loadPlaylist} disabled={busy || !selectedPlaylistId}>{busy ? 'Working…' : 'Load Playlist'}</button>
          </div>

          <div className="stats-grid">
            <div><strong>{songs.length.toLocaleString()}</strong><span>tracks loaded</span></div>
            <div><strong>{playlistProgress.toLocaleString()}</strong><span>playlist progress</span></div>
            <div><strong>{songs.filter(s => s.attributes?.isrc).length.toLocaleString()}</strong><span>ISRCs available</span></div>
          </div>

          <div className="track-table">
            <div className="track-row track-header"><span>Track</span><span>Artist</span><span>Provider genre signal</span></div>
            {songs.slice(0, 100).map(song => (
              <div className="track-row" key={`${song.type}:${song.id}`}>
                <span>{song.attributes?.name || 'Unknown'}</span>
                <span>{song.attributes?.artistName || 'Unknown'}</span>
                <span>{song.attributes?.genreNames?.join(', ') || '—'}</span>
              </div>
            ))}
            {!songs.length && <div className="empty-state">Connect a source, choose a playlist, then load that playlist.</div>}
          </div>
        </section>
      )}

      {status && <div className="toast">{status}</div>}
    </main>
  );
}
