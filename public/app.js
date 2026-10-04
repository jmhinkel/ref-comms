// Ref Comms client: full-mesh WebRTC audio between a small crew of match officials.
// Matchmaking goes through the free PeerJS cloud server, so the site itself is fully static.
// Each match has 8 "seats" with predictable IDs; a phone claims a free seat and rings the rest.
// Once connected, audio goes phone-to-phone (or via TURN) and no longer needs PeerJS.
'use strict';

const $ = s => document.querySelector(s);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
const ID_PREFIX = 'refcomms-v1-';
const MAX_SLOTS = 8;
const SPEAKING_THRESHOLD = 0.035;
const HEARTBEAT_MS = 2000;
const STALE_MS = 7000;     // no word from a peer this long → show "signal lost"
const DROP_MS = 25000;     // ...this long → drop the link and wait for a redial
const RESCAN_MS = 12000;   // how often to look for officials we're not linked to
const HEADSET_TALK_MS = 5000; // push-to-talk via headset button: mic stays open this long
const WATCHDOG_MS = 5000;  // how often to check for (and repair) anything that has quietly stopped
const APP_VERSION = '2026-10-04';
const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
};

const state = {
  me: null,                // { name, role }
  room: null,
  slot: 0,
  myId: null,
  pj: null,                // PeerJS Peer
  netRetry: 0,
  reconnectTimer: null,
  claiming: false,
  timers: [],
  watchdog: null,
  micRecovering: false,
  lastCtxState: 'running',
  leaving: false,
  iceServers: null,        // null → PeerJS defaults (Google STUN + PeerJS's free TURN)
  localStream: null,
  localTrack: null,
  outStream: null,         // mic stream, or silence for listen-only seats
  mode: localStorage.getItem('rc.mode') || 'open',  // 'open' | 'ptt'
  muted: false,
  pttDown: false,
  burstUntil: 0,           // headset-triggered talk window (push-to-talk mode)
  burstTick: null,
  lastHeadset: 0,
  headsetSeen: null,       // last headset action received, shown so officials can test their buttons
  keepAlive: null,         // silent looping <audio> that keeps the page's media session active
  audioCtx: null,
  localAnalyser: null,
  wakeLock: null,
  peers: new Map(),        // peer id -> { id, info, dc, call, audio, analyser, speaking, lastSeen, stale }
  dialing: new Map(),      // peer id -> pending outgoing DataConnection
};

// ---------- utilities ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const seatId = slot => `${ID_PREFIX}${state.room}-${slot}`;
function makeCode(n = 4) {
  const buf = crypto.getRandomValues(new Uint8Array(n));
  return [...buf].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}
function roleAbbrev(role) {
  return { 'Referee': 'REF', 'AR 1': 'AR1', 'AR 2': 'AR2', '4th Official': '4TH', 'Assessor': 'ASR' }[role] || role.slice(0, 3).toUpperCase();
}
function shareUrl() { return `${location.origin}/?m=${state.room}`; }
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const nameOf = p => p.info?.name || `seat ${p.id.split('-').pop()}`;
const audioUp = p => p.call?.peerConnection?.connectionState === 'connected';

// Rolling connection log, viewable/copyable from the status pill, so a dropout can be diagnosed afterwards.
const logLines = [];
function note(msg) {
  logLines.push(`${new Date().toTimeString().slice(0, 8)}  ${msg}`);
  if (logLines.length > 500) logLines.shift();
  console.info('[ref-comms]', msg);
  if ($('#logDlg')?.open) renderLog();
}
function myInfo() { return { ...state.me, listenOnly: !state.localTrack, live: isTransmitting() }; }

// ---------- join screen ----------
function initJoin() {
  $('#name').value = localStorage.getItem('rc.name') || '';
  const savedRole = localStorage.getItem('rc.role');
  if (savedRole) $('#role').value = savedRole;
  const fromLink = new URLSearchParams(location.search).get('m');
  if (fromLink) $('#code').value = fromLink.toUpperCase();
  syncListenOnly();

  $('#role').addEventListener('change', syncListenOnly);
  $('#newCode').addEventListener('click', () => { $('#code').value = makeCode(); });
  $('#code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#joinForm').addEventListener('submit', e => { e.preventDefault(); join(); });

  if (!window.isSecureContext) {
    showJoinError('This page must be opened over HTTPS for the microphone to work.');
  } else if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    showJoinError('This browser doesn\'t support live audio. Use Safari (iPhone) or Chrome (Android).');
  } else if (!window.Peer) {
    showJoinError('Couldn\'t load the connection library. Check your internet connection and reload.');
  }
  showMicTip();
}

