// app.js — qb-scorekeeper host console.
//
// Layout (settled with Denis via mockups, July 2026): full-width
// question text, set/mode/roster/settings in the top bar, consensus-
// scorekeeper-style team panels underneath, chronological history in a
// right sidebar. Three reading modes (audio / reveal / full text); in
// full-text mode the host clicks the word a buzz landed on, which gives
// exact power/neg positions with no clock at all. Bonuses read part by
// part, revealed as they're scored, with the tossup kept on screen.
//
// All game logic lives in engine/engine.js; this file is data loading,
// audio/reveal clocks, and DOM. Reveal-unit splitting comes from the
// canonical vendor/reveal_units.js (shared with the site reader).
//
// Data contracts consumed (SPEC.md): the site's R2 data plane
// (catalog.json, sets/{slug}.json) and the qb-audio dataset.

import { initialState, reduce, scores, teamScores, liveLog, bonusStats, tossupStats } from '../engine/engine.js';
import * as audio from './audio.js';
import { createRoom, connectHost } from './room.js';

const { questionUnits, slowSpans, SLOW_FACTOR } = globalThis.qbRevealUnits;
const qbSync = globalThis.qbSync;

const QDATA_BASE = 'https://pub-b5f94e8d4cc648abb0e35b7ca4444c65.r2.dev';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- app state ----------
let CAT = null;            // catalog.json
let SET = null;            // sets/{slug}.json payload
let setSlug = null;        // R2 slug (null for uploaded packets)
let packet = null;         // current packet {number, tossups, bonuses}
let packetIdx = -1;        // index into SET.packets
let packetLabel = '';      // "Packet 7"
let tuIdx = -1;            // index into packet.tossups
let state = initialState({});
let cur = null;            // {q, units, powerIdx, superpowerIdx, mode, unitIdx, mapper, slow, timer, bonus}
let pendingBuzz = null;    // {unitIdx, ts}
let selPlayer = null;      // the buzzer, once known
let controlling = null;    // player who got the tossup
let teamList = [];         // team names in display order
const qidMeta = {};        // qid -> {label: "Packet 7 · Tossup 4"}
const player = audio.createPlayer();

let room = null;           // connected room (room.js) or null
let roomArmed = null;      // last arm/disarm sent, to avoid spam
let earlyAnswer = null;    // {name, text} typed before the buzz window resolved
let review = null;         // {idx} when browsing a previous question
const connected = new Set();  // player names currently connected via the room
const qlog = [];           // completed questions [{qid, label, question, answer, summary}]

// ---- audio broadcast (host side; SPEC.md audio broadcast section) ----
// With the Broadcast setting on, phones play the same qb-audio files,
// fetched straight from the CDN (never through the worker) and started
// on a server-clock instant so every device begins together. The host
// stays the authoritative clock: buzz positions still come from the
// host's audio element, and every anchor message (start/pause/resume/
// rate/state) carries its currentTime.
let syncSamples = [];      // host's clock-offset samples ({rtt, offset})
const audioResolved = new Map();  // player name -> Set(qid) downloaded OR failed
const audioFailed = new Map();    // player name -> Set(qid) failed only (roster mark)
let audioGate = null;      // {qid, deadline, timer} start gate for the current question
let bcastFallback = null;  // start/resume locally if the worker never echoes (old worker)

const broadcasting = () =>
  !!(room && $('optBroadcast').checked && cur && cur.mode === 'audio');

const hostOffset = () => qbSync.bestOffset(syncSamples) ?? 0;

function clearBcastTimers() {
  if (bcastFallback) { clearTimeout(bcastFallback); bcastFallback = null; }
  if (audioGate) { clearTimeout(audioGate.timer); audioGate = null; }
}

// The packet's audio list. Sent on packet load, host (re)connect, and
// toggle-on, so phones can download everything up front; per-question
// traffic is then just start/pause/resume anchors.
function sendAudioManifest() {
  if (!room || !$('optBroadcast').checked || !packet) return;
  const entries = packet.tossups
    .filter(t => audio.hasAudio(t._id))
    .map(t => ({ qid: t._id, url: audio.audioUrl(t._id) }));
  room.send({ t: 'audio_manifest', entries });
}

// The audio-position wire field is `pos` (seconds) — `t` is taken by
// the message type across the whole protocol.
function buildAudioState(forName) {
  const playing = state.phase === 'reading' && !player.el.paused && !cur.pending && !pendingBuzz;
  const msg = { t: 'audio_state', qid: cur.q._id, playing,
                pos: player.el.currentTime, rate: voiceRate() };
  if (forName) msg.for = forName;
  return msg;
}

function dispatch(ev) { apply(ev); render(); }

// ---------- undo (event replay) ----------
// Every engine event goes through apply(); each host action pushes a
// mark + a snapshot of the app-side mutables. Undo rebuilds the engine
// state by replaying everything before the mark — keeping roster and
// settings events that landed after it, so a mid-question room join
// survives undoing the verdict it interrupted.
const events = [];
const undoStack = [];
const ROSTER_EVENTS = new Set(['player_join', 'player_leave', 'player_move', 'configure']);

function apply(ev) { events.push(ev); state = reduce(state, ev); }

function snapCur() {
  return cur && { ...cur, timer: null,
    bonus: cur.bonus && { ...cur.bonus, given: [...cur.bonus.given], logged: [...cur.bonus.logged] } };
}

function pushUndo() {
  undoStack.push({
    mark: events.length, tuIdx, review: review && { ...review },
    controlling, selPlayer,
    pendingBuzz: pendingBuzz && { ...pendingBuzz },
    cur: snapCur(), qlogLen: qlog.length,
    audioTime: cur && cur.mode === 'audio' ? player.el.currentTime : 0,
  });
  if (undoStack.length > 100) undoStack.shift();
}

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  stopClocks();
  // A buzz being undone releases the remote buzzer's answer bar.
  if (room && pendingBuzz && selPlayer && !s.pendingBuzz) {
    room.send({ t: 'answer_result', name: selPlayer, result: 'done' });
  }
  const kept = events.slice(0, s.mark)
    .concat(events.slice(s.mark).filter(e => ROSTER_EVENTS.has(e.type)));
  events.length = 0;
  state = kept.reduce(reduce, initialState({}));
  events.push(...kept);
  tuIdx = s.tuIdx; review = s.review; controlling = s.controlling;
  selPlayer = s.selPlayer; pendingBuzz = s.pendingBuzz; earlyAnswer = null;
  cur = s.cur;
  qlog.length = s.qlogLen;
  for (const ql of qlog) if (ql.qid) ql.summary = summarize(ql.qid);
  if (room) { roomArmed = null; room.send({ t: 'qlog', qlog }); }
  $('bonuspanel').dataset.for = '';      // rebuild from the restored progress
  $('setsheet').classList.remove('open');
  if (cur) cur.starting = false;   // any in-flight start gate died with stopClocks
  if (cur && cur.mode === 'audio') {
    // Reading resumes paused at the snapshot position (play/⟲ to go on).
    if (player.el.src && player.el.src.includes(cur.q._id)) {
      player.pause();
      try { player.el.currentTime = s.audioTime; } catch (e) { /* not seekable yet */ }
    } else {
      player.load(cur.q._id);
      player.el.playbackRate = voiceRate();
      player.el.onerror = () => degradeToReveal();
      const t = s.audioTime;
      player.el.addEventListener('loadedmetadata', () => { player.el.currentTime = t; }, { once: true });
    }
    // Phones re-anchor to the restored (paused) position.
    if (broadcasting() && !cur.pending) {
      room.send({ t: 'audio_state', qid: cur.q._id, playing: false,
                  pos: s.audioTime, rate: voiceRate() });
    }
  }
  render();
}

// ---------- room mode (phones as buzzers) ----------
$('roombtn').onclick = async () => {
  if (room) {   // already hosting: copy the player join link
    const url = room.playerUrl();
    try { await navigator.clipboard.writeText(url); } catch (e) { prompt('Player link:', url); }
    $('roombtn').textContent = '🌐 ' + room.code + ' ✓';
    setTimeout(() => { if (room) $('roombtn').textContent = '🌐 ' + room.code; }, 1200);
    return;
  }
  $('roombtn').disabled = true;
  try {
    hostRoom(await createRoom());
  } finally {
    $('roombtn').disabled = false;
  }
};

// Connect (or reconnect — session resume) as the host of room `code`.
function hostRoom(code, server) {
  room = connectHost(code, {
    onBuzz: handleRemoteBuzz,
    onBuzzPending: handleRemoteBuzzPending,
    onAnswer: handleRemoteAnswer,
    onJoin: name => {
      connected.add(name);
      if (name && !state.players.includes(name)) {
        dispatch({ type: 'player_join', player: name, team: null });
      } else render();
    },
    onLeave: name => { connected.delete(name); render(); },
    onOpen: () => {   // resync after (re)connect
      roomArmed = null;
      room.send({ t: 'qlog', qlog });
      // Audio broadcast recovery: the DO holds no audio state beyond
      // the manifest, so re-seed the clock samples, the manifest, and
      // (mid-question) the phones' position.
      for (let i = 0; i < 3; i++) setTimeout(() => room && room.send({ t: 'sync', c: Date.now() }), i * 150);
      sendAudioManifest();
      if (broadcasting() && !cur.pending) room.send(buildAudioState());
      render();
    },
    onMessage: handleRoomAudioMessage,
  }, server || undefined);
  $('roombtn').textContent = '🌐 ' + code;
  $('roombtn').title = 'Click to copy the player join link';
}

// Close the room: everyone is told (players' phones return to the join
// screen), the DO wipes, and the code returns to the pool. The send
// gets a beat to flush before the local socket closes — on an old
// worker (no close support) this degrades to just the host leaving.
function closeRoom() {
  if (!room || !confirm('Close the room? Players are disconnected.')) return;
  const r = room;
  room = null;
  roomArmed = null;
  connected.clear();
  r.send({ t: 'close' });
  setTimeout(() => r.close(), 300);
  $('roombtn').textContent = '🌐 Room';
  $('roombtn').title = '';
  render();
}
$('roombtn').oncontextmenu = e => {
  if (!room) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: 'copy player link', run: () => $('roombtn').onclick() },
    { label: 'close room', run: closeRoom },
  ]);
};

