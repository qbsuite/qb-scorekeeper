// sim_buzzers.mjs — what buzzer rooms would cost if every qb-td
// tournament room ran one, measured against the real room server.
//   npm run sim:buzzers                  (or: node tests/sim_buzzers.mjs)
//   BUZZES=200 QLOG=0 npm run sim:buzzers
//
// It starts the metered room server itself (wrangler dev on port 8788,
// tests/sim/wrangler.toml) and stops it when done; if one is already
// running there, or ROOMS_BASE points elsewhere, it uses that instead.
// Change rooms/worker.js and rerun to price the change: the meter wraps
// the real RoomDO, so the numbers follow the code.
//
// Runs ROOMS games at once (one tournament round), each a moderator plus
// PLAYERS phones over real WebSockets, TOSSUPS per game and BUZZES buzz
// presses per game — most of them losing the race or landing on a closed
// buzzer, which is what mashing looks like. The host sends what app.js's
// render() -> syncRoom() sends: a `state` per redraw, arm/disarm when the
// buzzers flip, answer_result, qlog. The server side is counted by
// tests/sim/meter_worker.js (inbound frames by type, storage calls); the
// clients count what they receive.
//
// Billing is Cloudflare's Durable Objects pricing. Duration can't be
// measured locally, so it uses production's own ratio: September 2026's
// qb-rooms bill was 94 GB-s for 43,592 inbound messages.
//
// Knobs: ROOMS (8), PLAYERS (8), TOSSUPS (20), BUZZES (100 per game),
// REBOUND (0.3 of tossups reopen after a wrong answer), TYPED (1: the
// winner types an answer), QLOG (1: the host shares the question log),
// GAMES_PER_DAY (8 per room), TOURNAMENTS (60).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.ROOMS_BASE || 'http://127.0.0.1:8788';
const WS = SERVER.replace('http', 'ws');
const ROOMS = Number(process.env.ROOMS || 8);
const PLAYERS = Number(process.env.PLAYERS || 8);
const TOSSUPS = Number(process.env.TOSSUPS || 20);
const BUZZES = Number(process.env.BUZZES || 100);
const REBOUND = Number(process.env.REBOUND ?? 0.3);
const TYPED = Number(process.env.TYPED ?? 1);
const QLOG = Number(process.env.QLOG ?? 1);
const GAMES_PER_DAY = Number(process.env.GAMES_PER_DAY || 8);
const TOURNAMENTS = Number(process.env.TOURNAMENTS || 60);

// production calibration (Cloudflare analytics, qb-rooms, September 2026)
const GBS_PER_INBOUND = 94 / 43592;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let received = 0;

function connect(code, name, role) {
  const ws = new WebSocket(`${WS}/rooms/${code}/ws?name=${encodeURIComponent(name)}&role=${role}`);
  const waiters = [];
  ws.onmessage = (e) => {
    received++;
    const m = JSON.parse(e.data);
    // phones echo RTT probes at once, like player.html
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', n: m.n, ts: m.ts })); return; }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  };
  ws.next = (pred, ms = 3000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  ws.json = (o) => ws.send(JSON.stringify(o));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error: ' + name));
  });
}

// a display snapshot the size of app.js buildSnapshot's for PLAYERS
const snapshot = (tu) => ({
  tu, phase: 'reading', question: 'x'.repeat(400),
  players: Array.from({ length: PLAYERS }, (_, i) => ({ name: 'P' + i, team: i % 2 ? 'B' : 'A', score: tu * 5, locked: false })),
});