// Returning officials who keep getting the mic prompt: tell them how to make the browser remember it.
async function showMicTip() {
  if (!localStorage.getItem('rc.name') || !navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    const update = () => {
      const tip = $('#micTip');
      tip.hidden = status.state === 'granted';
      tip.textContent = status.state === 'denied'
        ? `The microphone is blocked for this site. ${micSettingsHelp()}`
        : `Tired of the microphone prompt every time? ${micSettingsHelp()}${isIOS ? '' : ' If Chrome asks, choose "Allow while visiting the site", not "Only this time".'}`;
    };
    update();
    status.onchange = update;
  } catch { /* Permissions API can't query the mic in this browser */ }
}
function syncListenOnly() {
  const opt = $('#role').selectedOptions[0];
  if (opt.hasAttribute('data-listen')) $('#listenOnly').checked = true;
}
function showJoinError(msg) { const el = $('#joinError'); el.textContent = msg; el.hidden = !msg; }

async function join() {
  showJoinError('');
  const name = $('#name').value.trim();
  const role = $('#role').value;
  const room = $('#code').value.trim().toUpperCase();
  const listenOnly = $('#listenOnly').checked;
  if (!name || !room) return;
  localStorage.setItem('rc.name', name);
  localStorage.setItem('rc.role', role);

  const btn = $('#joinForm button[type=submit]');
  btn.disabled = true; btn.textContent = 'Joining…';
  try {
    // AudioContext must be created inside the tap on iOS.
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx.resume();
    startHeadsetSupport(); // also needs the tap, so it goes before any await

    const cfg = await fetch('/config.json').then(r => r.json()).catch(() => null);
    if (cfg?.hasTurn) state.iceServers = cfg.iceServers;

    if (listenOnly) {
      state.outStream = state.audioCtx.createMediaStreamDestination().stream; // silence
    } else {
      useMicStream(await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS));
    }
  } catch (err) {
    stopHeadsetSupport();
    btn.disabled = false; btn.textContent = 'Join match';
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showJoinError(denied
      ? `Microphone permission was blocked. ${micSettingsHelp()} Or tick "Listen only".`
      : `Couldn't start the microphone (${err.message || err.name}).`);
    return;
  }
  note(`joined match ${room} as ${role} · app ${APP_VERSION} · ${state.iceServers ? 'own TURN' : 'PeerJS relays'} · ${navigator.userAgent}`);

  state.me = { name, role };
  state.room = room;
  history.replaceState(null, '', `/?m=${room}`);

  $('#join').hidden = true;
  $('#live').hidden = false;
  $('#codeLabel').textContent = room;
  if (window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: `Ref Comms · Match ${room}`, artist: `${name} · ${role}` });
  setupLiveControls();
  applyTransmit();
  requestWakeLock();
  requestAnimationFrame(meterLoop);
  state.watchdog = setInterval(watchdog, WATCHDOG_MS);
  claimSeat();
}

// ---------- microphone ----------
function useMicStream(stream) {
  const track = stream.getAudioTracks()[0];
  state.localStream = stream;
  state.localTrack = track;
  state.outStream = stream;
  state.localAnalyser = makeAnalyser(stream);
  track.addEventListener('ended', () => {
    note('microphone stopped by the system');
    if (!state.leaving) recoverMic();
  });
  track.addEventListener('mute', () => note('microphone paused by the system (call, Siri or another app?)'));
  track.addEventListener('unmute', () => note('microphone resumed'));
}

// Restart the mic in place and swap it into every live call — no page reload, so no new permission prompt
// on browsers that remember the grant for the session.
async function recoverMic() {
  if (state.micRecovering || state.leaving || !state.localTrack) return;
  state.micRecovering = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const old = state.localStream;
    useMicStream(stream);
    old?.getTracks().forEach(t => t.stop());
    for (const p of state.peers.values()) {
      for (const sender of p.call?.peerConnection?.getSenders() || []) {
        if (!sender.track || sender.track.kind === 'audio') await sender.replaceTrack(state.localTrack).catch(() => {});
      }
    }
    applyTransmit();
    hideBanner();
    note('microphone restarted');
  } catch (err) {
    note(`microphone restart failed: ${err.name}`);
    showBanner('Your microphone stopped. Tap to turn it back on.', () => { hideBanner(); recoverMic(); });
  } finally {
    state.micRecovering = false;
  }
}

function micSettingsHelp() {
  return isIOS
    ? 'On iPhone: Settings → Apps → Safari → Microphone → Allow (older iOS: Settings → Safari → Microphone).'
    : 'In Chrome: tap the icon left of the web address → Permissions → Microphone → Allow.';
}

