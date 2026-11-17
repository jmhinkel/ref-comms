# Ref Comms

Phone-based radio for rugby match officials. Open a web page, enter a match code, and the
referee, ARs, TMO and 4th official can all hear each other. No app install, no accounts, no hardware.

- **Audio goes phone-to-phone** (WebRTC, Opus codec, ~200 ms latency).
- **Open mic or push-to-talk**, chosen per person and remembered per role. Tap to mute in open-mic mode.
- **ARs start in push-to-talk.** One press of the headset's play/pause button (for example on Shokz) opens the mic for
  5 seconds, then it mutes itself, so the referee isn't hearing crowd and wind from open AR mics all match.
- **Listen-only seats** for assessors or coaches, with no mic.
- **QR code / share link** so the referee can get ARs joined in seconds.
- **Survives blips**: a reload takes back the same seat, and dropped links are re-dialled automatically.
- **Keeps the screen awake** (Wake Lock), so the browser isn't suspended.
- Up to 8 people per match.

## Game list

The start screen lists today's and upcoming games, so officials can see their match is set up.

- **Referee:** tap **List a game**, then enter the teams, kickoff and ground. The app makes a 6-character match code.
  Give the code to your crew, or show the QR code after you join.
- **Everyone else:** tap the game, enter the code, and join. A wrong code is rejected. Too many wrong guesses lock that
  game for 15 minutes.
- The public list never shows the code or anyone's name. It only shows which roles are connected, for example
  **LIVE · REF AR1**.
- Only the phone that listed a game can remove it (share screen → **Remove from game list**). Removing it doesn't
  disconnect anyone. Games also drop off the list by themselves after the match.
- You can still join an unlisted match with just a code.

Games are stored in Netlify Blobs (`netlify/functions/lobby.mjs`, logic in `src/lobby.mjs`). Locally they're stored in `.data/`.
Run `npm test` for the lobby tests.

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
3. Open the `https://refcomms.netlify.app` URL on your phone. Every push to GitHub redeploys automatically.

## TURN relay (recommended before relying on it at a match)

Phones on 4G/5G are often behind carrier NAT, which blocks direct connections, and a TURN server relays the audio.
Without one, the app falls back to PeerJS's free shared relays, which come with no guarantees.

**Cloudflare (recommended, free for about 1,000 GB a month):**

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
2. Copy the **Turn Token ID** and **API Token** it shows you.
3. In Netlify, go to **Site configuration → Environment variables**, add the following, then redeploy:

```
CF_TURN_KEY_ID=...
CF_TURN_API_TOKEN=...
```

The Netlify function swaps these for short-lived relay credentials each time someone joins, so the key never reaches a phone.

**Any other TURN server** (for example metered.ca) uses fixed credentials instead:

```
TURN_URLS=turn:your.turn.host:3478,turns:your.turn.host:443
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

To check it's working, open the app, join, and tap the green **Connected** label. The summary should say `relays: Cloudflare`.

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
- **Turn Wi-Fi off during the match.** Clubhouse Wi-Fi drops out as you run to the far side of the pitch, and the switch
  to mobile data breaks the call for a few seconds. With Wi-Fi off, phones stay on mobile data all match.
- **Use Pocket mode instead of locking the phone.** On iPhone, Safari stops the mic if the screen locks. Pocket mode
  turns the screen black, ignores pocket taps, and keeps the call running. To unlock it, press and hold, then tap **Tap to unlock**.
- **If the app gets closed mid-match,** reopen it and tap **Rejoin match**. You go straight back into the same seat.
  Leave asks for confirmation, so it's hard to drop out by accident.
  **Don't use Low Power Mode**: it forces the screen to lock after 30 seconds. Lower the brightness to save battery instead.
- On Android, set Chrome's battery use to **Unrestricted** (Settings → Apps → Chrome → Battery), so Android doesn't
  throttle it mid-match.
- If audio is choppy or drops, tap the status label → **Copy log**. It records signal quality every 30 seconds.
- Pick an unusual match code (the **New match** button does this). Anyone who has the code can join.
- Keyboard: on a laptop (for example in a TMO booth), Space is push-to-talk / mute.