async function game(r) {
  const { code } = await (await fetch(SERVER + '/rooms', { method: 'POST' })).json();
  const host = await connect(code, 'Mod ' + r, 'host');
  const players = [];
  for (let i = 0; i < PLAYERS; i++) players.push(await connect(code, `R${r}P${i}`, 'player'));
  const perTu = BUZZES / TOSSUPS;
  let carry = 0;
  const qlog = [];

  // one buzz cycle: open the buzzers, n presses from different phones in
  // a burst, wait for the room to name the winner
  async function cycle(n) {
    host.json({ t: 'arm' });
    await sleep(15); // pings out, pongs back
    const won = host.next((m) => m.t === 'buzz');
    const order = players.slice().sort(() => Math.random() - 0.5);
    for (let k = 0; k < n; k++) order[k % order.length].json({ t: 'buzz' });
    const w = await won;
    host.json({ t: 'disarm' }); // syncRoom: pending buzz -> buzzers closed
    host.json({ t: 'state', snapshot: snapshot(0) });
    return w;
  }

  for (let tu = 1; tu <= TOSSUPS; tu++) {
    carry += perTu;
    let n = Math.floor(carry);
    carry -= n;
    host.json({ t: 'state', snapshot: snapshot(tu) }); // next question
    host.json({ t: 'state', snapshot: snapshot(tu) }); // reading
    const rebound = Math.random() < REBOUND;
    const first = rebound ? Math.ceil(n * 0.6) : n;
    const w = await cycle(Math.max(1, first));
    if (TYPED && w) players.find((p) => p.readyState === 1)?.json({ t: 'answer', text: 'some answer' });
    host.json({ t: 'answer_result', name: w ? w.name : '', result: rebound ? 'wrong' : 'right' });
    if (rebound) {
      host.json({ t: 'state', snapshot: snapshot(tu) });
      await cycle(Math.max(1, n - first));
      host.json({ t: 'answer_result', name: 'x', result: 'right' });
    }
    // bonus: three parts scored, then the question closes
    for (let b = 0; b < 3; b++) host.json({ t: 'state', snapshot: snapshot(tu) });
    if (QLOG) {
      qlog.push({ tu, text: 'q'.repeat(200) });
      host.json({ t: 'qlog', qlog });
    }
    host.json({ t: 'state', snapshot: snapshot(tu) });
    await sleep(5);
  }
  host.json({ t: 'close' });
  await sleep(50);
  for (const ws of [host, ...players]) { try { ws.close(); } catch (e) { /* gone */ } }
}

/* ---------- run ---------- */

// Pinned like qb-td's devDependency, so a rerun months later measures the
// same runtime.
const WRANGLER = 'wrangler@4.118.0';
const meterUp = () => fetch(SERVER + '/__meter', { method: 'DELETE' }).then((r) => r.ok, () => false);

let dev = null;
if (!(await meterUp())) {
  if (process.env.ROOMS_BASE) {
    console.error('no /__meter at ' + SERVER + ' (is it running tests/sim/meter_worker.js?)');
    process.exit(1);
  }
  const port = new URL(SERVER).port || '8788';
  process.stdout.write(`starting the metered room server (${WRANGLER} dev, port ${port})...`);
  dev = spawn('npx', ['--yes', WRANGLER, 'dev', '--local', '--port', port], {
    cwd: fileURLToPath(new URL('./sim/', import.meta.url)),
    stdio: 'ignore',
    detached: true,
  });
  dev.unref(); // the server must not keep this script alive
  for (let i = 0; i < 90 && !(await meterUp()); i++) await sleep(1000);
  if (!(await meterUp())) {
    process.kill(-dev.pid);
    console.error(' gave up after 90s');
    process.exit(1);
  }
  console.log(' up\n');
}
const stopDev = () => { if (dev) { try { process.kill(-dev.pid); } catch (e) { /* already gone */ } dev = null; } };
process.on('exit', stopDev);
process.on('SIGINT', () => { stopDev(); process.exit(130); });
console.log(`sim: ${ROOMS} rooms at once, ${PLAYERS} phones + a moderator each, ` +
  `${TOSSUPS} tossups, ${BUZZES} buzzes/game, ${REBOUND * 100}% rebounds`);
const t0 = performance.now();
await Promise.all(Array.from({ length: ROOMS }, (_, r) => game(r)));
await sleep(300);
const m = await (await fetch(SERVER + '/__meter')).json();
const wall = (performance.now() - t0) / 1000;