// ---------- self-repair ----------
// Phones interrupt things quietly (calls, notifications, Bluetooth switching, network handovers).
// Rather than waiting for someone to notice and reload, check everything every few seconds.
function watchdog() {
  if (state.leaving) return;
  const pj = state.pj;
  if (!state.claiming && (!pj || pj.destroyed)) { note('watchdog: lost our seat — rejoining'); claimSeat(); }
  else if (pj?.disconnected) scheduleReconnect();

  const ctx = state.audioCtx;
  if (ctx && ctx.state !== state.lastCtxState) { note(`audio engine ${ctx.state}`); state.lastCtxState = ctx.state; }
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});

  for (const p of state.peers.values()) {
    if (p.audio?.srcObject && p.audio.paused) {
      note(`watchdog: ${nameOf(p)}'s audio was paused — restarting`);
      p.audio.play().catch(() => showBanner('Tap to turn match audio back on', unlockAudio));
    }
  }
  if (state.keepAlive?.paused) state.keepAlive.play().catch(() => {});
  if (state.localTrack?.readyState === 'ended') recoverMic();
  if (document.visibilityState === 'visible' && (!state.wakeLock || state.wakeLock.released)) requestWakeLock();
}

// Tear down every link and rejoin — keeps the mic, so it's a reset without a reload.
function reconnectAll() {
  note('manual reconnect');
  state.timers.forEach(clearInterval);
  state.timers = [];
  for (const id of [...state.peers.keys()]) removePeer(id);
  const pj = state.pj;
  state.pj = null;
  pj?.destroy();
  claimSeat();
}

// ---------- seats (PeerJS identities) ----------
function peerOptions() {
  const o = { debug: 0 }; // probing empty seats would otherwise flood the console with errors
  if (state.iceServers) o.config = { iceServers: state.iceServers };
  return o;
}

async function claimSeat() {
  if (state.claiming || state.leaving) return;
  state.claiming = true;
  try {
    while (!state.leaving) {
      setNet('warn', 'Connecting…');
      const result = await tryAllSeats();
      if (result === 'ok') return;
      if (result === 'full') {
        setNet('bad', 'Match full');
        showBanner(`This match is full (${MAX_SLOTS} officials max).`);
        return; // the watchdog tries again in case a seat frees up
      }
      note('connection service unreachable — retrying');
      setNet('bad', 'Offline');
      showBanner('Can\'t reach the connection service — retrying…');
      await sleep(3000);
    }
  } finally {
    state.claiming = false;
  }
}

async function tryAllSeats() {
  const key = `rc.slot.${state.room}`;
  const preferred = state.slot || Number(sessionStorage.getItem(key)) || 0;
  // After a reload the server may hold our old seat for a moment — wait for it before taking another.
  const order = preferred ? [preferred, preferred, preferred] : [];
  for (let s = 1; s <= MAX_SLOTS; s++) if (s !== preferred) order.push(s);

  for (const slot of order) {
    if (state.leaving) return 'error';
    const result = await openSeat(slot);
    if (result === 'ok') {
      sessionStorage.setItem(key, String(slot));
      hideBanner();
      onSeated();
      return 'ok';
    }
    if (result === 'error') return 'error';
    if (slot === preferred) await sleep(1500);
  }
  return 'full';
}

function openSeat(slot) {
  return new Promise(resolve => {
    const pj = new Peer(seatId(slot), peerOptions());
    const finish = result => { pj.off('open', onOpen); pj.off('error', onError); resolve(result); };
    const onOpen = () => { state.pj = pj; state.slot = slot; state.myId = pj.id; finish('ok'); };
    const onError = err => { pj.destroy(); finish(err.type === 'unavailable-id' ? 'taken' : 'error'); };
    pj.on('open', onOpen);
    pj.on('error', onError);
  });
}

function onSeated() {
  const pj = state.pj;
  state.timers.forEach(clearInterval);
  state.netRetry = 0;
  setNet('ok', 'Connected');
  note(`took seat ${state.slot}`);
  renderRoster();

  pj.on('connection', dc => setupLink(dc, false));
  pj.on('call', onIncomingCall);
  pj.on('open', () => { state.netRetry = 0; note('connection service back'); setNet('ok', 'Connected'); renderRoster(); });
  // Losing the PeerJS server doesn't cut existing audio — only new joins need it.
  pj.on('disconnected', () => {
    if (state.leaving || pj.destroyed || state.pj !== pj) return;
    note('lost connection service (audio links unaffected)');
    setNet('warn', 'Reconnecting…');
    scheduleReconnect();
  });
  pj.on('error', err => {
    if (err.type === 'peer-unavailable' || state.pj !== pj) return; // rang an empty seat — expected
    note(`connection service error: ${err.type}`);
    if (err.type === 'unavailable-id') {         // seat was taken while we were offline
      state.pj = null;
      pj.destroy();
      claimSeat();
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) scheduleReconnect();
  });

  scan(true);
  state.timers = [setInterval(heartbeat, HEARTBEAT_MS), setInterval(() => scan(false), RESCAN_MS)];
}

