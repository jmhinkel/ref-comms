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

const state = {
  me: null,                // { name, role }
  room: null,
  slot: 0,
  myId: null,
  pj: null,                // PeerJS Peer
  netRetry: 0,
  reconnectTimer: null,
  timers: [],
  leaving: false,
  iceServers: null,        // null → PeerJS defaults (Google STUN + PeerJS's free TURN)
  localStream: null,
  localTrack: null,
  outStream: null,         // mic stream, or silence for listen-only seats
  mode: localStorage.getItem('rc.mode') || 'open',  // 'open' | 'ptt'
  muted: false,
  pttDown: false,
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

    const cfg = await fetch('/config.json').then(r => r.json()).catch(() => null);
    if (cfg?.hasTurn) state.iceServers = cfg.iceServers;

    if (listenOnly) {
      state.outStream = state.audioCtx.createMediaStreamDestination().stream; // silence
    } else {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      state.localTrack = state.localStream.getAudioTracks()[0];
      state.localTrack.addEventListener('ended', () => showBanner('Microphone stopped — another app may have taken it. Tap to rejoin.', () => location.reload()));
      state.localAnalyser = makeAnalyser(state.localStream);
      state.outStream = state.localStream;
    }
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Join match';
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showJoinError(denied
      ? 'Microphone permission was blocked. Allow it in your browser settings, or tick "Listen only".'
      : `Couldn't start the microphone (${err.message || err.name}).`);
    return;
  }

  state.me = { name, role };
  state.room = room;
  history.replaceState(null, '', `/?m=${room}`);

  $('#join').hidden = true;
  $('#live').hidden = false;
  $('#codeLabel').textContent = room;
  setupLiveControls();
  applyTransmit();
  requestWakeLock();
  requestAnimationFrame(meterLoop);
  claimSeat();
}

// ---------- seats (PeerJS identities) ----------
function peerOptions() {
  const o = { debug: 0 }; // probing empty seats would otherwise flood the console with errors
  if (state.iceServers) o.config = { iceServers: state.iceServers };
  return o;
}

async function claimSeat() {
  setNet('warn', 'Connecting…');
  const key = `rc.slot.${state.room}`;
  const preferred = Number(sessionStorage.getItem(key)) || 0;
  // After a reload the server may hold our old seat for a moment — wait for it before taking another.
  const order = preferred ? [preferred, preferred, preferred] : [];
  for (let s = 1; s <= MAX_SLOTS; s++) if (s !== preferred) order.push(s);

  for (const slot of order) {
    if (state.leaving) return;
    const result = await openSeat(slot);
    if (result === 'ok') {
      sessionStorage.setItem(key, String(slot));
      hideBanner();
      onSeated();
      return;
    }
    if (result === 'error') {
      setNet('bad', 'Offline');
      showBanner('Can\'t reach the connection service — retrying…');
      await sleep(3000);
      return claimSeat();
    }
    if (slot === preferred) await sleep(1500);
  }
  setNet('bad', 'Match full');
  showBanner(`This match is full (${MAX_SLOTS} officials max).`);
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
  renderRoster();

  pj.on('connection', dc => setupLink(dc, false));
  pj.on('call', onIncomingCall);
  pj.on('open', () => { state.netRetry = 0; setNet('ok', 'Connected'); renderRoster(); });
  // Losing the PeerJS server doesn't cut existing audio — only new joins need it.
  pj.on('disconnected', () => {
    if (state.leaving || pj.destroyed) return;
    setNet('warn', 'Reconnecting…');
    scheduleReconnect();
  });
  pj.on('error', err => {
    if (err.type === 'peer-unavailable') return; // rang an empty seat — expected
    if (err.type === 'unavailable-id') {         // seat was taken while we were offline
      pj.destroy();
      claimSeat();
      return;
    }
    console.warn('peer error', err.type, err);
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) scheduleReconnect();
  });

  scan(true);
  state.timers = [setInterval(heartbeat, HEARTBEAT_MS), setInterval(() => scan(false), RESCAN_MS)];
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(1000 * 2 ** state.netRetry++, 8000);
  state.reconnectTimer = setTimeout(() => {
    const pj = state.pj;
    if (!state.leaving && pj && !pj.destroyed && pj.disconnected) pj.reconnect();
  }, delay);
}

// Newcomers ring every seat; after that, the lower seat of each pair is responsible for re-ringing.
function scan(initial) {
  if (!state.pj || state.pj.disconnected) return;
  for (let s = 1; s <= MAX_SLOTS; s++) {
    const rid = seatId(s);
    if (rid === state.myId || state.dialing.has(rid)) continue;
    const p = state.peers.get(rid);
    if (p && !p.stale) continue;
    if (initial || p?.stale || state.myId < rid) dial(rid);
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
    dc.send({ t: 'hello', info: myInfo() });
    renderRoster();
  });
  dc.on('data', msg => onData(dc, msg));
  dc.on('close', () => {
    const p = state.peers.get(dc.peer);
    if (p && p.dc === dc) removePeer(p.id);
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
    if (p.call !== call) return;
    p.call = null;
    renderRoster();
    // Audio dropped but the link is up — the caller rings again.
    if (state.peers.get(p.id) === p && p.dc?.open && p.dc._rcOutgoing) {
      setTimeout(() => { if (state.peers.get(p.id) === p && !p.call) placeCall(p); }, 1000);
    }
  });
  call.on('error', () => {});
  call.peerConnection?.addEventListener('connectionstatechange', () => {
    if (p.call !== call) return;
    if (call.peerConnection.connectionState === 'failed') call.close();
    renderRoster();
  });
  renderRoster();
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
    if (quiet > DROP_MS) { removePeer(p.id); continue; }
    const stale = quiet > STALE_MS;
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
  return state.mode === 'open' ? !state.muted : state.pttDown;
}
function applyTransmit() {
  const live = isTransmitting();
  if (state.localTrack) state.localTrack.enabled = live;
  broadcast({ t: 'state', live });
  renderRoster();

  const talk = $('#talk');
  talk.className = 'talk';
  if (!state.localTrack) {
    talk.classList.add('listen');
    $('#talkLabel').textContent = 'LISTENING';
    $('#talkSub').textContent = 'Listen-only mode';
    $('.mode').hidden = true;
    return;
  }
  if (state.mode === 'open') {
    if (state.muted) talk.classList.add('muted');
    $('#talkLabel').textContent = state.muted ? 'MUTED' : 'LIVE';
    $('#talkSub').textContent = state.muted ? 'Tap to go live' : 'Tap to mute';
  } else {
    talk.classList.add('ptt');
    if (state.pttDown) talk.classList.add('down');
    $('#talkLabel').textContent = state.pttDown ? 'TALKING' : 'HOLD';
    $('#talkSub').textContent = state.pttDown ? 'Release to stop' : 'Hold to talk';
  }
  document.querySelectorAll('.mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
}

function setupLiveControls() {
  const talk = $('#talk');
  const pttStart = e => {
    if (state.mode !== 'ptt' || !state.localTrack) return;
    e.preventDefault();
    talk.setPointerCapture?.(e.pointerId);
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWakeLock();
    state.audioCtx?.resume();
    if (state.pj && !state.pj.destroyed && state.pj.disconnected) { state.netRetry = 0; scheduleReconnect(); }
  });
  window.addEventListener('pagehide', () => broadcast({ t: 'bye' }));
}

function leave() {
  state.leaving = true;
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
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* not fatal */ }
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
  if (s === 'connected') return ['ok', 'Connected'];
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