// First arrival at the server (buzz window just opened): stop the clock
// NOW and pin the buzz position — the equalized winner may be someone
// else and follows in handleRemoteBuzz within the window (<=200ms).
function handleRemoteBuzzPending(name) {
  if (!cur || cur.pending || state.phase !== 'reading' || pendingBuzz) return;
  pushUndo();
  pauseReading();
  earlyAnswer = null;
  pendingBuzz = { unitIdx: posNow(), ts: Date.now(), tentative: true };
  selPlayer = name;
  render();
}

function handleRemoteBuzz(name) {
  const lockouts = state.current ? state.current.lockouts : [];
  if (pendingBuzz && pendingBuzz.tentative) {
    // Resolution of a pending remote buzz: keep the pinned position,
    // attribute it to the equalized winner.
    if (lockouts.includes(name)) {
      // Winner is locked out: undo the pause, reopen the buzzers.
      undoStack.pop();   // the buzz_pending mark — the action never happened
      pendingBuzz = null; selPlayer = null; earlyAnswer = null;
      roomArmed = null;
      resumeReading();
      syncRoom(); render();
      return;
    }
    delete pendingBuzz.tentative;
    if (!state.players.includes(name)) apply({ type: 'player_join', player: name, team: null });
    selPlayer = name;
    render();
    // A typed answer can outrun the window resolution across the two
    // sockets; apply it now that the winner is known.
    const early = earlyAnswer;
    earlyAnswer = null;
    if (early && early.name === name) handleRemoteAnswer(name, early.text);
    return;
  }
  // No pending (old worker without buzz_pending, or state changed): the
  // original single-message path.
  if (!cur || cur.pending || state.phase !== 'reading' || pendingBuzz) { syncRoom(); return; }
  if (lockouts.includes(name)) { roomArmed = null; syncRoom(); return; }  // reopen buzzers
  pushUndo();
  if (!state.players.includes(name)) apply({ type: 'player_join', player: name, team: null });
  pauseReading();
  pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
  selPlayer = name;
  render();
}

// Audio-broadcast control traffic (everything room.js's named handlers
// don't consume). The host aggregates phone readiness for the start
// gate, and schedules its OWN playback off the server-stamped echoes of
// its start/resume messages — so host and phones anchor to the same
// server instant instead of the host leading by its send latency.
function handleRoomAudioMessage(m) {
  if (m.t === 'sync') {
    syncSamples.push(qbSync.sampleFromExchange(m.c, m.s, Date.now()));
    if (syncSamples.length > 8) syncSamples.shift();
    return;
  }
  if (m.t === 'audio_ready' || m.t === 'audio_error') {
    if (!m.name || !m.qid) return;
    if (!audioResolved.has(m.name)) audioResolved.set(m.name, new Set());
    audioResolved.get(m.name).add(m.qid);
    if (m.t === 'audio_error') {
      if (!audioFailed.has(m.name)) audioFailed.set(m.name, new Set());
      audioFailed.get(m.name).add(m.qid);
    }
    checkAudioGate();
    renderScoring();
    return;
  }
  if (m.t === 'audio_resync') {
    // A phone (re)joined mid-stream: hand it the current position.
    if (m.name && broadcasting() && !cur.pending) room.send(buildAudioState(m.name));
    return;
  }
  if (m.t === 'audio_start' || m.t === 'audio_resume') {
    // Echo of our own scheduled message, stamped with the start instant.
    if (bcastFallback) { clearTimeout(bcastFallback); bcastFallback = null; }
    if (!cur || m.qid !== cur.q._id || pendingBuzz) return;
    const d = Math.max(0, qbSync.playDelay(m.at, hostOffset(), Date.now()));
    if (m.t === 'audio_start') setTimeout(() => beginReading(m.qid), d);
    else setTimeout(() => {
      if (cur && cur.q._id === m.qid && state.phase === 'reading' && !pendingBuzz) player.resume();
    }, d);
  }
}

// Per-question start gate: fire once every connected phone has resolved
// (downloaded or failed) the question's audio, or the deadline passes.
// Empty rooms resolve instantly; stragglers get marked in the roster.
function checkAudioGate() {
  if (!audioGate) return;
  const resolvedFor = new Set(
    [...connected].filter(n => audioResolved.get(n)?.has(audioGate.qid)));
  if (!qbSync.gateResolved([...connected], resolvedFor, audioGate.deadline, Date.now())) return;
  const { qid } = audioGate;
  clearTimeout(audioGate.timer);
  audioGate = null;
  if (!cur || cur.q._id !== qid || !cur.pending) return;
  room.send({ t: 'audio_start', qid, pos: 0, rate: voiceRate() });
  // Old worker (no audio relay): no echo will come — start locally so
  // the host degrades to exactly the pre-broadcast behavior.
  bcastFallback = setTimeout(() => { bcastFallback = null; beginReading(qid); }, 1000);
}

// A player typed an answer on their phone. Run the checker: accept /
// reject score immediately, prompt goes back to the player and keeps
// the buzz open for another try. With suggestions off (or an upload
// whose answerline confuses the checker) the answer just fills the
// adjudication field for the host's ✓/✗.
function handleRemoteAnswer(name, text) {
  if (!pendingBuzz || !text) return;
  if (pendingBuzz.tentative) { earlyAnswer = { name, text }; return; }
  if (name !== selPlayer) return;
  $('givenanswer').value = text;
  let v = null;
  if ($('optChecker').checked && cur && typeof qbCheckAnswer === 'function') {
    try { v = qbCheckAnswer(cur.q.answer, text); } catch (e) { v = null; }
  }
  if (!v) { render(); return; }
  if (v.directive === 'prompt') {
    room.send({ t: 'answer_result', name, result: 'prompt', prompt: v.directedPrompt ?? null });
    render();
  } else if (v.directive === 'accept' && powerChoices()) {
    render();   // powered host-read clock: the host picks the tier (+15/+10)
  } else {
    applyVerdict(v.directive === 'accept' ? 'correct' : 'wrong');
  }
}

function buildSnapshot() {
  const totals = scores(state);
  const tTotals = teamScores(state);
  const tstats = tossupStats(state);
  const bstats = bonusStats(state);
  const lockouts = state.current ? state.current.lockouts : [];
  return {
    label: cur ? (qidMeta[cur.q._id]?.label || '') : '',
    bonus: bonusActive() ? bonusTeamLabel() : null,
    teams: teamList.map(t => ({
      name: t, score: tTotals[t] ?? 0,
      bonus: bstats.teams[t]?.points ?? 0,
      heard: bstats.teams[t]?.heard ?? 0,
      ppb: bstats.teams[t]?.ppb ?? 0,
    })),
    players: state.players.map(p => ({
      name: p, team: state.teams[p] || null,
      score: totals[p] ?? 0, locked: lockouts.includes(p),
      stats: tstats[p] ?? null,
    })),
  };
}

function syncRoom() {
  if (!room) return;
  room.send({ t: 'state', snapshot: buildSnapshot() });
  const wantArmed = !!(cur && !cur.pending && state.phase === 'reading' && !pendingBuzz);
  if (wantArmed !== roomArmed) {
    roomArmed = wantArmed;
    room.send({ t: wantArmed ? 'arm' : 'disarm' });
  }
}

// ---------- sheets ----------
for (const id of ['setsheet', 'rostersheet', 'settingsheet']) {
  $(id).onclick = e => { if (e.target === $(id)) $(id).classList.remove('open'); };
}
$('setbtn').onclick = () => $('setsheet').classList.add('open');
$('gearbtn').onclick = () => $('settingsheet').classList.add('open');
$('rosterbtn').onclick = () => { buildRosterEditor(); $('rostersheet').classList.add('open'); };

// ---------- set & packet picker ----------
// In TTS-audio mode the picker only offers sets whose tossups ALL have
// audio (the catalog carries every tossup id + set index; the audio
// index is the qid list — coverage is one client-side pass). Other
// modes list everything. If the audio index fails to load the filter
// stays off and the per-question reveal fallback covers the gaps.
let audioFullSets = null;  // Set of catalog set indices at 100% tossup audio

fetch(QDATA_BASE + '/catalog.json').then(r => r.json()).then(cat => {
  CAT = cat;
  renderSetList($('setsearch').value);
  computeAudioCoverage();
});
audio.loadAudioIndex().then(computeAudioCoverage).catch(() => {});
$('setsheet').classList.add('open');   // boot straight into picking a set

function computeAudioCoverage() {
  if (!CAT || !audio.indexLoaded()) return;   // needs both fetches
  const total = new Array(CAT.sets.length).fill(0);
  const covered = new Array(CAT.sets.length).fill(0);
  const ids = CAT.tossups.id, setIdx = CAT.tossups.set;
  for (let i = 0; i < ids.length; i++) {
    const s = setIdx[i];
    if (s < 0) continue;
    total[s]++;
    if (audio.hasAudio(ids[i])) covered[s]++;
  }
  audioFullSets = new Set();
  for (let s = 0; s < CAT.sets.length; s++) {
    if (total[s] && covered[s] === total[s]) audioFullSets.add(s);
  }
  renderSetList($('setsearch').value);
}

function renderSetList(filter) {
  if (!CAT) return;
  const q = filter.trim().toLowerCase();
  const audioOnly = $('modepick2').value === 'audio' && audioFullSets;
  const opts = CAT.sets.filter((s, i) =>
    (!q || s.name.toLowerCase().includes(q)) && (!audioOnly || audioFullSets.has(i)));
  $('setlist').innerHTML = opts.slice(0, 200).map(s =>
    `<option value="${s.slug}">${esc(s.name)} (diff ${s.difficulty ?? '?'})</option>`).join('');
  if (!SET) {
    $('setstatus').textContent = audioOnly
      ? `${opts.length} sets with full TTS audio` : `${opts.length} sets`;
  }
}
$('setsearch').oninput = e => renderSetList(e.target.value);

// Reading mode is choosable in the set sheet (before starting) AND in
// the header (mid-game); the two selects stay in sync. Audio mode
// narrows the set list, so a mode change re-renders it.
$('modepick2').onchange = () => { $('modepick').value = $('modepick2').value; renderSetList($('setsearch').value); };
$('modepick').onchange = () => { $('modepick2').value = $('modepick').value; renderSetList($('setsearch').value); };

$('setlist').onchange = async () => {
  const slug = $('setlist').value;
  $('setstatus').textContent = 'Loading set…';
  SET = await fetch(QDATA_BASE + '/sets/' + slug + '.json').then(r => r.json());
  setSlug = slug;
  $('packetpick').innerHTML = SET.packets.map((p, i) =>
    `<option value="${i}">Packet ${p.number ?? i + 1}${p.name ? ' — ' + esc(p.name) : ''} (${p.tossups.length} TU)</option>`).join('');
  const withAudio = SET.packets.flatMap(p => p.tossups).filter(t => audio.hasAudio(t._id)).length;
  const total = SET.packets.reduce((n, p) => n + p.tossups.length, 0);
  $('setstatus').textContent = `${SET.name} — ${withAudio}/${total} tossups have TTS audio`;
  $('loadbtn').disabled = false;
};