function scheduleReconnect() {
  if (state.reconnectTimer) return; // one attempt in flight at a time, so backoff can't be reset forever
  const delay = Math.min(1000 * 2 ** state.netRetry++, 8000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    const pj = state.pj;
    if (state.leaving || !pj || pj.destroyed || !pj.disconnected) return;
    try { pj.reconnect(); } catch (err) { note(`reconnect failed: ${err.message}`); }
  }, delay);
}

// Newcomers ring every seat; after that, the lower seat of each pair is responsible for re-ringing.
function scan(initial) {
  if (!state.pj || state.pj.disconnected) return;
  for (let s = 1; s <= MAX_SLOTS; s++) {
    const rid = seatId(s);
    if (rid === state.myId || state.dialing.has(rid)) continue;
    const p = state.peers.get(rid);
    if (p && p.dc?.open && !p.stale) continue;
    if (initial || state.myId < rid || (p && (p.stale || !p.dc?.open))) dial(rid);
  }
}

function dial(rid) {
  const dc = state.pj.connect(rid, { label: 'rc-' + Math.random().toString(36).slice(2, 10), serialization: 'json', reliable: true });
  if (!dc) return;
  state.dialing.set(rid, dc);
  setTimeout(() => {
    if (state.dialing.get(rid) !== dc) return;
    state.dialing.delete(rid);
    if (!dc.open) dc.close();
  }, 10000);
  setupLink(dc, true);
}

// ---------- links: one data channel (presence/state) + one audio call per pair ----------
function getPeer(id) {
  let p = state.peers.get(id);
  if (!p) {
    p = { id, info: null, dc: null, call: null, audio: null, analyser: null, speaking: false, lastSeen: Date.now(), stale: false };
    state.peers.set(id, p);
  }
  return p;
}

// If two links exist between a pair (both rang at once, or one side reconnected), both phones
// must agree which to keep: a live link started by the lower seat wins; otherwise the newest.
function prefer(p, dc) {
  const cur = p.dc;
  if (!cur || cur === dc || !cur.open) return true;
  if (Date.now() - p.lastSeen > STALE_MS) return true;
  const curInit = cur._rcOutgoing ? state.myId : p.id;
  const newInit = dc._rcOutgoing ? state.myId : p.id;
  if (curInit === newInit) return true;
  return newInit < curInit;
}

function setupLink(dc, outgoing) {
  dc._rcOutgoing = outgoing;
  dc.on('open', () => {
    if (outgoing && state.dialing.get(dc.peer) === dc) state.dialing.delete(dc.peer);
    const p = getPeer(dc.peer);
    if (!prefer(p, dc)) { dc.close(); return; }
    const old = p.dc;
    p.dc = dc; p.lastSeen = Date.now(); p.stale = false;
    if (old && old !== dc) { closeCall(p); old.close(); }
    note(`${nameOf(p)}: link open`);
    dc.send({ t: 'hello', info: myInfo() });
    renderRoster();
  });
  dc.on('data', msg => onData(dc, msg));
  dc.on('close', () => {
    const p = state.peers.get(dc.peer);
    if (!p || p.dc !== dc) return;
    if (audioUp(p)) {
      // Presence channel hiccuped but audio is still flowing — keep talking and quietly redial it.
      note(`${nameOf(p)}: data link closed, audio still up — redialling`);
      p.dc = null;
      renderRoster();
      return;
    }
    note(`${nameOf(p)}: link closed`);
    removePeer(p.id);
  });
  dc.on('error', () => {});
}

function onData(dc, msg) {
  const p = state.peers.get(dc.peer);
  if (!p || p.dc !== dc || !msg) return;
  p.lastSeen = Date.now();
  if (p.stale) { p.stale = false; renderRoster(); }
  switch (msg.t) {
    case 'hello':
      p.info = msg.info;
      // The side that opened the link places the audio call, so calls never cross.
      if (dc._rcOutgoing && !p.call) placeCall(p);
      renderRoster();
      break;
    case 'state':
      if (p.info) { p.info.live = !!msg.live; renderRoster(); }
      break;
    case 'bye':
      note(`${nameOf(p)}: left`);
      removePeer(p.id);
      break;
  }
}

function placeCall(p) {
  if (!state.pj || !p.dc?.open) return;
  const call = state.pj.call(p.id, state.outStream, { metadata: { link: p.dc.label } });
  if (call) attachCall(p, call);
}

function onIncomingCall(call) {
  const p = state.peers.get(call.peer);
  // Only accept calls tied to the link we kept; a call from a discarded link is stale.
  if (!p || !p.dc || call.metadata?.link !== p.dc.label) { call.close(); return; }
  call.answer(state.outStream);
  attachCall(p, call);
}

