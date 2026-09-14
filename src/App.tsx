import { useEffect, useState } from 'react';
import Visualizer from './components/Visualizer';
import {
  authorizeMusicKit,
  fetchAllLibrarySongs,
  initializeMusicKit,
  musicKitInstance,
  subscribeToPlayback,
  type AppleMusicSong,
  type PlaybackSnapshot
} from './lib/musickit';

const emptyPlayback: PlaybackSnapshot = { item: null, state: null, currentTime: 0, duration: 0 };

type View = 'visualizer' | 'organizer';

export default function App() {
  const [view, setView] = useState<View>('visualizer');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [playback, setPlayback] = useState<PlaybackSnapshot>(emptyPlayback);
  const [songs, setSongs] = useState<AppleMusicSong[]>([]);
  const [libraryProgress, setLibraryProgress] = useState(0);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(data => setConfigured(Boolean(data.musicKitConfigured))).catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (!authorized) return;
    return subscribeToPlayback(setPlayback);
  }, [authorized]);

  async function connect() {
    setBusy(true);
    setStatus('');
    try {
      await initializeMusicKit();
      const music = await authorizeMusicKit();
      setAuthorized(Boolean(music.isAuthorized ?? music.musicUserToken));
      setStatus('Apple Music connected.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Apple Music connection failed');
    } finally {
      setBusy(false);
    }
  }

  async function syncLibrary() {
    setBusy(true);
    setStatus('Loading Apple Music library…');
    try {
      const music = musicKitInstance();
      if (!music?.musicUserToken) await connect();
      const all = await fetchAllLibrarySongs(count => setLibraryProgress(count));
      setSongs(all);
      setStatus(`Loaded ${all.length.toLocaleString()} library tracks.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Library sync failed');
    } finally {
      setBusy(false);
    }
  }

  async function playbackAction(action: 'play' | 'pause' | 'next' | 'previous') {
    const music = musicKitInstance();
    if (!music) return;
    try {
      if (action === 'play') await (music.play?.() ?? music.player?.play?.());
      if (action === 'pause') await (music.pause?.() ?? music.player?.pause?.());
      if (action === 'next') await (music.skipToNextItem?.() ?? music.player?.skipToNextItem?.());
      if (action === 'previous') await (music.skipToPreviousItem?.() ?? music.player?.skipToPreviousItem?.());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Playback action failed');
    }
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <div className="eyebrow">Apple Music</div>
          <h1>Genre Organizer <span>+</span> Visualizer</h1>
        </div>
        <div className="header-actions">
          <span className={`dot ${authorized ? 'online' : ''}`} />
          <button className="connect" onClick={connect} disabled={busy || configured === false}>
            {authorized ? 'Connected' : configured === false ? 'MusicKit setup required' : busy ? 'Connecting…' : 'Connect Apple Music'}
          </button>
        </div>
      </header>

      <nav className="feature-nav" aria-label="Features">
        <button className={view === 'visualizer' ? 'selected' : ''} onClick={() => setView('visualizer')}>Visualizer</button>
        <button className={view === 'organizer' ? 'selected' : ''} onClick={() => setView('organizer')}>Genre Organizer</button>
      </nav>

      {configured === false && (
        <aside className="setup-card">
          <strong>MusicKit is wired in, but credentials are not configured yet.</strong>
          <span>Add APPLE_MUSICKIT_KEY_ID, APPLE_MUSICKIT_TEAM_ID and APPLE_MUSICKIT_PRIVATE_KEY in Railway. Optionally set MUSICKIT_ALLOWED_ORIGINS to the production URL.</span>
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
              <strong>{playback.item?.attributes?.name || 'Apple Music playback'}</strong>
              <span>{playback.item?.attributes?.artistName || 'Connect and start a track'}</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="organizer feature-panel">
          <div className="organizer-head">
            <div>
              <div className="eyebrow">MusicKit library source</div>
              <h2>Genre Organizer</h2>
              <p>Your Apple Music library is read through MusicKit, then the genre evidence engine can classify exact recordings and create genre playlists back in Apple Music.</p>
            </div>
            <button className="primary" onClick={syncLibrary} disabled={busy || configured === false}>{busy ? 'Working…' : 'Sync Library'}</button>
          </div>

          <div className="stats-grid">
            <div><strong>{songs.length.toLocaleString()}</strong><span>tracks loaded</span></div>
            <div><strong>{libraryProgress.toLocaleString()}</strong><span>sync progress</span></div>
            <div><strong>{songs.filter(s => s.attributes?.isrc).length.toLocaleString()}</strong><span>ISRCs available</span></div>
          </div>

          <div className="track-table">
            <div className="track-row track-header"><span>Track</span><span>Artist</span><span>Apple genre signal</span></div>
            {songs.slice(0, 100).map(song => (
              <div className="track-row" key={`${song.type}:${song.id}`}>
                <span>{song.attributes?.name || 'Unknown'}</span>
                <span>{song.attributes?.artistName || 'Unknown'}</span>
                <span>{song.attributes?.genreNames?.join(', ') || '—'}</span>
              </div>
            ))}
            {!songs.length && <div className="empty-state">Connect Apple Music, then sync your library.</div>}
          </div>
        </section>
      )}

      {status && <div className="toast">{status}</div>}
    </main>
  );
}