$('loadbtn').onclick = () => {
  packetIdx = +$('packetpick').value;
  packet = SET.packets[packetIdx];
  packetLabel = 'Packet ' + (packet.number ?? packetIdx + 1);
  tuIdx = -1;
  sendAudioManifest();   // phones start downloading the whole packet now
  $('setsheet').classList.remove('open');
  nextQuestion();
};

// ---------- upload your own packets (parsed client-side) ----------
// Each .docx/.txt file becomes one packet, parsed IN THE BROWSER by
// the vendored qb-packet-parser (qbreader's parser, JS port — see
// vendor/qb_packet_parser.mjs; no hosted service involved). Its output
// is the same qbreader doc shape the R2 sets use — question_sanitized,
// answers, even auto-classified categories — so everything downstream
// (reading modes, bonuses, rooms) works unchanged. Uploads have no TTS
// audio; audio mode falls back to reveal automatically.
let ParserClass = null;   // lazy-loaded: the bundle is ~2 MB

// The parser needs to know whether the packet has question numbers /
// category tags, and guessing wrong ruins the parse — so try the
// combinations and keep the parse that finds the most questions.
async function parsePacketAuto(input, isDocx, name) {
  let best = null;
  for (const hasQuestionNumbers of [true, false]) {
    for (const hasCategoryTags of [false, true]) {
      try {
        const parser = new ParserClass({ hasQuestionNumbers, hasCategoryTags });
        const { data, warnings } = isDocx
          ? await parser.parseDocxPacket(input, name)
          : parser.parsePacket(input, name);
        const n = (data.tossups?.length || 0) + (data.bonuses?.length || 0);
        const score = n * 100 - warnings.length;
        if (n && (!best || score > best.score)) best = { data, warnings, score };
      } catch (e) { /* wrong settings for this packet — try the next combo */ }
    }
  }
  return best;
}

$('upload').onchange = async () => {
  const files = [...$('upload').files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return;
  $('loadbtn').disabled = true;
  if (!ParserClass) {
    $('setstatus').textContent = 'Loading parser…';
    ParserClass = (await import('./vendor/qb_packet_parser.mjs')).default;
  }
  const packets = [];
  let warned = 0;
  for (const f of files) {
    $('setstatus').textContent = `Parsing ${f.name}…`;
    const isDocx = /\.docx$/i.test(f.name);
    const input = isDocx ? await f.arrayBuffer() : await f.text();
    const best = await parsePacketAuto(input, isDocx, f.name);
    if (!best) {
      $('setstatus').textContent = `${f.name}: couldn’t find any questions — is it a packet in docx/txt form?`;
      return;
    }
    warned += best.warnings.length;
    const number = packets.length + 1;
    packets.push({
      number,
      name: f.name.replace(/\.[^.]*$/, ''),
      tossups: (best.data.tossups || []).map((t, j) => ({ ...t, _id: `up-${number}-t${j}` })),
      bonuses: (best.data.bonuses || []).map((b, j) => ({ ...b, _id: `up-${number}-b${j}` })),
    });
  }
  SET = { name: files.length === 1 ? packets[0].name : `Uploaded (${files.length} packets)`, packets };
  setSlug = null;
  $('packetpick').innerHTML = SET.packets.map((p, i) =>
    `<option value="${i}">Packet ${p.number}${p.name ? ' — ' + esc(p.name) : ''} (${p.tossups.length} TU)</option>`).join('');
  const tus = packets.reduce((n, p) => n + p.tossups.length, 0);
  const bs = packets.reduce((n, p) => n + p.bonuses.length, 0);
  $('setstatus').textContent = `${SET.name} — ${tus} tossups, ${bs} bonuses`
    + (warned ? ` · ${warned} parse warning${warned > 1 ? 's' : ''} (check questions look right)` : '')
    + ' (no TTS audio for uploads)';
  $('loadbtn').disabled = false;
};

// ---------- live settings ----------
$('optScoring').onchange = () =>
  dispatch({ type: 'configure', patch: { scoring: $('optScoring').checked } });
$('optSuper').onchange = () =>
  dispatch({ type: 'configure', patch: { points: { superpower: $('optSuper').checked ? 20 : null } } });
$('optBonuses').onchange = render;
$('optChecker').onchange = render;
$('optBonusReveal').value = localStorage.qbmodBonusAns || 'auto';
$('optBonusReveal').onchange = () => { localStorage.qbmodBonusAns = $('optBonusReveal').value; };
// Broadcast TTS to phones: off by default — in-person rooms must stay
// silent. Toggling on mid-packet ships the manifest so phones can catch
// up; toggling off mid-question silences them.
$('optBroadcast').checked = localStorage.qbmodBroadcast === '1';
$('optBroadcast').onchange = () => {
  localStorage.qbmodBroadcast = $('optBroadcast').checked ? '1' : '0';
  if ($('optBroadcast').checked) sendAudioManifest();
  else if (room && cur && cur.mode === 'audio') room.send({ t: 'audio_stop', qid: cur.q._id });
};
// Clear all scores (e.g. starting a new game on the same roster): one
// engine event empties the log; roster, settings, and the current
// question survive. Undoable like any host action; past questions'
// qlog summaries refresh so room players' history stays truthful.
$('clearscores').onclick = () => {
  if (!confirm('Clear all scores?')) return;
  pushUndo();
  dispatch({ type: 'clear_scores' });
  for (const ql of qlog) if (ql.qid) ql.summary = summarize(ql.qid);
  if (room) room.send({ t: 'qlog', qlog });
  $('settingsheet').classList.remove('open');
};

// ---------- question flow ----------
function summarize(qid) {
  const lines = liveLog(state).filter(e => e.qid === qid);
  const parts = [];
  let bonusPts = 0, bonusWho = null;
  for (const e of lines) {
    if (e.kind === 'bonus') { bonusWho = e.team ?? e.player; bonusPts += e.points; continue; }
    parts.push(e.kind === 'dead' ? 'dead' : `${e.player} ${e.points > 0 ? '+' : ''}${e.points}`);
  }
  if (bonusWho != null) parts.push(`${bonusWho} bonus +${bonusPts}`);
  return parts.join(' · ') || 'skipped';
}

// A bonus is "heard" once any of its parts logged; only then does its
// text ship with the qlog entry — an unread bonus stays off the wire
// (it can still be read aloud late from review, so no spoilers).
const bonusHeard = qid => liveLog(state).some(e => e.kind === 'bonus' && e.qid === qid);

// Record a finished question into the players' browsable log.
function logQuestion() {
  if (!cur) return;
  const qid = cur.q._id;
  const entry = {
    qid,
    label: qidMeta[qid]?.label || '',
    question: cur.q.question_sanitized || cur.q.question || '',
    answer: cur.q.answer || '',
    summary: summarize(qid),
  };
  if (bonusHeard(qid)) entry.bonus = qidMeta[qid]?.bonus;
  qlog.push(entry);
  if (room) room.send({ t: 'qlog', qlog });
}

// A review edit changed a past question's outcome: refresh its qlog line.
function refreshQlog(qid) {
  const ql = qlog.find(x => x.qid === qid);
  if (!ql) return;
  ql.summary = summarize(qid);
  if (!ql.bonus && bonusHeard(qid)) ql.bonus = qidMeta[qid]?.bonus;
  if (room) room.send({ t: 'qlog', qlog });
}

async function nextQuestion(autoStart) {
  stopClocks();
  logQuestion();
  pendingBuzz = null; selPlayer = null; controlling = null; earlyAnswer = null;
  tuIdx++;
  if (tuIdx >= packet.tossups.length) { renderPacketDone(); return; }
  const q = packet.tossups[tuIdx];
  const { units, powerIdx, superpowerIdx } = questionUnits(q.question_sanitized || q.question || '');
  let mode = $('modepick').value;
  const wantedAudio = mode === 'audio';
  if (mode === 'audio' && !audio.hasAudio(q._id)) mode = 'reveal';  // never full text: no spoilers
  // pending = the ready gate: the question is loaded (audio buffering)
  // but nothing reads and buzzers stay closed. Only a fresh packet load
  // waits for the host's Start; Next auto-starts (autoStart) once set up.
  cur = { q, units, powerIdx, superpowerIdx, mode, noAudio: wantedAudio && mode !== 'audio',
          pending: true,
          unitIdx: mode === 'text' ? null : 0,
          slow: mode === 'reveal' ? slowSpans(units.map(u => u.t)) : null,
          mapper: null, timer: null, bonus: null };
  qidMeta[q._id] = { label: `${packetLabel} · Tossup ${tuIdx + 1}` };
  const bn = bonusRef();
  if (bn) {
    qidMeta[q._id].bonus = {
      leadin: bn.leadin_sanitized || bn.leadin || '',
      parts: bn.parts_sanitized || bn.parts || [],
      answers: bn.answers || [],
    };
  }

  if (mode === 'audio') {
    const c = cur;
    c.mapper = await audio.positionMapper(q._id, units.length);
    if (cur !== c) return;   // undone/superseded while the sidecar loaded
    player.load(q._id);   // buffer ahead; play() waits for enough data
    player.el.playbackRate = voiceRate();
    player.el.onerror = () => degradeToReveal();
  }
  if (autoStart) { startReading(false); return; }   // Next's click already pushed undo
  render();
}

function startReading(withUndo) {
  if (!cur || !cur.pending || cur.starting) return;
  if (withUndo !== false) pushUndo();
  if (broadcasting()) {
    // Scheduled start: wait for every phone's download (or the 4s
    // deadline), send audio_start, and begin on the server-stamped
    // echo — question_start (and so the buzzer arm) lands at the same
    // instant the audio actually starts everywhere.
    cur.starting = true;
    audioGate = { qid: cur.q._id, deadline: Date.now() + 4000 };
    audioGate.timer = setTimeout(checkAudioGate, 4000);
    checkAudioGate();
    render();
    return;
  }
  beginReading(cur.q._id);
}

// The actual start (old startReading body). In broadcast mode this runs
// at the scheduled instant (or the no-echo fallback); qid guards
// against the question changing while a start was in flight.
function beginReading(qid) {
  if (!cur || !cur.pending || (qid && cur.q._id !== qid)) return;
  cur.starting = false;
  cur.pending = false;
  dispatch({ type: 'question_start', qid: cur.q._id, powerIdx: cur.powerIdx,
             superpowerIdx: cur.superpowerIdx, unitCount: cur.units.length });
  if (cur.mode === 'audio') {
    attachAudioHandlers();
    player.play().catch(() => degradeToReveal());
  } else if (cur.mode === 'reveal') {
    scheduleReveal();
  }
  render();
}

// The shared audio element's clock/end handlers (set once per page —
// they close over the module state, so they serve every question; a
// session resume needs them re-attached after a refresh).
function attachAudioHandlers() {
  player.el.ontimeupdate = () => {
    if (!cur || state.phase !== 'reading') return;
    cur.unitIdx = cur.mapper(player.el.currentTime, player.el.duration);
    renderProgress();
  };
  player.el.onended = () => dispatch({ type: 'reading_finished' });
}

function degradeToReveal() {
  if (!cur || cur.mode !== 'audio') return;
  // Host audio died = the room's clock died: silence the phones too.
  if (broadcasting() && (!cur.pending || cur.starting)) {
    room.send({ t: 'audio_stop', qid: cur.q._id });
  }
  clearBcastTimers();
  const wasStarting = cur.starting;
  cur.starting = false;
  cur.mode = 'reveal'; cur.degraded = true;
  cur.unitIdx = 0;
  cur.slow = slowSpans(cur.units.map(u => u.t));
  if (!cur.pending) scheduleReveal();   // pre-Start failures wait for Start
  else if (wasStarting) beginReading(cur.q._id);   // mid-gate failure: reveal now
  render();
}

// Reveal pacing = the reader's engine: 60000/wpm per unit, slowed by
// SLOW_FACTOR when the current OR next unit is in a slow note-run span
// (reader.js scheduleStep — same lookahead, same factor). The slider is
// read live each tick, so speed changes apply mid-question.
function msPerUnit(i) {
  const base = 60000 / (+$('wpm').value || 380);
  return cur.slow && (cur.slow.has(i) || cur.slow.has(i + 1)) ? base * SLOW_FACTOR : base;
}

$('wpm').value = +localStorage.qbmodWpm || 380;
$('wpmval').textContent = $('wpm').value;
$('wpm').oninput = () => {
  $('wpmval').textContent = $('wpm').value;
  localStorage.qbmodWpm = $('wpm').value;
};

// TTS playback speed — the reader's vrate control: pitch-preserved
// playbackRate, live mid-question. Reapplied after each load(): setting
// src can reset playbackRate to the default.
function voiceRate() { return Math.min(2, Math.max(0.5, +$('vrate').value || 0.95)); }
try { player.el.preservesPitch = true; } catch (e) { /* older browsers */ }
$('vrate').value = +localStorage.qbmodVrate || 0.95;
$('vrateval').textContent = voiceRate().toFixed(2) + 'x';
$('vrate').oninput = () => {
  $('vrateval').textContent = voiceRate().toFixed(2) + 'x';
  localStorage.qbmodVrate = $('vrate').value;
  player.el.playbackRate = voiceRate();
  // Rate + position in one anchor so phones re-derive their clocks.
  if (broadcasting() && !cur.pending) {
    room.send({ t: 'audio_rate', qid: cur.q._id, pos: player.el.currentTime,
                rate: voiceRate(), playing: state.phase === 'reading' && !player.el.paused });
  }
};

function scheduleReveal() {
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => {
    if (!cur || state.phase !== 'reading' || cur.mode !== 'reveal') return;
    cur.unitIdx++;
    if (cur.unitIdx >= cur.units.length) {
      renderQText();
      dispatch({ type: 'reading_finished' });
      return;
    }
    renderQText();
    scheduleReveal();
  }, msPerUnit(cur.unitIdx));
}