function attachCall(p, call) {
  const old = p.call;
  p.call = call;
  if (old && old !== call) old.close();
  call.on('stream', stream => attachRemoteAudio(p, stream));
  call.on('close', () => {
    clearTimeout(p.discTimer);
    if (p.call !== call) return;
    p.call = null;
    p.route = null;
    note(`${nameOf(p)}: audio closed`);
    renderRoster();
    // Audio dropped but the link is up — the caller rings again.
    if (state.peers.get(p.id) === p && p.dc?.open && p.dc._rcOutgoing) {
      setTimeout(() => { if (state.peers.get(p.id) === p && !p.call) placeCall(p); }, 1000);
    }
  });
  call.on('error', () => {});
  call.peerConnection?.addEventListener('connectionstatechange', () => {
    if (p.call !== call) return;
    const s = call.peerConnection.connectionState;
    note(`${nameOf(p)}: audio ${s}`);
    clearTimeout(p.discTimer);
    if (s === 'connected') describeRoute(p, call);
    // "disconnected" often heals by itself; if it hasn't within 10 s, rebuild rather than sit in silence.
    if (s === 'disconnected') {
      p.discTimer = setTimeout(() => {
        if (p.call !== call || call.peerConnection.connectionState === 'connected') return;
        note(`${nameOf(p)}: audio stuck — rebuilding`);
        call.close();
      }, 10000);
    }
    if (s === 'failed') call.close();
    renderRoster();
  });
  renderRoster();
}

// Log whether audio is going direct or through a relay — the first thing to know when a link misbehaves.
async function describeRoute(p, call) {
  try {
    const stats = await call.peerConnection.getStats();
    let pair = null;
    stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    p.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    note(`${nameOf(p)}: audio path ${p.route} (${local?.candidateType}→${remote?.candidateType}, ${local?.protocol}${local?.url ? ', ' + local.url : ''})`);
    renderRoster();
  } catch { /* stats are best-effort */ }
}

function closeCall(p) {
  const c = p.call;
  p.call = null;
  c?.close();
}

function removePeer(id) {
  const p = state.peers.get(id);
  if (!p) return;
  state.peers.delete(id);
  clearTimeout(p.discTimer);
  closeCall(p);
  const dc = p.dc; p.dc = null; dc?.close();
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  renderRoster();
}

function heartbeat() {
  const now = Date.now();
  for (const p of [...state.peers.values()]) {
    if (p.dc?.open) { try { p.dc.send({ t: 'ping' }); } catch { /* channel closing */ } }
    const quiet = now - p.lastSeen;
    // Missed pings alone never cut audio that's still flowing — only a link that's dead on both counts.
    const up = audioUp(p);
    if (quiet > DROP_MS && !up) {
      note(`${nameOf(p)}: no contact for ${Math.round(quiet / 1000)}s — dropping`);
      removePeer(p.id);
      continue;
    }
    const stale = quiet > STALE_MS && !up;
    if (stale !== p.stale) { p.stale = stale; renderRoster(); }
  }
}

function broadcast(msg) {
  for (const p of state.peers.values()) {
    if (p.dc?.open) { try { p.dc.send(msg); } catch { /* channel closing */ } }
  }
}

// ---------- audio ----------
function attachRemoteAudio(p, stream) {
  if (!p.audio) {
    p.audio = document.createElement('audio');
    p.audio.autoplay = true;
    p.audio.setAttribute('playsinline', '');
    $('#audioSink').appendChild(p.audio);
  }
  p.audio.srcObject = stream;
  p.audio.play().catch(() => showBanner('Tap to turn on match audio', unlockAudio));
  p.analyser = makeAnalyser(stream);
}

function unlockAudio() {
  state.audioCtx?.resume();
  for (const p of state.peers.values()) p.audio?.play().catch(() => {});
  hideBanner();
}

function makeAnalyser(stream) {
  if (!state.audioCtx) return null;
  try {
    const src = state.audioCtx.createMediaStreamSource(stream);
    const an = state.audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // analysis only — playback goes through the <audio> element
    return { an, buf: new Float32Array(an.fftSize) };
  } catch { return null; }
}
function level(a) {
  if (!a) return 0;
  a.an.getFloatTimeDomainData(a.buf);
  let sum = 0; for (const v of a.buf) sum += v * v;
  return Math.sqrt(sum / a.buf.length);
}

