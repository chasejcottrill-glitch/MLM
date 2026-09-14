# Genre Organizer + Visualizer

Single-user Windows-focused Apple Music companion with two top-level features:

1. **Visualizer** — Apple Music playback-aware visuals plus Windows system-audio loopback and microphone-reactive modes.
2. **Genre Organizer** — MusicKit-backed Apple Music library/playlist management with multi-source genre research and confidence scoring.

## Windows-first architecture

The primary target is Windows 10/11 for one user. The hosted Railway service remains the backend and web UI, while the optional Electron shell provides Windows-native system-audio loopback for the visualizer.

The Electron shell uses Electron's supported desktop-capture loopback path to analyze already-rendered Windows system audio in real time. It does **not** decrypt, extract, save, or bypass Apple Music's protected audio stream.

## Run the Windows desktop shell

From the repository:

```powershell
cd desktop
npm install
npm start
```

The desktop shell opens the production Railway app and enables the **System Audio** visualizer mode. Start playback in the Apple Music Windows app, select **System Audio**, and the particle visualizer will react to the Windows output mix.

To build a Windows installer:

```powershell
cd desktop
npm install
npm run package
```

The installer is produced by electron-builder using NSIS.

## MusicKit requirements

This project is intended for personal use, but Apple Music library access, playlist creation/modification, and MusicKit playback still require Apple's supported authentication flow. Configure these server-side variables in Railway when available:

- `APPLE_MUSICKIT_KEY_ID`
- `APPLE_MUSICKIT_TEAM_ID`
- `APPLE_MUSICKIT_PRIVATE_KEY`
- `MUSICKIT_ALLOWED_ORIGINS`

The user's Music User Token is obtained through MusicKit authorization in the app rather than stored in source control.

## Genre evidence sources

The organizer combines evidence from MusicBrainz, Wikidata, TheAudioDB, optional Last.fm, optional Discogs, Apple Music genre metadata, compliant AllMusic evidence, and optional Genre Guru acoustic adjudication. Source power is weighted by provenance and evidence granularity instead of treating all databases equally.

## Hosted app

Production URL:

`https://genre-organizer-visualizer-production.up.railway.app`
