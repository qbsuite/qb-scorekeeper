// Session persistence, real-DOM edition: boots the ACTUAL index.html +
// app.js in happy-dom, plays a question through real clicks, then
// "refreshes" — a fresh window and fresh module instance sharing only
// localStorage — and clicks Resume. Complements session.test.mjs
// (sliced units) by exercising the full boot path, so a boot-time
// error that would kill the resume row fails HERE, not at a game.
// Skips when happy-dom is not installed (npm i).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let Window = null;
try { ({ Window } = await import('happy-dom')); } catch (e) { /* not installed */ }

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app');
const html = Window ? fs.readFileSync(path.join(APP, 'index.html'), 'utf8') : '';

const CATALOG = { sets: [{ slug: 'test-set', name: 'Test Set', year: 2024, difficulty: 3 }], tossups: { id: [], set: [] } };
const SETDATA = {
  name: 'Test Set',
  packets: [{
    number: 1,
    tossups: [
      { _id: 'q1', question_sanitized: 'Alpha beta gamma delta epsilon zeta', answer: 'Foo' },
      { _id: 'q2', question_sanitized: 'Second question words here', answer: 'Bar' },
    ],
    bonuses: [
      { _id: 'b1', leadin_sanitized: 'Lead', parts_sanitized: ['p1', 'p2', 'p3'], answers: ['a1', 'a2', 'a3'] },
      { _id: 'b2', leadin_sanitized: 'Lead2', parts_sanitized: ['x', 'y', 'z'], answers: ['1', '2', '3'] },
    ],
  }],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
let bootN = 0;

// One boot = one "browser tab". sharedStorage is the only survivor
// across boots, exactly like a refresh.
async function boot(sharedStorage) {
  bootN++;
  const win = new Window({ url: 'https://example.test/app/index.html' });
  win.document.write(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''));
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = new Proxy({}, {
    get: (t, k) => sharedStorage[k],
    set: (t, k, v) => { sharedStorage[k] = String(v); return true; },
    has: (t, k) => k in sharedStorage,
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('catalog.json')) return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG) });
    if (u.includes('/sets/test-set.json')) return Promise.resolve({ ok: true, json: () => Promise.resolve(SETDATA) });
    return Promise.reject(new Error('no network in tests: ' + u));
  };
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); } catch (e) {}
  globalThis.location = win.location;
  globalThis.Audio = function () {
    return { preservesPitch: true, playbackRate: 1, currentTime: 0, duration: NaN, paused: true, src: '',
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
      load() {}, removeAttribute() {}, addEventListener() {} };
  };
  globalThis.WebSocket = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } send() {} close() {} };
  globalThis.confirm = () => true;
  const promptQueue = [];
  globalThis.prompt = () => promptQueue.shift() ?? 'Kim';
  // The app's save heartbeat (setInterval) would keep the test process
  // alive forever; the saves we assert on all happen via render().
  globalThis.setInterval = () => 0;
  await import(pathToFileURL(path.join(APP, 'vendor/reveal_units.js')).href + '?b' + bootN);
  await import(pathToFileURL(path.join(APP, 'sync.js')).href + '?b' + bootN);
  await import(pathToFileURL(path.join(APP, 'app.js')).href + '?b' + bootN);
  await sleep(40);   // let the catalog fetch settle
  return { win, promptQueue, $: id => win.document.getElementById(id) };
}

async function playToReading($, mode) {
  $('setlist').value = 'test-set';
  await $('setlist').onchange();
  $('modepick').value = mode;
  $('packetpick').value = '0';
  $('loadbtn').click();
  await sleep(30);
  $('startbtn').click();
  await sleep(10);
  $('addplayerq').click();   // prompt() -> Kim
  await sleep(10);
}

const skip = !Window && 'happy-dom not installed (npm i)';