// ---------- mic control ----------
function isTransmitting() {
  if (!state.localTrack) return false;
  return state.mode === 'open' ? !state.muted : (state.pttDown || state.burstUntil > 0);
}
function applyTransmit() {
  const live = isTransmitting();
  if (state.localTrack) state.localTrack.enabled = live;
  broadcast({ t: 'state', live });
  renderRoster();
  renderTalk();
}
function renderTalk() {
  const talk = $('#talk');
  talk.className = 'talk';
  if (!state.localTrack) {
    talk.classList.add('listen');
    $('#talkLabel').textContent = 'LISTENING';
    $('#talkSub').textContent = 'Listen-only mode';
    $('.mode').hidden = true;
    $('#hsStatus').hidden = true;
    return;
  }
  $('#hsStatus').textContent = state.mode === 'ptt'
    ? `Headset button: talk for ${HEADSET_TALK_MS / 1000}s · ${headsetNote()}`
    : `Headset button: mute / unmute · ${headsetNote()}`;
  if (state.mode === 'open') {
    if (state.muted) talk.classList.add('muted');
    $('#talkLabel').textContent = state.muted ? 'MUTED' : 'LIVE';
    $('#talkSub').textContent = state.muted ? 'Tap to go live' : 'Tap to mute';
  } else {
    talk.classList.add('ptt');
    const talking = state.pttDown || state.burstUntil > 0;
    if (talking) talk.classList.add('down');
    $('#talkLabel').textContent = talking ? 'TALKING' : 'HOLD';
    $('#talkSub').textContent = state.pttDown ? 'Release to stop'
      : state.burstUntil ? `Headset · ${Math.max(1, Math.ceil((state.burstUntil - Date.now()) / 1000))}s left`
      : 'Hold to talk';
  }
  document.querySelectorAll('.mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
}

// ---------- headset / AirPods button ----------
// Headset buttons reach web pages only as media keys (play/pause etc.) via the Media Session API,
// and only while the page is playing media — hence a silent looping track. A press is a single
// event with no release, so push-to-talk mode opens the mic for a fixed window instead.
const HEADSET_ACTIONS = ['play', 'pause', 'togglemicrophone', 'nexttrack', 'previoustrack', 'stop'];

function silentWavUrl(seconds = 10, rate = 8000) {
  const n = seconds * rate;
  const v = new DataView(new ArrayBuffer(44 + n));
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(v.buffer, 44).fill(128); // 8-bit silence
  return URL.createObjectURL(new Blob([v.buffer], { type: 'audio/wav' }));
}

function startHeadsetSupport() {
  if (!('mediaSession' in navigator)) return;
  const el = new Audio(silentWavUrl());
  el.loop = true;
  el.setAttribute('playsinline', '');
  // If the OS pauses it (e.g. on a button press), keep it going so presses keep arriving.
  el.addEventListener('pause', () => { if (!state.leaving && state.keepAlive === el) el.play().catch(() => {}); });
  el.play().catch(() => {});
  state.keepAlive = el;
  for (const action of HEADSET_ACTIONS) {
    try { navigator.mediaSession.setActionHandler(action, () => onHeadsetButton(action)); } catch { /* unsupported action */ }
  }
}
function stopHeadsetSupport() {
  const el = state.keepAlive;
  state.keepAlive = null;
  el?.pause();
  for (const action of HEADSET_ACTIONS) { try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported */ } }
}

function onHeadsetButton(action) {
  const now = Date.now();
  if (now - state.lastHeadset < 400) return; // one press can fire more than one action
  state.lastHeadset = now;
  state.headsetSeen = action;
  try { navigator.mediaSession.playbackState = 'playing'; } catch { /* older browsers */ }
  if (!state.localTrack) return renderTalk();

  if (state.mode === 'ptt') {
    startBurst(); // pressing again mid-window restarts the 5 seconds
  } else {
    state.muted = !state.muted;
    applyTransmit();
    cue(state.muted ? 'off' : 'on');
  }
  navigator.vibrate?.(25);
}

function startBurst() {
  const wasTalking = state.burstUntil > 0;
  state.burstUntil = Date.now() + HEADSET_TALK_MS;
  clearInterval(state.burstTick);
  state.burstTick = setInterval(() => {
    if (Date.now() >= state.burstUntil) endBurst(true);
    else renderTalk();
  }, 250);
  if (!wasTalking) applyTransmit();
  cue('on');
}
function endBurst(withCue) {
  if (!state.burstUntil) return;
  state.burstUntil = 0;
  clearInterval(state.burstTick);
  applyTransmit();
  if (withCue) cue('off');
}

function headsetNote() {
  if (!('mediaSession' in navigator)) return 'not supported in this browser';
  return state.headsetSeen ? `working (${state.headsetSeen})` : 'press once to test';
}

// Short chirp in the official's own ear (not sent to others): rising = mic open, falling = muted.
function cue(kind) {
  const ctx = state.audioCtx;
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(kind === 'on' ? 660 : 880, t);
  o.frequency.linearRampToValueAtTime(kind === 'on' ? 990 : 440, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.16);
}