function pauseReading() {
  if (!cur) return;
  if (cur.mode === 'audio') {
    player.pause();
    // The phones already paused on the broadcast buzz_pending (or their
    // own optimistic buzz) — this anchor just re-pins the exact position.
    if (broadcasting() && !cur.pending) {
      if (bcastFallback) { clearTimeout(bcastFallback); bcastFallback = null; }
      room.send({ t: 'audio_pause', qid: cur.q._id, pos: player.el.currentTime });
    }
  }
  if (cur.mode === 'reveal') clearTimeout(cur.timer);
}

function resumeReading() {
  if (!cur || state.phase !== 'reading') return;
  if (cur.mode === 'audio') {
    if (broadcasting()) {
      // Scheduled, like the start: everyone (host included) resumes at
      // the server-stamped instant from the echo; the fallback covers a
      // worker without the audio relay.
      if (bcastFallback) clearTimeout(bcastFallback);
      room.send({ t: 'audio_resume', qid: cur.q._id, pos: player.el.currentTime, rate: voiceRate() });
      bcastFallback = setTimeout(() => {
        bcastFallback = null;
        if (cur && state.phase === 'reading' && !pendingBuzz) player.resume();
      }, 1000);
    } else player.resume();
  }
  if (cur.mode === 'reveal') scheduleReveal();
}

function stopClocks() {
  // Leaving the question with phone audio live (or a start in flight):
  // silence the room before the local teardown.
  if (broadcasting() && (!cur.pending || cur.starting)) {
    room.send({ t: 'audio_stop', qid: cur.q._id });
  }
  clearBcastTimers();
  if (cur) cur.starting = false;
  player.stop();
  if (cur) clearTimeout(cur.timer);
}

const posNow = () => (cur && cur.mode !== 'text' ? cur.unitIdx : null);

// Eligible = able to take this buzz (not locked out).
function eligible() {
  const lockouts = state.current ? state.current.lockouts : [];
  return state.players.filter(p => !lockouts.includes(p));
}

function buzz(unitIdx = undefined) {
  if (!cur || cur.pending || state.phase !== 'reading') return;
  pushUndo();
  pauseReading();
  pendingBuzz = { unitIdx: unitIdx === undefined ? posNow() : unitIdx, ts: Date.now() };
  const el = eligible();
  selPlayer = el.length === 1 ? el[0] : null;
  render();
}

function applyVerdict(result, points = null, noUndo = false) {
  if (!pendingBuzz || !selPlayer) return;
  if (!noUndo) pushUndo();
  const buzzer = selPlayer;
  dispatch({ type: 'buzz', player: selPlayer, unitIdx: pendingBuzz.unitIdx, ts: pendingBuzz.ts });
  const given = $('givenanswer').value.trim() || null;
  const source = given && suggested() === result ? 'checker' : 'host';
  if (result === 'correct') controlling = selPlayer;
  dispatch({ type: 'verdict', result, points, source, answer: given });
  pendingBuzz = null; selPlayer = null; earlyAnswer = null;
  // Room players get the verdict on their phones (their own buzz shows
  // correct/wrong; a typed answer's prompt loop closes here too).
  if (room) room.send({ t: 'answer_result', name: buzzer, result });
  $('givenanswer').value = '';
  resumeReading();
  render();
}

// With power marks but a host-read clock (full-text and reveal modes:
// the moderator reads aloud, so the on-screen position is approximate),
// a correct verdict can't derive its tier — the host picks it. Returns
// the point choices ([20,] 15, 10) or null when auto-scoring is fine.
function powerChoices() {
  if (!cur || cur.mode === 'audio' || !state.config.scoring) return null;
  if (!state.current || state.current.powerIdx == null) return null;
  const p = state.config.points;
  const sp = state.current.superpowerIdx != null && p.superpower != null ? [p.superpower] : [];
  return [...sp, p.power, p.get];
}

// Clear a pending buzz as if it never happened: no verdict, no score
// line, no lockout — buzzer checks, accidental taps. The buzz's undo
// mark goes with it (the voided-buzz pattern); the buzzer's phone
// releases and the room re-arms on the next sync.
function clearBuzz() {
  if (!pendingBuzz || pendingBuzz.tentative) return;
  undoStack.pop();
  if (room && selPlayer) room.send({ t: 'answer_result', name: selPlayer, result: 'done' });
  pendingBuzz = null; selPlayer = null; earlyAnswer = null;
  $('givenanswer').value = '';
  resumeReading();
  render();
}

// Stat-honest kind for host-forced points (mirrors the engine's
// override/padKind mapping): +15 IS a power, the neg value a neg.
function padKindFor(v) {
  const pts = state.config.points;
  return pts.superpower != null && v === pts.superpower ? 'superpower'
    : v === pts.power ? 'power'
    : v === pts.get ? 'get'
    : v === pts.neg ? 'neg'
    : v === 0 ? 'miss' : null;
}

// Player-row point buttons: during reading = buzz + verdict in one tap;
// with a pending buzz = assign player + verdict; in review = a real
// score line ON THE REVIEWED QUESTION (redo of a mis-scored buzz);
// otherwise = adjustment.
function directPoints(p, v) {
  if (review) {
    const qid = packet.tossups[review.idx]._id;
    pushUndo();
    dispatch({ type: 'award', player: p, points: v, qid,
               kind: padKindFor(v) ?? 'award', reason: 'adjust' });
    refreshQlog(qid);
    return;
  }
  if (cur && !cur.pending && state.phase === 'reading') {
    pushUndo();   // one level for the whole buzz+verdict tap
    pauseReading();
    pendingBuzz = { unitIdx: posNow(), ts: Date.now() };
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v, true);
  } else if (pendingBuzz) {
    selPlayer = p;
    applyVerdict(v > 0 ? 'correct' : 'wrong', v);
  } else if (v !== 0) {
    pushUndo();
    dispatch({ type: 'award', player: p, points: v, reason: 'adjust' });
  }
}

function suggested() {
  const given = $('givenanswer').value.trim();
  if (!given || !cur || typeof qbCheckAnswer !== 'function') return null;
  try {
    const v = qbCheckAnswer(cur.q.answer, given);
    return v.directive === 'accept' ? 'correct'
      : v.directive === 'reject' ? 'wrong' : 'prompt';
  } catch (e) { return null; }
}

// ---------- controls ----------
// Context menu (right-click undo):
function showMenu(x, y, items) {
  hideMenu();
  const m = document.createElement('div');
  m.id = 'ctxmenu';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    b.onclick = () => { hideMenu(); it.run(); };
    m.appendChild(b);
  }
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  document.body.appendChild(m);
}
function hideMenu() { document.getElementById('ctxmenu')?.remove(); }
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#ctxmenu')) hideMenu();
});

