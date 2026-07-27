// rooms/worker.js — the qb-scorekeeper room server (Cloudflare Worker +
// one Durable Object per room).
//
// v1 is a HOST-AUTHORITATIVE relay (a deliberate simplification of the
// docs/rooms.md server-authoritative design, revisit for remote play):
// the game engine runs in the host's browser; the DO does the two
// things only a server can do — atomic first-buzz arbitration and
// fan-out — plus it stores the latest display snapshot for late
// joiners. Phones connect as players and send exactly one message kind
// (buzz); the host relays state and arms/disarms the buzzers.
//
// Protocol (all JSON text frames):
//   player -> DO : {t:'buzz'}
//                  {t:'answer', text}      typed answer, relayed to hosts
//                  {t:'pong', n, ts}       echo of a ping (RTT sample)
//   host   -> DO : {t:'state', snapshot}   display snapshot, stored + fanned out
//                  {t:'arm'} / {t:'disarm'} open/close the buzzers
//                  {t:'answer_result', name, result, prompt?} verdict for a
//                  typed answer, broadcast to everyone
//                  {t:'close'}             end the room: {t:'closed'} broadcast,
//                  sockets closed, storage wiped (code returns to the pool)
//   DO -> client : {t:'welcome', snapshot, armed, roster}
//                  {t:'join'|'leave', name, role}
//                  {t:'buzz', name}        winning buzz, buzzers close
//                  {t:'rejected'}          buzz while closed / lost the race (only to sender)
//                  {t:'state', snapshot} / {t:'arm'} / {t:'disarm'}
//                  {t:'answer_result', name, result, prompt?}
//   DO -> host   : {t:'answer', name, text} a player's typed answer
//   DO -> player : {t:'ping', n, ts}       RTT probe (sent on join + each arm)
//   DO -> all    : {t:'buzz_pending', name} FIRST arrival, sent the instant
//                  the collection window opens — moderators stop reading and
//                  broadcasting phones pause audio on this; the equalized
//                  winner ({t:'buzz'}) may differ and follows at window close
//
// Audio broadcast (additive, v1.1 — see SPEC.md): the host can stream
// its TTS question audio to phones. Audio BYTES never transit the
// worker (phones fetch the .opus from the qb-audio CDN themselves);
// the DO's whole job is relaying small control messages and stamping
// its clock on them so every client can schedule playback on server
// time:
//   any client -> DO : {t:'sync', c}   -> immediate {t:'sync', c, s}
//                  echo (s = server now); clients derive offset =
//                  serverClock − localClock, NTP-style
//   host -> DO   : {t:'audio_manifest', entries} stored (like qlog) +
//                  broadcast; welcome carries it to late joiners
//                  {t:'audio_start'|'audio_resume', ...} stamped with
//                  sv (server now) AND at = sv + AUDIO_LEAD_MS, then
//                  broadcast to EVERYONE (host included — it schedules
//                  its own playback at the same instant)
//                  {t:'audio_pause'|'audio_rate'|'audio_stop'|
//                   'audio_state', ...} stamped with sv, broadcast to
//                  all but the sender
//   player -> DO : {t:'audio_ready'|'audio_error', qid} and
//                  {t:'audio_resync'} relayed to hosts with the
//                  player's name attached
// The DO never inspects audio payloads beyond stamping — the host owns
// the ready gate, the clock, and all game meaning.
//
// Buzz arbitration is LATENCY-EQUALIZED: the first buzz while armed opens
// a short collection window (sized to the slowest connected player's
// measured RTT, capped); every buzz arriving within it competes, and the
// winner is the earliest ESTIMATED PRESS TIME (arrival − RTT/2, capped)
// rather than earliest arrival — so a cross-country player races a local
// one fairly. Clients that never pong have no RTT estimate: they get zero
// compensation and, if no one has an estimate, a 0ms window — i.e. plain
// first-arrival, exactly the old behavior (fully backward compatible).
//
// Rooms are temporary: no registry, the room code IS the DO name; a
// room with no connections hibernates for free and its state is
// meaningless once everyone leaves.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.method === 'POST' && url.pathname === '/rooms') {
      // Claim a FRESH room: the code is the DO name, so an unclaimed
      // code could collide with a live room or inherit a dead room's
      // stale state. The DO's /claim rejects codes that are active or
      // not yet expired; retry until one sticks. 31^4 ≈ 923k codes and
      // rooms expire (see RoomDO TTL), so exhaustion isn't a concern —
      // collisions are just re-rolled.
      for (let i = 0; i < 8; i++) {
        let code = '';
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://do/claim', { method: 'POST' });
        if (r.ok) return Response.json({ code }, { headers: CORS });
      }
      return new Response('no free room codes, try again', { status: 503, headers: CORS });
    }

    const m = url.pathname.match(/^\/rooms\/([A-Z2-9]{4})\/ws$/);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response('qb-scorekeeper room server', { headers: CORS });
  },
};