test('refresh mid-game: resume restores the score and the live question', { skip }, async () => {
  const store = {};
  {
    const { $ } = await boot(store);
    await playToReading($, 'text');
    const word = window.document.querySelector('#qtext .w');
    word.click();                       // buzz on a word (full-text mode)
    await sleep(10);
    $('vcorrect').click();              // Kim +10
    await sleep(10);
    assert.ok(store.qbmodSession, 'session saved');
  }
  {
    const { $ } = await boot(store);    // the refresh
    assert.ok(!$('resumerow').classList.contains('hidden'), 'resume row shown');
    assert.match($('resumelabel').textContent, /Test Set · Packet 1/);
    await $('resumebtn').onclick();
    await sleep(40);
    assert.ok(!$('setsheet').classList.contains('open'), 'sheet closed');
    assert.match($('setname').textContent, /Test Set/);
    assert.match($('scoring').innerHTML, /Kim/);
    assert.match($('qtext').textContent, /Alpha beta/);
  }
});

test('review: undo a scored buzz (right-click) and redo it for another player', { skip }, async () => {
  const { $, win, promptQueue } = await boot({});
  await playToReading($, 'text');          // adds Kim
  promptQueue.push('Sam');
  $('addplayerq').click();                 // adds Sam
  await sleep(10);
  win.document.querySelector('#qtext .w').click();   // buzz (Kim preselected? no — pick)
  await sleep(10);
  // two eligible players: attribute to Kim by tapping her name
  const rowOf = name => [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === name);
  rowOf('Kim').querySelector('.pname').click();
  await sleep(10);
  $('vcorrect').click();                   // Kim +10 on q1 (the mistake)
  await sleep(10);
  assert.match(rowOf('Kim').querySelector('.pscore').textContent, /10/);

  $('nextbtn').click();                    // q2 loads + reads
  await sleep(30);
  $('deadbtn').click();                    // q2 done -> review is allowed
  await sleep(10);
  $('prevbtn').click();                    // review q1
  await sleep(10);
  const line = win.document.querySelector('#reviewlines .rline');
  assert.ok(line, 'review shows the score line');
  assert.match(line.textContent, /Kim/);

  // right-click -> undo buzz (retract)
  line.oncontextmenu({ preventDefault() {}, clientX: 5, clientY: 5 });
  win.document.getElementById('ctxmenu').querySelector('button').click();
  await sleep(10);
  assert.match(rowOf('Kim').querySelector('.pscore').textContent, /^0$/);
  assert.ok(!win.document.querySelector('#reviewlines .rline'), 'line gone from review');

  // redo: Sam's +10 on the point pad scores the REVIEWED question
  [...rowOf('Sam').querySelectorAll('.pbtns button')].find(b => b.dataset.v === '10').click();
  await sleep(10);
  assert.match(rowOf('Sam').querySelector('.pscore').textContent, /10/);
  const redone = win.document.querySelector('#reviewlines .rline');
  assert.match(redone.textContent, /Sam · get/);

  // history sidebar shows the fix under Tossup 1, no trace of Kim's line
  assert.match($('histlist').innerHTML, /Sam/);
  assert.ok(!/· g\b/.test($('histlist').innerHTML), 'tossup lines carry no kind letter');
  assert.ok(!/Kim/.test($('histlist').innerHTML), 'voided line gone from history');
});

test('after a refresh, row right-click still undoes a scored buzz (retract fallback)', { skip }, async () => {
  const store = {};
  {
    const { $, win } = await boot(store);
    await playToReading($, 'text');
    win.document.querySelector('#qtext .w').click();
    await sleep(10);
    $('vcorrect').click();                 // Kim +10, question done
    await sleep(10);
  }
  {
    const { $, win } = await boot(store);  // refresh: undo stack is gone
    await $('resumebtn').onclick();
    await sleep(40);
    const row = [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === 'Kim');
    assert.match(row.querySelector('.pscore').textContent, /10/);
    row.oncontextmenu({ preventDefault() {}, clientX: 5, clientY: 5 });
    const menu = win.document.getElementById('ctxmenu');
    assert.ok(menu, 'undo menu opens');
    assert.match(menu.textContent, /undo get/);
    menu.querySelector('button').click();
    await sleep(10);
    const row2 = [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === 'Kim');
    assert.match(row2.querySelector('.pscore').textContent, /^0$/, 'score undone without the stack');
    assert.ok(!/Kim/.test($('histlist').innerHTML), 'history clean');
  }
});