$('buzz').onclick = () => buzz();
$('buzz').oncontextmenu = e => {
  if (!pendingBuzz) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [{ label: 'undo buzz', run: clearBuzz }]);
};
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (review) {
    if (/^(Digit|Numpad)[1-9]$/.test(e.code)) {
      const c = $('bonuspanel').querySelector('.bgive[data-i="' + (+e.code.slice(-1) - 1) + '"]');
      if (c) { c.checked = !c.checked; c.onchange(); }
    }
    return;
  }
  if (e.code === 'Space') {
    if (cur && state.phase === 'reading') { e.preventDefault(); buzz(); }
    else if (bonusActive() && cur.bonus) { e.preventDefault(); bonusStep(); }
  } else if (bonusActive() && cur.bonus && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
    const i = +e.code.slice(-1) - 1;
    if (i < cur.bonus.n) bonusToggle(i, !cur.bonus.given[i]);
  }
});
$('startbtn').onclick = () => startReading();
$('restartbtn').onclick = () => {
  // Replay the TTS from the top (missed audio, glitch). Buzz state and
  // scores are untouched; the position clock rewinds with the audio.
  if (!cur || cur.mode !== 'audio' || cur.pending) return;
  player.el.currentTime = 0;
  cur.unitIdx = 0;
  renderProgress();
  if (state.phase === 'reading' && !pendingBuzz) {
    if (broadcasting()) {
      // Restart is just a resume from 0, scheduled like any other.
      player.pause();
      if (bcastFallback) clearTimeout(bcastFallback);
      room.send({ t: 'audio_resume', qid: cur.q._id, pos: 0, rate: voiceRate() });
      bcastFallback = setTimeout(() => {
        bcastFallback = null;
        player.play().catch(() => degradeToReveal());
      }, 1000);
    } else player.play().catch(() => degradeToReveal());
  }
};
$('playbtn').onclick = () => {
  if (!cur || cur.pending || state.phase !== 'reading') return;
  if (cur.mode === 'audio') {
    // Through pause/resumeReading so the room hears about it too.
    if (player.el.paused) resumeReading(); else pauseReading();
  }
  if (cur.mode === 'reveal') {
    if (cur.timer) { clearTimeout(cur.timer); cur.timer = null; } else scheduleReveal();
  }
};
$('finishedbtn').onclick = () => dispatch({ type: 'reading_finished' });
$('deadbtn').onclick = () => {
  if (!cur || (state.phase !== 'reading' && state.phase !== 'buzzed' && !pendingBuzz)) return;
  pushUndo();
  pauseReading();
  // Deading over a pending remote buzz: release the player's answer bar
  // ('done' is terminal but not a wrong on their screen).
  if (room && pendingBuzz && selPlayer) room.send({ t: 'answer_result', name: selPlayer, result: 'done' });
  pendingBuzz = null; earlyAnswer = null;
  dispatch({ type: 'dead' });
};
$('nextbtn').onclick = () => {
  if (review) { reviewNav(1); return; }
  pushUndo();
  if (state.phase === 'done') dispatch({ type: 'next' });
  nextQuestion(true);
};
$('prevbtn').onclick = () => reviewNav(-1);
$('undobtn').onclick = undo;
$('vcorrect').onclick = () => applyVerdict('correct');
$('vwrong').onclick = () => applyVerdict('wrong');
$('vclear').onclick = clearBuzz;
$('givenanswer').oninput = renderSuggestion;

// ---------- session persistence (survive a host refresh) ----------
// Everything re-derives from the engine event log (event sourcing), so
// the whole session — scores, packet position, the live question, even
// a pending buzz — saves to localStorage after every action and
// rebuilds by replay on load. Rejoining the room is indistinguishable
// from the auto-reconnect after a network blip, so this costs zero
// extra server traffic. The undo stack is the one thing that does not
// survive a refresh. Mid-question resumes come back PAUSED at the
// saved position (undo semantics): play / ⟲ to go on.
const SESSION_KEY = 'qbmodSession';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // matches the room TTL

function saveSession() {
  if (!packet) return;
  const pb = pendingBuzz && { ...pendingBuzz };
  if (pb) delete pb.tentative;   // any buzz window resolved long ago
  try {
    localStorage[SESSION_KEY] = JSON.stringify({
      v: 1, ts: Date.now(),
      title: `${SET.name} · ${packetLabel} · TU ${Math.min(tuIdx + 1, packet.tossups.length)}/${packet.tossups.length}`,
      set: setSlug ? { slug: setSlug } : { data: SET },
      packetIdx, tuIdx, packetLabel,
      mode: $('modepick').value,
      events, teamList, qlog, qidMeta,
      room: room ? { code: room.code, server: room.server } : null,
      pendingBuzz: pb, selPlayer, controlling,
      cur: cur && {
        pending: !!cur.pending, mode: cur.mode, degraded: !!cur.degraded,
        noAudio: !!cur.noAudio, unitIdx: cur.unitIdx,
        audioTime: cur.mode === 'audio' ? player.el.currentTime : 0,
        bonus: cur.bonus,
      },
    });
  } catch (e) { /* quota: refresh persistence degrades, play continues */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage[SESSION_KEY] || 'null');
    return s && s.v === 1 && Date.now() - s.ts < SESSION_TTL_MS ? s : null;
  } catch (e) { return null; }
}

async function resumeSession(s) {
  SET = s.set.slug
    ? await fetch(QDATA_BASE + '/sets/' + s.set.slug + '.json').then(r => r.json())
    : s.set.data;
  setSlug = s.set.slug ?? null;
  packetIdx = s.packetIdx;
  packet = SET.packets[packetIdx];
  packetLabel = s.packetLabel;
  tuIdx = s.tuIdx;
  $('modepick').value = s.mode;
  $('modepick2').value = s.mode;
  teamList = s.teamList || [];
  qlog.length = 0;
  qlog.push(...(s.qlog || []));
  Object.assign(qidMeta, s.qidMeta || {});
  events.length = 0;
  events.push(...(s.events || []));
  state = events.reduce(reduce, initialState({}));
  $('optScoring').checked = state.config.scoring;
  $('optSuper').checked = state.config.points.superpower != null;
  controlling = s.controlling ?? null;
  selPlayer = s.selPlayer ?? null;
  pendingBuzz = s.pendingBuzz ?? null;
  cur = null;
  if (s.cur && tuIdx >= 0 && tuIdx < packet.tossups.length) {
    const q = packet.tossups[tuIdx];
    const { units, powerIdx, superpowerIdx } = questionUnits(q.question_sanitized || q.question || '');
    cur = { q, units, powerIdx, superpowerIdx, mode: s.cur.mode, noAudio: !!s.cur.noAudio,
            degraded: !!s.cur.degraded, pending: !!s.cur.pending, unitIdx: s.cur.unitIdx,
            slow: s.cur.mode === 'reveal' ? slowSpans(units.map(u => u.t)) : null,
            mapper: null, timer: null, bonus: s.cur.bonus ?? null };
    if (cur.mode === 'audio') {
      const c = cur;
      c.mapper = await audio.positionMapper(q._id, units.length);
      if (cur !== c) return;
      player.load(q._id);
      player.el.playbackRate = voiceRate();
      player.el.onerror = () => degradeToReveal();
      attachAudioHandlers();
      const t = s.cur.audioTime || 0;
      player.el.addEventListener('loadedmetadata', () => {
        try { player.el.currentTime = t; } catch (e) { /* not seekable yet */ }
      }, { once: true });
    }
  }
  if (s.room) hostRoom(s.room.code, s.room.server);
  $('setsheet').classList.remove('open');
  if (tuIdx >= packet.tossups.length) { renderPacketDone(false); return; }
  render();
}

// ---------- rendering ----------
function render() {
  renderHeader();
  renderScoring();
  renderHistory();
  renderMain();
  $('undobtn').classList.toggle('hidden', !undoStack.length);
  syncRoom();
  saveSession();
}

function renderHeader() {
  $('setname').innerHTML = !packet ? 'no packet loaded'
    : `${esc(SET.name)} · ${esc(packetLabel)} · <b>TU ${Math.min(tuIdx + 1, packet.tossups.length)}</b>/${packet.tossups.length}`;
  // Buzz takeover (settled via mockups: option D): while a buzz is
  // being adjudicated the header turns red with the buzzer's name and
  // the screen edge pulses — visible from across the room.
  const buzzed = !!pendingBuzz && !review;
  document.querySelector('header').classList.toggle('buzzed', buzzed);
  document.body.classList.toggle('buzzglow', buzzed);
  if (buzzed) {
    const team = selPlayer && state.teams[selPlayer];
    $('buzzhdr').innerHTML =
      `<span class="bname">🔔 ${esc(selPlayer ? selPlayer + ' buzzed' : 'buzzed')}</span>`
      + (team ? `<span class="bteam">${esc(team)}</span>` : '');
  }
}

