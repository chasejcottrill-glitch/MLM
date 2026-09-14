import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';
import { MusicKit as NodeMusicKit } from 'node-musickit-api';

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
  res.json({ ok: true, musicKitConfigured: Boolean(credentials()) });
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

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Genre Organizer + Visualizer listening on :${port}`);
});