test('after a refresh, undoing a neg releases the lockout', { skip }, async () => {
  const store = {};
  {
    const { $ } = await boot(store);
    await playToReading($, 'reveal');
    $('buzz').click();
    await sleep(10);
    $('vwrong').click();                   // Kim -5 + lockout
    await sleep(10);
  }
  {
    const { $, win } = await boot(store);
    await $('resumebtn').onclick();
    await sleep(40);
    const row = [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === 'Kim');
    assert.ok(row.classList.contains('locked'), 'lockout survived the refresh');
    row.oncontextmenu({ preventDefault() {}, clientX: 5, clientY: 5 });
    win.document.getElementById('ctxmenu').querySelector('button').click();
    await sleep(10);
    const row2 = [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === 'Kim');
    assert.ok(!row2.classList.contains('locked'), 'lockout released');
    assert.match(row2.querySelector('.pscore').textContent, /^0$/);
  }
});

test('wrong for 0 via the pad: stat line counts no neg; -5 does', { skip }, async () => {
  const { $, win } = await boot({});
  await playToReading($, 'reveal');
  const rowOf = name => [...win.document.querySelectorAll('.prow')].find(r => r.dataset.p === name);
  const padTap = (name, v) =>
    [...rowOf(name).querySelectorAll('.pbtns button')].find(b => b.dataset.v === v).click();

  $('buzz').click();                       // Kim buzzes mid-reading
  await sleep(10);
  padTap('Kim', '0');                      // wrong, host declines the penalty
  await sleep(10);
  assert.match(rowOf('Kim').querySelector('.pscore').textContent, /^0$/);
  assert.equal(rowOf('Kim').querySelector('.pstat').textContent, '0/0/0',
    'a 0 is not a neg in the x/y/z stat line');
  assert.ok(rowOf('Kim').classList.contains('locked'), 'still locked out');

  $('deadbtn').click();                    // q1 done
  await sleep(10);
  $('nextbtn').click();                    // q2 reading
  await sleep(30);
  $('buzz').click();
  await sleep(10);
  padTap('Kim', '-5');                     // a real neg
  await sleep(10);
  assert.match(rowOf('Kim').querySelector('.pscore').textContent, /^-5$/);
  assert.equal(rowOf('Kim').querySelector('.pstat').textContent, '0/0/1');
  $('deadbtn').click();                    // stop the reveal clock: no
  await sleep(10);                         // stray timers into later tests
});

test('clicking a tossup header in the history jumps review there', { skip }, async () => {
  const { $, win } = await boot({});
  await playToReading($, 'text');
  win.document.querySelector('#qtext .w').click();
  await sleep(10);
  $('vcorrect').click();                   // q1 done
  await sleep(10);
  $('nextbtn').click();                    // q2 reading
  await sleep(30);
  $('deadbtn').click();                    // q2 done
  await sleep(10);
  const head = win.document.querySelector('#histlist .tuhead[data-qid]');
  assert.ok(head, 'history has a clickable header');
  head.onclick();
  await sleep(10);
  assert.match($('modeline').textContent, /review/);
  assert.ok(win.document.querySelector('#reviewlines .rline'), 'review shows q1 lines');
});

test('refresh mid-adjudication: the pending buzz survives and verdicts', { skip }, async () => {
  const store = {};
  {
    const { $ } = await boot(store);
    await playToReading($, 'reveal');
    $('buzz').click();
    await sleep(10);
    assert.ok(JSON.parse(store.qbmodSession).pendingBuzz, 'pending buzz saved');
  }
  {
    const { $, win } = await boot(store);
    await $('resumebtn').onclick();
    await sleep(40);
    assert.ok(!$('adjrow').classList.contains('hidden'), 'adjudication row restored');
    assert.ok(win.document.querySelector('header').classList.contains('buzzed'), 'buzz header restored');
    $('vcorrect').click();
    await sleep(10);
    assert.match($('scoring').innerHTML, /Kim/);
    assert.ok(!$('anspanel').classList.contains('hidden'), 'question done after verdict');
  }
});