function setupLiveControls() {
  const talk = $('#talk');
  const pttStart = e => {
    if (state.mode !== 'ptt' || !state.localTrack) return;
    e.preventDefault();
    talk.setPointerCapture?.(e.pointerId);
    endBurst(false); // a finger on the button takes over from a headset window
    state.pttDown = true; applyTransmit();
    navigator.vibrate?.(15);
  };
  const pttEnd = () => {
    if (!state.pttDown) return;
    state.pttDown = false; applyTransmit();
  };
  talk.addEventListener('pointerdown', pttStart);
  talk.addEventListener('pointerup', pttEnd);
  talk.addEventListener('pointercancel', pttEnd);
  talk.addEventListener('contextmenu', e => e.preventDefault());
  talk.addEventListener('click', () => {
    if (state.mode !== 'open' || !state.localTrack) return;
    state.muted = !state.muted; applyTransmit();
    navigator.vibrate?.(state.muted ? [20, 40, 20] : 25);
  });

  // Spacebar = push-to-talk / mute toggle on laptops (handy for a TMO booth).
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || e.target.matches('input, select, textarea')) return;
    e.preventDefault();
    if (state.mode === 'ptt') { state.pttDown = true; applyTransmit(); }
    else { state.muted = !state.muted; applyTransmit(); }
  });
  document.addEventListener('keyup', e => { if (e.code === 'Space' && state.mode === 'ptt') pttEnd(); });

  document.querySelectorAll('.mode button').forEach(b => b.addEventListener('click', () => {
    endBurst(false);
    state.mode = b.dataset.mode; state.pttDown = false; state.muted = false;
    localStorage.setItem('rc.mode', state.mode);
    applyTransmit();
  }));

  $('#leaveBtn').addEventListener('click', leave);
  $('#shareBtn').addEventListener('click', openShare);
  $('#nativeShare').addEventListener('click', () => {
    if (navigator.share) navigator.share({ title: 'Ref Comms', text: `Join match ${state.room}`, url: shareUrl() }).catch(() => {});
    else copyLink();
  });
  $('#copyLink').addEventListener('click', copyLink);

  $('#netStatus').addEventListener('click', () => { renderLog(); $('#logDlg').showModal(); });
  $('#reconnectBtn').addEventListener('click', () => { $('#logDlg').close(); reconnectAll(); });
  $('#copyLog').addEventListener('click', () => {
    navigator.clipboard?.writeText(logText()).then(() => { $('#copyLog').textContent = 'Copied'; setTimeout(() => $('#copyLog').textContent = 'Copy log', 1500); });
  });
  window.addEventListener('online', () => note('phone network back online'));
  window.addEventListener('offline', () => note('phone network offline'));

  document.addEventListener('visibilitychange', () => {
    note(`app ${document.visibilityState === 'visible' ? 'back on screen' : 'hidden (screen off or switched app)'}`);
    if (document.visibilityState !== 'visible') return;
    requestWakeLock();
    state.audioCtx?.resume();
    if (state.pj && !state.pj.destroyed && state.pj.disconnected) { state.netRetry = 0; scheduleReconnect(); }
  });
  window.addEventListener('pagehide', () => broadcast({ t: 'bye' }));
}

function leave() {
  state.leaving = true;
  clearInterval(state.watchdog);
  stopHeadsetSupport();
  broadcast({ t: 'bye' });
  state.timers.forEach(clearInterval);
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.pj?.destroy();
  state.localStream?.getTracks().forEach(t => t.stop());
  state.wakeLock?.release().catch(() => {});
  sessionStorage.removeItem(`rc.slot.${state.room}`);
  location.href = '/';
}

// ---------- share ----------
function openShare() {
  const url = shareUrl();
  $('#shareCode').textContent = state.room;
  $('#shareUrl').textContent = url.replace(/^https?:\/\//, '');
  if (window.qrcode) {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  } else {
    $('#qr').hidden = true;
  }
  $('#shareDlg').showModal();
}
function copyLink() {
  navigator.clipboard?.writeText(shareUrl()).then(() => { $('#copyLink').textContent = 'Copied'; setTimeout(() => $('#copyLink').textContent = 'Copy', 1500); });
}

// ---------- screen / status ----------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      state.wakeLockErr = null;
      lock.addEventListener('release', () => note('screen keep-awake released'));
    }
  } catch (err) {
    // The watchdog retries every few seconds; only log when the reason changes.
    if (state.wakeLockErr !== err.name) note(`screen keep-awake unavailable: ${err.name}`);
    state.wakeLockErr = err.name;
  }
}