function renderMain() {
  if (review) { renderReview(); return; }
  $('reviewlines').classList.add('hidden');
  if (!cur) return;
  const q = cur.q;
  const phase = state.phase;
  const hostReads = cur.mode === 'text';

  $('modeline').innerHTML =
    cur.degraded ? '<span class="warn">⚠ audio failed for this question — revealing text</span>'
    : cur.noAudio ? '<span class="warn">⚠ no TTS audio for this question — revealing text</span>'
    : cur.starting ? '♪ syncing phones…'
    : cur.mode === 'audio' ? '♪ reading aloud — text hidden until the end'
      + (broadcasting() ? ' · phones hear it too' : '')
    : cur.mode === 'reveal' ? 'word-by-word reveal'
    : 'full text — you read';

  renderQText();

  const showAnswer = hostReads || phase === 'done';
  $('anspanel').classList.toggle('hidden', !showAnswer);
  if (showAnswer) {
    $('anspanel').innerHTML = '<span class="lbl">Answer</span> ' + (q.answer || '');
  }

  const pending = !!cur.pending;
  $('shortcuts').classList.toggle('hidden', !pending);
  $('startbtn').classList.toggle('hidden', !pending);
  $('startbtn').disabled = !!cur.starting;
  $('restartbtn').classList.toggle('hidden', pending || cur.mode !== 'audio' || phase !== 'reading');
  $('progress').classList.toggle('hidden', pending || cur.mode !== 'audio' || phase === 'done');
  $('speedctl').classList.toggle('hidden', pending || cur.mode !== 'reveal' || phase !== 'reading');
  $('ratectl').classList.toggle('hidden', pending || cur.mode !== 'audio' || phase !== 'reading');
  $('playbtn').classList.toggle('hidden', pending || hostReads || phase !== 'reading');
  $('finishedbtn').classList.toggle('hidden', pending || !hostReads || phase !== 'reading');
  $('finishedbtn').disabled = !!state.current?.readingFinished;
  $('deadbtn').classList.toggle('hidden', pending || phase === 'done' || phase === 'idle');
  $('nextbtn').classList.toggle('hidden', !packet);
  $('nextbtn').disabled = false;
  // ◂ stays visible alongside Next; it enables between questions.
  const canReview = tuIdx > 0 && phase !== 'reading' && phase !== 'buzzed' && !pendingBuzz;
  $('prevbtn').classList.remove('hidden');
  $('prevbtn').disabled = !canReview;

  // The buzz button: armed while reading (except full-text mode, where
  // clicking the buzzed word replaces it); red while adjudicating.
  const armed = phase === 'reading' && !hostReads && !pending;
  $('buzz').classList.toggle('hidden', !(armed || pendingBuzz));
  $('buzz').classList.toggle('buzzed', !!pendingBuzz);
  $('buzz').textContent = pendingBuzz
    ? (selPlayer ? selPlayer + ' buzzed' : 'buzzed') : 'BUZZ (space)';
  $('buzz').disabled = !!pendingBuzz;

  $('adjrow').classList.toggle('hidden', !pendingBuzz);
  if (pendingBuzz) {
    $('givenanswer').classList.toggle('hidden', !$('optChecker').checked);
    const dis = !selPlayer;
    const tiers = powerChoices();
    $('vtiers').innerHTML = !tiers ? '' : tiers.map(v =>
      `<button class="good" data-v="${v}" ${dis ? 'disabled' : ''}>+${v}</button>`).join('');
    for (const b of $('vtiers').querySelectorAll('button')) {
      b.onclick = () => applyVerdict('correct', +b.dataset.v);
    }
    $('vcorrect').classList.toggle('hidden', !!tiers);
    $('vcorrect').disabled = dis;
    $('vwrong').disabled = dis;
    renderSuggestion();
  }
  renderBonus();
}

function renderQText() {
  if (!cur) return;
  if (cur.mode === 'audio' && state.phase !== 'done') {
    $('qtext').innerHTML = cur.pending
      ? '<i class="faint">♪ ready</i>'
      : '<i class="faint">♪ Audio playing — text hidden so everyone can play.</i>';
    return;
  }
  const hostReads = cur.mode === 'text';
  const upto = (cur.mode === 'reveal' && state.phase !== 'done') ? cur.unitIdx : cur.units.length;
  const buzzAt = pendingBuzz ? pendingBuzz.unitIdx : null;
  $('qtext').innerHTML = cur.units.map((u, i) => {
    const mark = (u.t === '(*)' || u.t === '(+)');
    const cls = [
      mark ? 'mark' : '',
      i >= upto ? 'unread' : '',
      hostReads && state.phase === 'reading' && !mark ? 'w' : '',
      buzzAt !== null && i === buzzAt ? 'buzzword' : '',
    ].filter(Boolean).join(' ');
    return (i && u.sep ? ' ' : '') + (cls ? `<span class="${cls}" data-i="${i}">${esc(u.t)}</span>` : esc(u.t));
  }).join('');
  if (hostReads && state.phase === 'reading') {
    for (const w of $('qtext').querySelectorAll('.w')) {
      w.onclick = () => buzz(+w.dataset.i);
    }
  }
}

function renderProgress() {
  const d = player.el.duration;
  if (d && isFinite(d)) $('progressfill').style.width = (player.el.currentTime / d * 100) + '%';
}

function renderSuggestion() {
  const s = suggested();
  $('suggestion').innerHTML = !s ? ''
    : s === 'prompt' ? '<span class="faint">checker: PROMPT</span>'
    : s === 'correct' ? '<span class="good">checker: ACCEPT</span>'
    : '<span class="bad">checker: REJECT</span>';
}

// ---------- bonus: space steps the reveal; checkboxes / 1-2-3 toggle ----------
// Points go to the controlling player's TEAM (bonus_part events carry
// the team; a teamless controller gets them individually). Parts are
// logged the moment their answer shows — 0 by default — so ppb has a
// bonuses-heard denominator; toggling a checkbox supersedes the line.
function bonusRef() { return packet && packet.bonuses && packet.bonuses[tuIdx]; }
function bonusActive() {
  return !!($('optBonuses').checked && cur && state.phase === 'done' && controlling && bonusRef());
}
function bonusTeamLabel() { return state.teams[controlling] || controlling; }

// Answers hidden until space (so the host can play): the mode default —
// on for TTS audio and word-by-word reveal, off for full text — unless
// the ⚙ setting pins it.
function bonusPlayalong() {
  const v = $('optBonusReveal').value || 'auto';
  if (v === 'hidden') return true;
  if (v === 'shown') return false;
  return !cur || cur.mode !== 'text';
}

function bonusEmit(i, points) {
  const team = state.teams[controlling] || null;
  dispatch({ type: 'bonus_part', qid: cur.q._id, partIdx: i, points,
             team, player: team ? null : controlling });
}

// Space: reveal the current part's answer, then the next part's text
// (with answers shown, a new part brings its answer along).
function bonusStep(noUndo = false) {
  if (!cur || !cur.bonus) return;
  const b = cur.bonus, el = $('bonuspanel');
  if (b.revealed >= b.n) return;    // nothing left to reveal
  if (!noUndo) pushUndo();
  if (b.revealed < b.shown) {
    const i = b.revealed++;
    el.querySelector('#bp' + i + ' .bans').classList.remove('hidden');
    if (!b.logged[i]) { b.logged[i] = true; bonusEmit(i, 0); }
  } else {
    el.querySelector('#bp' + b.shown).classList.remove('hidden');
    b.shown++;
    if (!b.playalong) return bonusStep(true);
  }
  if (b.revealed === b.n) el.querySelector('#bonusdone').classList.remove('hidden');
  bonusTotalLine();
}

function bonusToggle(i, give) {
  const b = cur && cur.bonus;
  if (!b || i >= b.shown) return;   // part not on screen yet
  pushUndo();
  b.given[i] = give;
  b.logged[i] = true;
  const box = $('bonuspanel').querySelector('.bgive[data-i="' + i + '"]');
  if (box) box.checked = give;
  bonusEmit(i, give ? state.config.points.bonusPart : 0);
  bonusTotalLine();
}

function bonusTotalLine() {
  const b = cur && cur.bonus;
  if (!b) return;
  const total = b.given.filter(Boolean).length * state.config.points.bonusPart;
  $('bonustotal').textContent = `bonus: +${total} to ${bonusTeamLabel()}`;
}

function renderBonus() {
  const el = $('bonuspanel');
  const bonus = bonusRef();
  const active = bonusActive();
  el.classList.toggle('hidden', !active);
  if (!active) { el.dataset.for = ''; return; }
  if (el.dataset.for === String(tuIdx)) return;   // built; handlers mutate in place
  el.dataset.for = String(tuIdx);

  const parts = bonus.parts_sanitized || bonus.parts || [];
  const answers = bonus.answers || [];
  // An undo (or a return from review) rebuilds the DOM from the
  // restored progress instead of starting the cycle over.
  const restored = !!(cur.bonus && cur.bonus.for === tuIdx);
  if (!restored) {
    cur.bonus = { for: tuIdx, n: parts.length, shown: 0, revealed: 0,
                  given: parts.map(() => false), logged: parts.map(() => false),
                  playalong: bonusPlayalong() };
  }

  el.innerHTML = `<div class="blabel">Bonus · ${esc(bonusTeamLabel())}</div>
    <div class="leadin">${esc(bonus.leadin_sanitized || bonus.leadin || '')}</div>`
    + parts.map((p, i) => `<div class="bpart hidden" id="bp${i}">
        <input type="checkbox" class="bgive" data-i="${i}" title="+${state.config.points.bonusPart} (key ${i + 1})">
        <div class="bbody">
          <div class="bq">${esc(p)}</div>
          <div class="bans hidden">→ ${answers[i] || ''}</div>
        </div>
      </div>`).join('')
    + `<div class="controls hidden" id="bonusdone"><span class="muted" id="bonustotal"></span></div>`;
  for (const c of el.querySelectorAll('.bgive')) {
    c.onchange = () => { c.blur(); bonusToggle(+c.dataset.i, c.checked); };
  }
  if (restored) applyBonusProgress(); else bonusStep(true);
}

function applyBonusProgress() {
  const b = cur.bonus, el = $('bonuspanel');
  for (let i = 0; i < b.shown; i++) el.querySelector('#bp' + i).classList.remove('hidden');
  for (let i = 0; i < b.revealed; i++) el.querySelector('#bp' + i + ' .bans').classList.remove('hidden');
  b.given.forEach((g, i) => { const c = el.querySelector('.bgive[data-i="' + i + '"]'); if (c) c.checked = g; });
  if (b.revealed === b.n) el.querySelector('#bonusdone').classList.remove('hidden');
  bonusTotalLine();
}

// ---------- review: browse previous questions, fix outcomes ----------
// ◂ steps back through the packet's completed tossups (between
// questions only); ▸ returns toward the live one. A reviewed question
// shows its full text + answer, its score lines with an edit pad
// (engine `override` — kind re-derives from the new points), and its
// bonus with live checkboxes (bonus_part supersede re-scores it).
function reviewNav(d) {
  if (!packet) return;
  const limit = Math.min(tuIdx, packet.tossups.length);
  if (!review) {
    if (d > 0 || limit <= 0) return;
    if (state.phase === 'reading' || state.phase === 'buzzed' || pendingBuzz) return;
    review = { idx: limit - 1 };
  } else {
    const to = review.idx + d;
    if (to >= limit) {
      review = null;
      $('bonuspanel').dataset.for = '';   // rebuild the live panel
      if (!cur) { renderPacketDone(false); return; }
    } else review = { idx: Math.max(0, to) };
  }
  render();
}

