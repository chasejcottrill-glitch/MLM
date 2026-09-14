import { useEffect, useMemo, useRef, useState } from 'react';
import { artworkUrl, type PlaybackSnapshot } from '../lib/musickit';

type Mode = 'music' | 'microphone';

export default function Visualizer({ playback }: { playback: PlaybackSnapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<Mode>('music');
  const [micError, setMicError] = useState('');

  const seed = useMemo(() => {
    const text = `${playback.item?.attributes?.name || ''}:${playback.item?.attributes?.artistName || ''}`;
    return [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 2166136261);
  }, [playback.item]);

  useEffect(() => {
    if (mode !== 'microphone') {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      analyserRef.current = null;
      return;
    }
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (cancelled) return stream.getTracks().forEach(track => track.stop());
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      streamRef.current = stream;
      analyserRef.current = analyser;
      setMicError('');
    }).catch(error => setMicError(error instanceof Error ? error.message : 'Microphone unavailable'));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      analyserRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    let raf = 0;
    const bins = new Uint8Array(128);

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      let energy = playback.state ? 0.58 : 0.22;
      if (mode === 'microphone' && analyserRef.current) {
        analyserRef.current.getByteFrequencyData(bins);
        energy = bins.reduce((a, b) => a + b, 0) / bins.length / 255;
      } else if (playback.currentTime) {
        energy = 0.4 + 0.2 * Math.sin(playback.currentTime * 2.1);
      }

      const count = 90;
      for (let i = 0; i < count; i++) {
        const a = i * 2.399963 + frame * (0.0018 + energy * 0.003);
        const wave = Math.sin(a * 2.3 + frame * 0.012 + seed * 0.000001);
        const radius = (0.11 + (i / count) * 0.43 + wave * 0.025 * energy) * Math.min(w, h);
        const x = w / 2 + Math.cos(a) * radius;
        const y = h / 2 + Math.sin(a) * radius * 0.68;
        const size = (2 + energy * 9 + (i % 7)) * dpr;
        const hue = (seed % 360 + i * 2.4 + frame * 0.04) % 360;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${hue}, 78%, ${55 + energy * 20}%, ${0.18 + energy * 0.42})`;
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      frame += 1;
      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [mode, playback.currentTime, playback.state, seed]);

  const art = artworkUrl(playback.item, 1400);
  return (
    <section className="visualizer-shell" style={art ? { backgroundImage: `linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.74)), url(${art})` } : undefined}>
      <canvas ref={canvasRef} className="visualizer-canvas" />
      <div className="visualizer-overlay">
        <div className="mode-switch" role="group" aria-label="Visualizer mode">
          <button className={mode === 'music' ? 'active' : ''} onClick={() => setMode('music')}>Apple Music</button>
          <button className={mode === 'microphone' ? 'active' : ''} onClick={() => setMode('microphone')}>Microphone</button>
        </div>
        <div className="now-playing">
          <strong>{playback.item?.attributes?.name || 'Nothing playing'}</strong>
          <span>{playback.item?.attributes?.artistName || 'Start a track in this player'}</span>
        </div>
        {micError && <div className="status error">{micError}</div>}
      </div>
    </section>
  );
}