const inbound = Object.values(m.inbound).reduce((a, b) => a + b, 0);
const s = m.storage;
const g = (x) => x / ROOMS; // per game
console.log(`\nran ${ROOMS} games in ${wall.toFixed(1)}s\n`);
console.log('inbound frames per game, by type:');
console.table(Object.fromEntries(Object.entries(m.inbound).sort((a, b) => b[1] - a[1])
  .map(([t, n]) => [t, { per_game: +(n / ROOMS).toFixed(1), per_tossup: +(n / ROOMS / TOSSUPS).toFixed(2) }])));
console.log(`per game: ${g(inbound).toFixed(0)} inbound, ${g(received).toFixed(0)} delivered to phones+host, ` +
  `${g(m.connects).toFixed(0)} connects`);
console.log(`storage per game: ${g(s.put).toFixed(0)} put, ${g(s.get).toFixed(0)} get, ` +
  `${g(s.delete + s.deleteAll).toFixed(1)} delete, ${g(s.setAlarm).toFixed(0)} setAlarm`);

// ---- billing units per game ----
// requests: each WebSocket upgrade and each room claim is a request;
// inbound WebSocket frames bill at 20:1; outbound frames are free
const perGame = {
  doRequests: g(inbound) / 20 + g(m.connects) + 1,
  workerRequests: g(m.connects) + 1,
  rowsRead: g(s.get),
  rowsWritten: g(s.put + s.delete + s.deleteAll),
  rowsWrittenIfAlarmsCount: g(s.put + s.delete + s.deleteAll + s.setAlarm),
  gbs: g(inbound) * GBS_PER_INBOUND,
};
console.log('\nbilling units per game:', Object.fromEntries(Object.entries(perGame).map(([k, v]) => [k, +v.toFixed(1)])));
console.log(`production check: writes per inbound frame here ${(perGame.rowsWritten / g(inbound)).toFixed(2)}, ` +
  `production September ${(13594 / 43592).toFixed(2)}`);

// ---- scale ----
const FREE = { doRequests: 100000, gbs: 13000, rowsRead: 5e6, rowsWritten: 100000 };
const PAID = { doRequests: [1e6, 0.15e-6], gbs: [400000, 12.5e-6], rowsRead: [25e9, 0.001e-6], rowsWritten: [50e6, 1e-6] };
const rows = [];
for (const [label, games] of [
  ['one game', 1],
  ['one tournament day', ROOMS * GAMES_PER_DAY],
  [`${TOURNAMENTS} tournaments, one day`, TOURNAMENTS * ROOMS * GAMES_PER_DAY],
]) {
  const u = (k) => perGame[k] * games;
  rows.push({
    scale: label,
    games,
    'DO requests': Math.round(u('doRequests')),
    'GB-s': Math.round(u('gbs')),
    'rows read': Math.round(u('rowsRead')),
    'rows written': Math.round(u('rowsWritten')),
    '(+alarms)': Math.round(u('rowsWrittenIfAlarmsCount')),
  });
}
console.log('\nscaled (free plan per day: 100k DO requests, 13k GB-s, 5M rows read, 100k rows written):');
console.table(rows);
const big = TOURNAMENTS * ROOMS * GAMES_PER_DAY;
const worst = Object.keys(FREE).map((k) => [k, perGame[k] * big / FREE[k]]).sort((a, b) => b[1] - a[1])[0];
console.log(`${TOURNAMENTS} tournaments: tightest free limit is ${worst[0]} at ${(worst[1] * 100).toFixed(0)}% of a day's allowance`);
// paid: what a month of 4 such days would add beyond the $5 plan's inclusions
let extra = 0;
for (const [k, [incl, price]] of Object.entries(PAID)) extra += Math.max(0, perGame[k] * big * 4 - incl) * price;
console.log(`Workers Paid, 4 such days a month: $${extra.toFixed(2)} over the $5 base`);

stopDev();