// ---------- connection log ----------
function logSummary() {
  const pj = state.pj;
  const lines = [
    `Ref Comms ${APP_VERSION} · match ${state.room} · seat ${state.slot || '-'} · ${state.me?.role}`,
    `Connection service: ${!pj ? 'none' : pj.destroyed ? 'destroyed' : pj.disconnected ? 'disconnected' : 'connected'} · relays: ${state.iceServers ? 'own TURN' : 'PeerJS free'}`,
    `Mic: ${!state.localTrack ? 'listen only' : `${state.localTrack.readyState}${state.localTrack.muted ? ' (paused by system)' : ''}`} · audio engine: ${state.audioCtx?.state}`,
  ];
  for (const p of state.peers.values()) {
    lines.push(`  ${nameOf(p)} (${p.info?.role || '?'}): audio ${p.call?.peerConnection?.connectionState || 'none'}${p.route ? ' / ' + p.route : ''}, data ${p.dc?.open ? 'open' : 'closed'}, last heard ${Math.round((Date.now() - p.lastSeen) / 1000)}s ago`);
  }
  return lines.join('\n');
}
function logText() { return `${logSummary()}\n\n${logLines.join('\n')}`; }
function renderLog() {
  $('#logSummary').textContent = logSummary();
  const pre = $('#logLines');
  pre.textContent = logLines.slice().reverse().join('\n') || 'Nothing logged yet.';
}

function setNet(kind, text) { const el = $('#netStatus'); el.className = `net ${kind}`; el.textContent = text; }
function showBanner(text, onTap) {
  const b = $('#banner');
  b.innerHTML = '';
  b.append(text);
  if (onTap) { const btn = document.createElement('button'); btn.textContent = 'Tap here'; btn.onclick = onTap; b.append(btn); }
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

function peerStatus(p) {
  if (p.stale) return ['bad', 'Signal lost — reconnecting'];
  const s = p.call?.peerConnection?.connectionState;
  if (s === 'connected') return ['ok', p.route === 'relay' ? 'Connected · relay' : 'Connected'];
  if (s === 'failed') return ['bad', 'Link failed — retrying'];
  if (s === 'disconnected') return ['warn', 'Weak link…'];
  return ['warn', 'Connecting audio…'];
}

function rosterCard({ id, name, role, micClass, micText, dotClass, statusText, offline, speaking }) {
  const el = document.createElement('div');
  el.className = 'official' + (offline ? ' offline' : '') + (speaking ? ' speaking' : '');
  el.dataset.id = id; el.dataset.role = role;
  el.innerHTML = `<div class="avatar"></div><div class="who"><div class="name"></div><div class="meta"><span class="dot"></span><span class="st"></span></div></div><span class="mic-state"></span>`;
  el.querySelector('.avatar').textContent = roleAbbrev(role) || initials(name);
  el.querySelector('.name').textContent = name;
  el.querySelector('.dot').classList.add(dotClass);
  el.querySelector('.st').textContent = `${role} · ${statusText}`;
  const mic = el.querySelector('.mic-state');
  mic.classList.add(micClass); mic.textContent = micText;
  return el;
}

function renderRoster() {
  const root = $('#roster');
  if (!root || !state.me) return;
  root.innerHTML = '';
  const meLive = isTransmitting();
  root.append(rosterCard({
    id: 'me', name: `${state.me.name} (you)`, role: state.me.role,
    micClass: !state.localTrack ? 'listen' : meLive ? 'live' : 'muted',
    micText: !state.localTrack ? 'LISTEN' : meLive ? 'LIVE' : state.mode === 'ptt' ? 'PTT' : 'MUTED',
    dotClass: state.pj && !state.pj.disconnected ? 'ok' : 'warn', statusText: 'This phone',
  }));

  const order = ['Referee', 'AR 1', 'AR 2', 'TMO', '4th Official', 'Assessor'];
  const peers = [...state.peers.values()].filter(p => p.info)
    .sort((a, b) => order.indexOf(a.info.role) - order.indexOf(b.info.role));
  for (const p of peers) {
    const [dotClass, statusText] = peerStatus(p);
    root.append(rosterCard({
      id: p.id, name: p.info.name, role: p.info.role,
      micClass: p.info.listenOnly ? 'listen' : p.info.live ? 'live' : 'muted',
      micText: p.info.listenOnly ? 'LISTEN' : p.info.live ? 'LIVE' : 'MUTED',
      dotClass, statusText, offline: p.stale, speaking: p.speaking,
    }));
  }
  if (!peers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `Waiting for the rest of the crew.<br>Tap <b>MATCH ${state.room}</b> above to show the QR code.`;
    root.append(empty);
  }
}

// Speaking rings + mic meter. Runs every frame but only touches classes that change.
function meterLoop() {
  if (state.leaving) return;
  const myLevel = isTransmitting() ? level(state.localAnalyser) : 0;
  $('#meterFill').style.height = `${Math.min(100, myLevel * 400)}%`;
  document.querySelector('.official[data-id="me"]')?.classList.toggle('speaking', myLevel > SPEAKING_THRESHOLD);
  for (const p of state.peers.values()) {
    const speaking = level(p.analyser) > SPEAKING_THRESHOLD;
    if (speaking !== p.speaking) {
      p.speaking = speaking;
      document.querySelector(`.official[data-id="${CSS.escape(p.id)}"]`)?.classList.toggle('speaking', speaking);
    }
  }
  requestAnimationFrame(meterLoop);
}

initJoin();
