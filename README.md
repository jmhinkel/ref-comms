# Ref Comms

Phone-based radio for rugby match officials. Open a web page, enter a match code, and the
referee, ARs, TMO and 4th official can all hear each other. No app install, no accounts, no hardware.

- **Audio goes phone-to-phone** (WebRTC, Opus codec, ~200 ms latency).
- **Open mic or push-to-talk**, chosen per person. Tap to mute in open-mic mode.
- **Listen-only seats** for assessors or coaches, with no mic.
- **QR code / share link** so the referee can get ARs joined in seconds.
- **Survives blips**: a reload takes back the same seat, and dropped links are re-dialled automatically.
- **Keeps the screen awake** (Wake Lock), so the browser isn't suspended.
- Up to 8 people per match.

## How it works

The site is fully static: HTML/CSS/JS in `public/`, plus one tiny Netlify function.

- **Matchmaking** uses the free [PeerJS](https://peerjs.com) cloud server. Each match code has 8 "seats"
  (`refcomms-v1-<CODE>-1` … `-8`). A phone claims the first free seat and rings the others.
- **Once phones are connected, PeerJS isn't needed.** If it goes down mid-match, connected officials keep talking,
  but a phone that drops can't rejoin until it's back.
- **`/config.json`** (`netlify/functions/config.mjs`) hands out your TURN relay credentials from Netlify
  environment variables. Without them, the app uses PeerJS's free best-effort relays.

## Deploy to Netlify

1. Push this folder to a GitHub repo.
2. In Netlify: **Add new site → Import an existing project → GitHub**, then pick the repo.
   The settings come from `netlify.toml`, so you don't need to change anything. Deploy.
3. Open the `https://….netlify.app` URL on your phone. Every push to GitHub redeploys automatically.

## TURN relay (recommended before relying on it at a match)

Phones on 4G/5G are often behind carrier NAT, which blocks direct connections, and a TURN server relays the audio.
PeerJS's free relays are a fallback with no guarantees. For match day, get your own credentials from
metered.ca or Cloudflare Calls (both have free tiers). A full match for a 4-person crew uses only a few hundred MB.

In Netlify, go to **Site configuration → Environment variables** and add the following, then redeploy:

```
TURN_URLS=turn:your.turn.host:3478,turns:your.turn.host:443
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

## Run locally

```bash
npm start
```

Then open http://localhost:3000; two browser tabs are enough to try it. There are no dependencies to install.
Phones need HTTPS for the mic. To test the local copy on a phone, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Match-day tips

- **Use earbuds or a Bluetooth earpiece.** If you use the phone speaker, the other officials will hear an echo.
- On iPhone, Safari stops the mic if the screen locks. The app keeps the screen on, but don't press the lock button.
  Turn on Low Power Mode and lower the brightness to save battery.
- Pick an unusual match code (the **New match** button does this). Anyone who has the code can join.
- Keyboard: on a laptop (for example in a TMO booth), Space is push-to-talk / mute.