function renderReview() {
  const i = review.idx;
  const q = packet.tossups[i];
  $('modeline').innerHTML = `<span class="faint">review</span> · ${esc(qidMeta[q._id]?.label || 'Tossup ' + (i + 1))}`;
  const { units } = questionUnits(q.question_sanitized || q.question || '');
  $('qtext').innerHTML = units.map((u, j) => {
    const mark = u.t === '(*)' || u.t === '(+)';
    return (j && u.sep ? ' ' : '') + (mark ? `<span class="mark">${esc(u.t)}</span>` : esc(u.t));
  }).join('');
  $('anspanel').classList.remove('hidden');
  $('anspanel').innerHTML = '<span class="lbl">Answer</span> ' + (q.answer || '');
  for (const id of ['buzz', 'startbtn', 'restartbtn', 'playbtn', 'finishedbtn', 'deadbtn',
                    'progress', 'speedctl', 'ratectl', 'adjrow', 'shortcuts']) $(id).classList.add('hidden');
  $('nextbtn').classList.remove('hidden');
  $('nextbtn').disabled = false;
  $('prevbtn').classList.toggle('hidden', i <= 0);
  $('prevbtn').disabled = false;
  renderReviewLines(q._id);
  renderReviewBonus(i, q._id);
}

function renderReviewLines(qid) {
  const el = $('reviewlines');
  const entries = liveLog(state).filter(e => e.qid === qid && e.kind !== 'bonus');
  el.classList.toggle('hidden', !entries.length);
  if (!entries.length) { el.innerHTML = ''; return; }
  const opts = state.config.scoring ? [...state.config.pointPad, 0] : [];
  el.innerHTML = entries.map(e => {
    const idx = state.log.indexOf(e);
    const who = e.kind === 'dead' ? '<span class="faint">dead</span>'
      : `${esc(e.player ?? e.team ?? '')} · ${e.kind}${e.overridden ? ' <span class="faint">·</span>' : ''}`;
    const pad = e.kind === 'dead' ? '' : opts.map(v =>
      `<button data-e="${idx}" data-v="${v}" class="${v === e.points ? 'sel ' : ''}${
        v > 0 ? 'good' : v < 0 ? 'bad' : ''}">${v > 0 ? '+' + v : v}</button>`).join('');
    return `<div class="rline" data-e="${idx}" data-k="${esc(e.kind)}"><span class="rwho">${who}</span><span class="rpad">${pad}</span></div>`;
  }).join('');
  for (const b of el.querySelectorAll('button')) {
    b.onclick = () => {
      pushUndo();
      dispatch({ type: 'override', entryIdx: +b.dataset.e, points: +b.dataset.v });
      refreshQlog(qid);
    };
  }
  // Right-click a line: retract it — as if that buzz never happened
  // (scores, stats, lockout-free history all re-derive). Redo it via
  // the roster point pad, which scores onto the reviewed question.
  const TOSSUP_KINDS = ['superpower', 'power', 'get', 'neg', 'miss'];
  for (const div of el.querySelectorAll('.rline')) {
    div.oncontextmenu = ev => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY, [{
        label: TOSSUP_KINDS.includes(div.dataset.k) ? 'undo buzz' : 'remove line',
        run: () => {
          pushUndo();
          dispatch({ type: 'retract', entryIdx: +div.dataset.e });
          refreshQlog(qid);
        },
      }]);
    };
  }
}

// Who the reviewed bonus belongs to: the winner line is the live truth
// (a retract + redo may have moved the tossup to another team — new
// toggles then re-attribute part by part); bonus lines decide only
// when no winner line remains (a late-scored skipped bonus).
function reviewBonusSource(qid) {
  const entries = liveLog(state).filter(e => e.qid === qid);
  const t = entries.find(e => e.kind === 'power' || e.kind === 'get' || e.kind === 'superpower');
  if (t) {
    const team = state.teams[t.player] || null;
    return { team, player: team ? null : t.player };
  }
  const b = entries.find(e => e.kind === 'bonus');
  if (b) return { team: b.team, player: b.player };
  return null;
}

function renderReviewBonus(i, qid) {
  const el = $('bonuspanel');
  const bonus = packet.bonuses && packet.bonuses[i];
  const show = !!(bonus && $('optBonuses').checked);
  el.classList.toggle('hidden', !show);
  el.dataset.for = show ? 'r' + i : '';
  if (!show) return;
  const src = reviewBonusSource(qid);   // null on a dead tossup: read-only
  const parts = bonus.parts_sanitized || bonus.parts || [];
  const answers = bonus.answers || [];
  const given = parts.map((_, j) => {
    const e = liveLog(state).find(x => x.kind === 'bonus' && x.qid === qid && x.partIdx === j);
    return !!(e && e.points > 0);
  });
  el.innerHTML = `<div class="blabel">Bonus${src ? ' · ' + esc(src.team ?? src.player) : ''}</div>
    <div class="leadin">${esc(bonus.leadin_sanitized || bonus.leadin || '')}</div>`
    + parts.map((p, j) => `<div class="bpart">
        ${src ? `<input type="checkbox" class="bgive" data-i="${j}" ${given[j] ? 'checked' : ''}
                   title="+${state.config.points.bonusPart} (key ${j + 1})">` : ''}
        <div class="bbody">
          <div class="bq">${esc(p)}</div>
          <div class="bans">→ ${answers[j] || ''}</div>
        </div>
      </div>`).join('');
  for (const c of el.querySelectorAll('.bgive')) {
    c.onchange = () => {
      c.blur();
      pushUndo();
      dispatch({ type: 'bonus_part', qid, partIdx: +c.dataset.i,
                 points: c.checked ? state.config.points.bonusPart : 0,
                 team: src.team, player: src.player });
      refreshQlog(qid);
    };
  }
}

// ---------- scoring panels (consensus-scorekeeper style) ----------
function rosterColumns() {
  const cols = teamList.map(t => ({ team: t, players: state.players.filter(p => state.teams[p] === t) }));
  const unassigned = state.players.filter(p => !state.teams[p]);
  if (unassigned.length) cols.push({ team: null, players: unassigned });
  return cols;
}

function renderScoring() {
  const totals = scores(state);
  const tTotals = teamScores(state);
  const tstats = tossupStats(state);
  const bstats = bonusStats(state);
  const lockouts = state.current ? state.current.lockouts : [];
  const midQuestion = state.phase === 'reading' || state.phase === 'buzzed' || !!pendingBuzz;
  const pad = state.config.scoring ? [...state.config.pointPad, 0] : [];
  const cols = rosterColumns();
  const bar = `<div class="scorebar"><span class="grow"></span>
    <button id="addplayerq" title="Add a player">+ player</button>
    <button id="addteamq" title="Add a team">+ team</button></div>`;
  $('scoring').innerHTML = bar + cols.map(col => {
    const tb = col.team !== null && bstats.teams[col.team];
    const head = col.team === null
      ? `<div class="teamhead"><span class="tname unassigned">Players</span>${teamList.length ? '' : ''}</div>`
      : `<div class="teamhead"><span class="tname" data-team="${esc(col.team)}">${esc(col.team)}</span><span class="tscore">${tTotals[col.team] ?? 0}</span>${
          tb && tb.heard ? `<span class="tbonus" title="bonus points · ppb">bonus +${tb.points} · ppb ${tb.ppb.toFixed(1)}</span>` : ''}</div>`;
    const bcastQid = broadcasting() ? cur.q._id : null;
    const rows = col.players.map(p => {
      const locked = lockouts.includes(p);
      const offline = room && !connected.has(p);
      const amark = !bcastQid || offline ? ''
        : audioFailed.get(p)?.has(bcastQid)
          ? ' <span class="bad" title="audio failed on this phone — they can still buzz">♪✗</span>'
        : !audioResolved.get(p)?.has(bcastQid)
          ? ' <span class="faint" title="audio still downloading on this phone">♪…</span>'
        : '';
      const st = tstats[p] || { powers: 0, gets: 0, negs: 0 };
      const pb = !state.teams[p] && bstats.players[p];
      return `<div class="prow ${locked ? 'locked' : ''} ${p === selPlayer ? 'droptarget' : ''}" data-p="${esc(p)}">
        <span class="handle">≡</span>
        <span class="pname" data-p="${esc(p)}">${esc(p)}${offline
          ? ' <span class="faint" title="not connected to the room">○</span>' : ''}${amark}</span>
        <span class="pstat" title="powers/gets/negs">${st.powers}/${st.gets}/${st.negs}${
          pb && pb.heard ? ` · ppb ${pb.ppb.toFixed(1)}` : ''}</span>
        <span class="pscore">${totals[p] ?? 0}</span>
        <span class="pbtns">${pad.map(v =>
          `<button class="${v > 0 ? 'good' : v < 0 ? 'bad' : ''}" data-v="${v}"
             ${locked && midQuestion ? 'disabled' : ''}>${v > 0 ? '+' + v : v}</button>`).join('')}</span>
      </div>`;
    }).join('');
    return `<div class="team" data-teamcol="${col.team === null ? '' : esc(col.team)}">${head}${rows}</div>`;
  }).join('');

  $('addteamq').onclick = () => {
    let n = teamList.length + 1;
    while (teamList.includes('Team ' + n)) n++;
    teamList.push('Team ' + n);
    render();
  };
  $('addplayerq').onclick = () => {
    const name = (prompt('Player name') || '').trim();
    if (!name || state.players.includes(name)) return;
    dispatch({ type: 'player_join', player: name, team: teamList[0] ?? null });
  };

  for (const t of $('scoring').querySelectorAll('.tname[data-team]')) {
    t.onclick = () => {
      const from = t.dataset.team;
      const to = prompt('Rename team', from);
      if (!to || to === from || teamList.includes(to)) return;
      teamList[teamList.indexOf(from)] = to;
      for (const p of state.players) {
        if (state.teams[p] === from) apply({ type: 'player_move', player: p, team: to });
      }
      render();
    };
  }
  for (const row of $('scoring').querySelectorAll('.prow')) {
    const p = row.dataset.p;
    for (const b of row.querySelectorAll('.pbtns button')) {
      b.onclick = () => directPoints(p, +b.dataset.v);
    }
    // With a pending buzz, tapping a player's name marks them as the buzzer.
    row.querySelector('.pname').onclick = () => {
      if (pendingBuzz && eligible().includes(p)) { selPlayer = p; render(); }
    };
    // Right-click a player's row: while they hold the pending buzz,
    // clear it (no score line, no lockout); after their buzz scored,
    // undo it (stack replay — the verdict, the bonus, everything).
    row.oncontextmenu = e => {
      const items = [];
      if (pendingBuzz && (!selPlayer || selPlayer === p)) {
        items.push({ label: 'undo buzz', run: clearBuzz });
      } else if (!pendingBuzz && !review) {
        const live = liveLog(state);
        const lastTossup = [...live].reverse().find(x => x.kind !== 'bonus');
        if (lastTossup && lastTossup.player === p) {
          items.push({ label: 'undo ' + lastTossup.kind,
                       run: () => undoThrough(state.log.indexOf(lastTossup)) });
        }
      }
      if (!items.length) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, items);
    };
    row.querySelector('.handle').onpointerdown = e => startDrag(e, p, row);
  }
}