// Rooms self-destruct after this long without any activity (message or
// connection): the alarm wipes storage and closes sockets, so the code
// returns to the pool with no stale state.
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

// Latency equalization tuning. The compensation cap doubles as the
// anti-abuse bound: a client faking lag (delaying its pongs) can backdate
// its buzzes by at most MAX_COMP_MS, and inflated RTTs are visible to the
// host in the roster. The window cap bounds how long a winner
// announcement can lag the first arrival.
const RTT_SAMPLES = 8;      // per-player samples kept (median is used)
const MAX_COMP_MS = 100;    // cap on arrival backdating (= RTT/2 cap)
const MAX_WINDOW_MS = 200;  // cap on the buzz collection window

// Scheduled audio starts land this far in the server's future — above
// the buzz-window cap and any sane one-way latency, so every phone's
// scheduled instant is still ahead of it when the message arrives.
const AUDIO_LEAD_MS = 300;

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = null; // in-flight buzz collection window (in-memory only)
  }

  /** Any activity pushes the self-destruct alarm back by the TTL. */
  touch() {
    return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'room expired'); } catch (e) { /* closing */ }
    }
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/claim') {
      const created = await this.ctx.storage.get('createdAt');
      const active = this.ctx.getWebSockets().length > 0;
      if (created && (active || Date.now() - created < ROOM_TTL_MS)) {
        return new Response('room code in use', { status: 409 });
      }
      await this.ctx.storage.deleteAll();   // expired leftover state, if any
      await this.ctx.storage.put('createdAt', Date.now());
      await this.touch();
      return new Response('claimed');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    await this.touch();
    const name = (url.searchParams.get('name') || 'guest').slice(0, 40);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ name, role });

    const [snapshot, armed, qlog, audioManifest] = await Promise.all([
      this.ctx.storage.get('snapshot'),
      this.ctx.storage.get('armed'),
      this.ctx.storage.get('qlog'),
      this.ctx.storage.get('audio_manifest'),
    ]);
    server.send(JSON.stringify({
      t: 'welcome', snapshot: snapshot ?? null, armed: !!armed,
      qlog: qlog ?? [], roster: this.roster(),
      audioManifest: audioManifest ?? null,
    }));
    this.broadcast({ t: 'join', name, role }, server);
    this.pingSocket(server); // first RTT sample right away
    return new Response(null, { status: 101, webSocket: client });
  }

  roster() {
    return this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment() || {};
      return { name: a.name, role: a.role, rtt: this.rttOf(a) };
    });
  }

  // ---------- latency equalization ----------

  /** Median of the connection's recent RTT samples (null = no data). */
  rttOf(att) {
    const s = att.rtts || [];
    if (!s.length) return null;
    const sorted = [...s].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** How far to backdate this player's buzz arrivals. */
  compOf(att) {
    const r = this.rttOf(att);
    return r == null ? 0 : Math.min(r / 2, MAX_COMP_MS);
  }

  /** Collection window: long enough for the slowest player's buzz to make
   *  it in. 0 when no player has RTT data (old clients / in-person LAN
   *  rooms stay effectively instant). */
  buzzWindow() {
    let w = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role !== 'player') continue;
      const r = this.rttOf(a);
      if (r != null) w = Math.max(w, Math.min(r, MAX_WINDOW_MS));
    }
    return w;
  }

  pingSocket(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role !== 'player') return;
    att.pingN = (att.pingN || 0) + 1;
    att.pingTs = Date.now();
    ws.serializeAttachment(att);
    try { ws.send(JSON.stringify({ t: 'ping', n: att.pingN, ts: att.pingTs })); } catch (e) { /* closing */ }
  }

  pingPlayers() {
    for (const ws of this.ctx.getWebSockets()) this.pingSocket(ws);
  }

  /** Close the collection window: earliest estimated press time wins.
   *  Losers hear their rejection BEFORE the winner broadcast so their UI
   *  settles on "X buzzed". */
  resolveBuzz() {
    const cands = this.pending || [];
    this.pending = null;
    if (!cands.length) return;
    cands.sort((a, b) => a.adj - b.adj);
    for (const c of cands.slice(1)) {
      try { c.ws.send(JSON.stringify({ t: 'rejected' })); } catch (e) { /* closing */ }
    }
    this.broadcast({ t: 'buzz', name: cands[0].name });
  }

  broadcast(obj, except = null) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch (e) { /* closing socket */ }
    }
  }

  sendToHosts(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role !== 'host') continue;
      try { ws.send(msg); } catch (e) { /* closing socket */ }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const att = ws.deserializeAttachment() || {};
    await this.touch();

    if (att.role === 'player') {
      if (msg.t === 'pong') {
        // RTT sample. The nonce check stops stale/replayed pongs from
        // inflating the estimate beyond what actually delaying the pong
        // can achieve (which the MAX_COMP_MS cap bounds anyway).
        if (msg.n === att.pingN && att.pingTs) {
          const rtt = Date.now() - att.pingTs;
          att.pingTs = null;
          att.rtts = [...(att.rtts || []), rtt].slice(-RTT_SAMPLES);
          ws.serializeAttachment(att);
        }
        return;
      }
      if (msg.t === 'answer') {
        // Typed answer from a buzzer. The engine and checker live in the
        // host app, so this is a pure relay; hosts drop answers from
        // anyone who doesn't hold the pending buzz.
        this.sendToHosts({ t: 'answer', name: att.name, text: String(msg.text ?? '').slice(0, 300) });
        return;
      }
      if (msg.t === 'sync') {
        // Clock-offset probe: echo immediately with the server stamp.
        try { ws.send(JSON.stringify({ t: 'sync', c: msg.c, s: Date.now() })); } catch (e) { /* closing */ }
        return;
      }
      if (msg.t === 'audio_ready' || msg.t === 'audio_error' || msg.t === 'audio_resync') {
        // Audio-broadcast player signals: pure relays, name attached
        // (same pattern as 'answer'); the host owns the ready gate.
        this.sendToHosts({ t: msg.t, name: att.name, qid: msg.qid ?? null });
        return;
      }
      if (msg.t !== 'buzz') return;
      const now = Date.now();
      if (this.pending) {
        // A window is open: this buzz competes on estimated press time.
        this.pending.push({ ws, name: att.name, adj: now - this.compOf(att) });
        return;
      }
      // Atomic window-open: the DO processes messages serially (and the
      // input gate holds new events during the storage ops), so exactly
      // one buzz opens the window and closes the gate for everyone who
      // arrives after it resolves.
      const armed = await this.ctx.storage.get('armed');
      if (!armed) { ws.send(JSON.stringify({ t: 'rejected' })); return; }
      await this.ctx.storage.put('armed', false);
      this.pending = [{ ws, name: att.name, adj: now - this.compOf(att) }];
      // Everyone hears about the FIRST arrival immediately — the
      // moderator must stop reading now, and broadcasting phones pause
      // their audio on the same signal (no host round trip, no lag
      // compensation); the equalized winner follows at window close.
      this.broadcast({ t: 'buzz_pending', name: att.name });
      setTimeout(() => this.resolveBuzz(), this.buzzWindow());
      return;
    }

    // host messages
    if (msg.t === 'state') {
      await this.ctx.storage.put('snapshot', msg.snapshot ?? null);
      this.broadcast({ t: 'state', snapshot: msg.snapshot ?? null }, ws);
    } else if (msg.t === 'arm') {
      await this.ctx.storage.put('armed', true);
      this.broadcast({ t: 'arm' }, ws);
      this.pingPlayers(); // refresh RTT estimates once per question cycle
    } else if (msg.t === 'disarm') {
      await this.ctx.storage.put('armed', false);
      this.broadcast({ t: 'disarm' }, ws);
    } else if (msg.t === 'close') {
      // Host ends the room: everyone hears it (players stop
      // reconnecting), sockets close, storage wipes — the code returns
      // to the pool immediately instead of waiting out the TTL.
      this.broadcast({ t: 'closed' });
      for (const s of this.ctx.getWebSockets()) {
        try { s.close(1000, 'room closed'); } catch (e) { /* closing */ }
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } else if (msg.t === 'answer_result') {
      // Verdict for a typed answer: the answering player renders it
      // (prompt reopens their input); everyone else sees the outcome.
      this.broadcast({
        t: 'answer_result', name: msg.name,
        result: msg.result, prompt: msg.prompt ?? null,
      }, ws);
    } else if (msg.t === 'qlog') {
      // Completed-question log (text + answer + result) so players can
      // browse what was read; stored for late joiners.
      await this.ctx.storage.put('qlog', msg.qlog ?? []);
      this.broadcast({ t: 'qlog', qlog: msg.qlog ?? [] }, ws);
    } else if (msg.t === 'sync') {
      try { ws.send(JSON.stringify({ t: 'sync', c: msg.c, s: Date.now() })); } catch (e) { /* closing */ }
    } else if (msg.t === 'audio_manifest') {
      // The packet's audio list (qids + CDN urls): stored like the qlog
      // so welcome hands it to late joiners, never inspected.
      await this.ctx.storage.put('audio_manifest', msg.entries ?? []);
      this.broadcast({ t: 'audio_manifest', entries: msg.entries ?? [] }, ws);
    } else if (typeof msg.t === 'string' && msg.t.startsWith('audio_')) {
      // Audio control relay: stamp the server clock so clients can
      // convert to local time. Scheduled messages (start/resume) get a
      // start instant in the near future and go to EVERYONE — the host
      // schedules its own playback from the echo, so all clocks anchor
      // to the same server instant.
      const out = { ...msg, sv: Date.now() };
      const scheduled = msg.t === 'audio_start' || msg.t === 'audio_resume';
      if (scheduled) out.at = out.sv + AUDIO_LEAD_MS;
      this.broadcast(out, scheduled ? null : ws);
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    this.broadcast({ t: 'leave', name: att.name, role: att.role }, ws);
  }
}