// Pointer drag: drop on a player row -> insert before them (adopting
// their team); drop on a team block -> append to that team.
function startDrag(e, p, row) {
  if (e.button) return;
  e.preventDefault();
  row.classList.add('dragging');
  const teams = [...$('scoring').querySelectorAll('.team')];
  const rows = [...$('scoring').querySelectorAll('.prow')];
  const under = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return { row: el ? el.closest('.prow') : null, team: el ? el.closest('.team') : null };
  };
  const move = ev => {
    const o = under(ev.clientX, ev.clientY);
    for (const t of teams) t.classList.toggle('dragover', t === o.team && (!o.row || o.row === row));
    for (const r of rows) r.classList.toggle('droptarget', r === o.row && r !== row);
  };
  const up = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    row.classList.remove('dragging');
    for (const t of teams) t.classList.remove('dragover');
    for (const r of rows) r.classList.remove('droptarget');
    const o = under(ev.clientX, ev.clientY);
    if (o.row && o.row !== row) {
      const before = o.row.dataset.p;
      dispatch({ type: 'player_move', player: p, team: state.teams[before] ?? null, before });
    } else if (o.team) {
      const team = o.team.dataset.teamcol || null;
      if (team !== (state.teams[p] ?? null)) dispatch({ type: 'player_move', player: p, team });
      else render();
    } else render();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---------- history sidebar: chronological, grouped by tossup ----------
// Compact rows: the points column already says power/get/neg, so
// tossup lines are just the name, and a question's bonus folds into
// one ✓/✗ run on the winning line — "+10 Kim | ✓✓✗". Negs and other
// players keep their own lines; non-tossup kinds (adjust) stay
// labeled. Right-click a line to undo back through that action.
const HIST_TOSSUP_KINDS = new Set(['superpower', 'power', 'get', 'neg', 'miss']);

function renderHistory() {
  const entries = liveLog(state);
  const winner = k => k === 'power' || k === 'get' || k === 'superpower';
  // Fold bonus parts per qid and pick the line that carries the marks:
  // the winning buzz, else the question's last line (a review-edited
  // winner, a late-scored dead tossup).
  const bonuses = new Map();   // qid -> [partIdx -> given?]
  const carrier = new Map();   // qid -> the log entry carrying the marks
  for (const e of entries) {
    if (e.kind === 'bonus') {
      const parts = bonuses.get(e.qid) || [];
      parts[e.partIdx ?? 0] = e.points > 0;
      bonuses.set(e.qid, parts);
    } else if (e.qid && (!carrier.has(e.qid) || !winner(carrier.get(e.qid).kind))) {
      carrier.set(e.qid, e);
    }
  }
  const marksFor = qid => Array.from(bonuses.get(qid), v =>
    v ? '<span class="good">✓</span>' : '<span class="bad">✗</span>').join('');
  const rows = [];
  let lastQid = null;
  for (const e of entries) {
    if (e.kind === 'bonus') continue;
    if (e.qid && e.qid !== lastQid) {
      lastQid = e.qid;
      rows.push(`<div class="tuhead" data-qid="${esc(e.qid)}">${esc(qidMeta[e.qid]?.label || 'Tossup')}</div>`);
    }
    const cls = e.points > 0 ? 'good' : e.points < 0 ? 'bad' : '';
    const marks = e.qid && carrier.get(e.qid) === e && bonuses.has(e.qid)
      ? ` <span class="faint">|</span> ${marksFor(e.qid)}` : '';
    const label = e.kind === 'dead' ? '<span class="faint">dead</span>' + marks
      : `${esc(e.team ?? e.player ?? '')}${HIST_TOSSUP_KINDS.has(e.kind) ? '' : ' · ' + esc(e.kind)}${
          e.answer ? ' · “' + esc(e.answer) + '”' : ''}${marks}`;
    const pts = e.kind === 'dead' ? '' : (e.points > 0 ? '+' + e.points : String(e.points));
    rows.push(`<li data-e="${state.log.indexOf(e)}"><span class="pts ${cls}">${pts}</span><span>${label}</span></li>`);
  }
  if (cur && state.phase !== 'done' && state.phase !== 'idle' && state.current) {
    if (state.current.qid !== lastQid) {
      rows.push(`<div class="tuhead">${esc(qidMeta[state.current.qid]?.label || 'Tossup')}</div>`);
    }
    rows.push('<li><span class="pts faint">…</span><span class="faint">reading</span></li>');
  }
  const el = $('histlist');
  el.innerHTML = rows.join('');
  for (const h of el.querySelectorAll('.tuhead[data-qid]')) {
    h.onclick = () => jumpToReview(h.dataset.qid);
  }
  for (const li of el.querySelectorAll('li[data-e]')) {
    li.oncontextmenu = ev => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY, [
        { label: 'undo from here', run: () => undoThrough(+li.dataset.e) },
      ]);
    };
  }
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

// Undo back through the action that produced log entry logIdx: replays
// the undo stack until that line (and everything after it) is gone.
// Roster and settings events survive each level, as with ctrl+z. The
// stack does not survive a refresh — when it can't reach, fall back to
// surgically retracting that line and everything after it: scores,
// stats, lockouts, and the question's phase all re-derive.
function undoThrough(logIdx) {
  while (undoStack.length && state.log.length > logIdx) undo();
  if (!state.log.slice(logIdx).some(e => !e.retracted)) return;
  pushUndo();
  const qids = new Set();
  for (let i = state.log.length - 1; i >= logIdx; i--) {
    if (state.log[i].retracted) continue;
    if (state.log[i].qid) qids.add(state.log[i].qid);
    apply({ type: 'retract', entryIdx: i });
  }
  // A retracted bonus restarts its cycle if the question is re-won.
  if (cur && qids.has(cur.q._id)) { cur.bonus = null; $('bonuspanel').dataset.for = ''; }
  for (const qid of qids) refreshQlog(qid);
  render();
}

// Click a tossup header in the history sidebar: jump review there.
function jumpToReview(qid) {
  if (!packet) return;
  if (state.phase === 'reading' || state.phase === 'buzzed' || pendingBuzz) return;
  const idx = packet.tossups.findIndex(t => t._id === qid);
  if (idx < 0 || idx >= Math.min(tuIdx, packet.tossups.length)) return;
  review = { idx };
  $('bonuspanel').dataset.for = '';
  render();
}

// ---------- roster editor: bulk team/player entry ----------
function buildRosterEditor() {
  const blocks = [];
  const cols = rosterColumns();
  for (const col of cols.filter(c => c.team !== null)) blocks.push(col);
  // teams with no players yet still get a block
  for (const t of teamList) {
    if (!blocks.some(b => b.team === t)) blocks.push({ team: t, players: [] });
  }
  const unassigned = state.players.filter(p => !state.teams[p]);
  if (unassigned.length || !blocks.length) blocks.push({ team: '', players: unassigned });
  $('tblocks').innerHTML = blocks.map(b => `
    <div class="tblock">
      <label>Team name</label><input class="tn" value="${esc(b.team || '')}">
      <label>Players</label><textarea class="tp">${b.players.map(esc).join('\n')}</textarea>
    </div>`).join('');
}
$('addteamblock').onclick = () => {
  const div = document.createElement('div');
  div.className = 'tblock';
  div.innerHTML = '<label>Team name</label><input class="tn" placeholder="Team name">' +
    '<label>Players</label><textarea class="tp" placeholder="One name per line"></textarea>';
  $('tblocks').appendChild(div);
};
$('rostersave').onclick = () => {
  const wanted = [];          // [{name, team}] in display order
  const newTeams = [];
  for (const block of $('tblocks').querySelectorAll('.tblock')) {
    const team = block.querySelector('.tn').value.trim() || null;
    if (team && !newTeams.includes(team)) newTeams.push(team);
    const names = block.querySelector('.tp').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      if (!wanted.some(w => w.name === name)) wanted.push({ name, team });
    }
  }
  teamList = newTeams;
  for (const p of [...state.players]) {
    if (!wanted.some(w => w.name === p)) apply({ type: 'player_leave', player: p });
  }
  // join/move each in order; append-to-end walks establish the order
  for (const w of wanted) {
    apply(state.players.includes(w.name)
      ? { type: 'player_move', player: w.name, team: w.team }
      : { type: 'player_join', player: w.name, team: w.team });
  }
  $('rostersheet').classList.remove('open');
  render();
};

// ---------- packet end ----------
function renderPacketDone(first = true) {
  cur = null; pendingBuzz = null;
  $('modeline').textContent = '';
  $('qtext').innerHTML = '<i class="faint">Packet finished — pick another (📦); scores carry over.</i>';
  $('anspanel').classList.add('hidden');
  $('progress').classList.add('hidden');
  $('bonuspanel').classList.add('hidden');
  $('adjrow').classList.add('hidden');
  $('reviewlines').classList.add('hidden');
  for (const id of ['buzz', 'startbtn', 'restartbtn', 'playbtn', 'finishedbtn', 'deadbtn', 'nextbtn', 'shortcuts']) $(id).classList.add('hidden');
  $('prevbtn').classList.toggle('hidden', tuIdx <= 0);   // review still works
  $('prevbtn').disabled = false;
  $('undobtn').classList.toggle('hidden', !undoStack.length);
  renderHeader(); renderScoring(); renderHistory();
  saveSession();
  if (first) $('setsheet').classList.add('open');
}

// ---------- boot ----------
// The audio/reveal position moves without renders, so flush a save on
// the way out (refresh), on tab-hide (mobile, crashes), and on a slow
// heartbeat — a mid-question refresh resumes at the moment it left.
window.addEventListener('beforeunload', saveSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});
setInterval(saveSession, 5000);

const savedSession = loadSession();
if (savedSession) {
  $('resumerow').classList.remove('hidden');
  $('resumelabel').textContent = savedSession.title
    + (savedSession.room ? ' · 🌐 ' + savedSession.room.code : '');
  $('resumebtn').onclick = async () => {
    $('resumebtn').disabled = true;
    try {
      await resumeSession(savedSession);
    } catch (e) {
      // Never fail silently: the sheet is still open, put the reason
      // where the eye already is.
      $('setstatus').textContent = 'Resume failed: ' + (e && e.message || e);
      console.error('resume failed', e);
    } finally {
      $('resumebtn').disabled = false;
    }
  };
}

render();
