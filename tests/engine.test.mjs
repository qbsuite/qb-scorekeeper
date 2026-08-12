// Engine rule-table vectors. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, scores, teamScores, defaultConfig,
         liveLog, bonusStats, tossupStats } from '../engine/engine.js';

const play = (state, ...events) => events.reduce(reduce, state);

function start(config, { powerIdx = 10, superpowerIdx = null } = {}) {
  let s = initialState(config);
  s = play(s,
    { type: 'player_join', player: 'A' },
    { type: 'player_join', player: 'B' },
    { type: 'question_start', qid: 'q1', powerIdx, superpowerIdx, unitCount: 40 });
  return s;
}

test('correct before the power mark scores 15', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 9 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 15);
  assert.equal(s.log[0].kind, 'power');
  assert.equal(s.phase, 'done');
});

test('buzz exactly at the power mark unit is a get (strict <)', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 10 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].kind, 'get');
});

test('no power mark -> always a 10', () => {
  let s = start({}, { powerIdx: null });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 0 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
});

test('superpower when enabled', () => {
  let s = start({ points: { superpower: 20 } }, { powerIdx: 10, superpowerIdx: 5 });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 4 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 20);
  assert.equal(s.log[0].kind, 'superpower');
  assert.deepEqual(defaultConfig({ points: { superpower: 20 } }).pointPad,
    [15, 10, -5, 20]);
});

test('wrong during reading is a -5 neg + lockout, reading resumes', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, -5);
  assert.equal(s.log[0].kind, 'neg');
  assert.equal(s.phase, 'reading');            // resume for others
  assert.deepEqual(s.current.lockouts, ['A']);
  // A cannot buzz again; B can.
  const blocked = reduce(s, { type: 'buzz', player: 'A', unitIdx: 12 });
  assert.equal(blocked.phase, 'reading');
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 12 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 10);
});

test('wrong after reading finished is 0, not a neg', () => {
  let s = start();
  s = play(s,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'A', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, 0);
  assert.equal(s.log[0].kind, 'miss');
});

test('all players locked out after reading finished -> question dead', () => {
  let s = start();
  s = play(s,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'A', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(s.phase, 'done');
});

test('lockouts do not end the question while reading continues', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' },
    { type: 'buzz', player: 'B', unitIdx: 6 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(s.phase, 'reading');            // dead only via reading_finished/dead
  assert.equal(scores(s).A + scores(s).B, -10);
});

test('scoreless mode keeps flow but logs 0 points', () => {
  let s = start({ scoring: false });
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });
  assert.equal(scores(s).A, 0);
  assert.equal(s.log[0].kind, 'neg');          // history still meaningful
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 6 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 0);
});

test('verdict points override: the pad drives flow with forced points', () => {
  // Voice/manual-read mode: position unknown, host taps +15 -> correct
  // with 15 regardless of unitIdx; -5 -> wrong+lockout with -5 even if
  // the rule table would say 0.
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 30 },       // after the mark
    { type: 'verdict', result: 'correct', points: 15 });
  assert.equal(scores(s).A, 15);
  assert.equal(s.phase, 'done');
  let t = start();
  t = play(t,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong', points: -5 });
  assert.equal(scores(t).B, -5);
  assert.deepEqual(t.current.lockouts, ['B']);
});

test('unknown buzz position (null) is never a power', () => {
  let s = start();                                     // powerIdx 10
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: null },      // manual-read mode
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].kind, 'get');
});

test('award: the host point pad writes direct score lines', () => {
  let s = start();
  s = play(s,
    { type: 'award', player: 'A', points: 15, reason: 'pad' },
    { type: 'award', player: 'A', points: -5, reason: 'pad' },
    { type: 'award', player: 'B', points: 10, reason: 'bonus' });
  assert.equal(scores(s).A, 10);
  assert.equal(scores(s).B, 10);
});

test('override edits a past line and totals recompute', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).A, 15);
  s = reduce(s, { type: 'override', entryIdx: 0, points: 10 });
  assert.equal(scores(s).A, 10);
  assert.equal(s.log[0].overridden, true);
});

test('override re-derives the kind from the new points', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'correct' });          // power, 15
  s = reduce(s, { type: 'override', entryIdx: 0, points: -5 });
  assert.equal(s.log[0].kind, 'neg');
  assert.deepEqual(tossupStats(s).A, { powers: 0, gets: 0, negs: 1 });
  s = reduce(s, { type: 'override', entryIdx: 0, points: 0 });
  assert.equal(s.log[0].kind, 'miss');
  s = reduce(s, { type: 'override', entryIdx: 0, points: 15 });
  assert.equal(s.log[0].kind, 'power');
  s = reduce(s, { type: 'override', entryIdx: 0, points: 7 });  // custom value
  assert.equal(s.log[0].kind, 'power');                          // kind kept
  // non-tossup kinds keep their kind
  let t = start();
  t = play(t, { type: 'award', player: 'A', points: 10, reason: 'adjust' });
  t = reduce(t, { type: 'override', entryIdx: 0, points: 5 });
  assert.equal(t.log[0].kind, 'adjust');
});

test('impossible transitions are ignored', () => {
  let s = start();
  assert.equal(reduce(s, { type: 'verdict', result: 'correct' }), s); // no buzz yet
  s = reduce(s, { type: 'buzz', player: 'A', unitIdx: 5 });
  assert.equal(reduce(s, { type: 'buzz', player: 'B', unitIdx: 6 }).current.buzz.player, 'A');
  assert.equal(reduce(s, { type: 'next' }).phase, 'buzzed'); // next only from done
});

test('a wrong buzz locks out the whole team; solo players lock alone', () => {
  let s = initialState();
  s = play(s,
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'player_join', player: 'A2', team: 'Red' },
    { type: 'player_join', player: 'B1', team: 'Blue' },
    { type: 'player_join', player: 'Solo' },
    { type: 'question_start', qid: 'q1', powerIdx: 10, unitCount: 40 },
    { type: 'buzz', player: 'A1', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });
  assert.deepEqual([...s.current.lockouts].sort(), ['A1', 'A2']);
  // A2 (teammate) cannot buzz; Blue and Solo can.
  assert.equal(reduce(s, { type: 'buzz', player: 'A2', unitIdx: 6 }).phase, 'reading');
  s = play(s,
    { type: 'buzz', player: 'B1', unitIdx: 12 },
    { type: 'verdict', result: 'correct' });
  assert.deepEqual(teamScores(s), { Red: -5, Blue: 10 });
  assert.equal(scores(s).Solo, 0);
});

test('team exhaustion after reading finished deads the question', () => {
  let s = initialState();
  s = play(s,
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'player_join', player: 'A2', team: 'Red' },
    { type: 'player_join', player: 'B1', team: 'Blue' },
    { type: 'question_start', qid: 'q1', powerIdx: null, unitCount: 40 },
    { type: 'reading_finished' },
    { type: 'buzz', player: 'A1', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' },        // locks A1+A2
    { type: 'buzz', player: 'B1', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });       // locks B1 -> everyone
  assert.equal(s.phase, 'done');
});

test('player_move reassigns teams', () => {
  let s = initialState();
  s = play(s,
    { type: 'player_join', player: 'A', team: 'Red' },
    { type: 'player_move', player: 'A', team: 'Blue' });
  assert.equal(s.teams.A, 'Blue');
  s = reduce(s, { type: 'player_move', player: 'A', team: null });
  assert.equal(s.teams.A, null);
});

test('player_move with before reorders; team undefined keeps team', () => {
  let s = initialState();
  s = play(s,
    { type: 'player_join', player: 'A', team: 'Red' },
    { type: 'player_join', player: 'B', team: 'Red' },
    { type: 'player_join', player: 'C', team: 'Red' });
  s = reduce(s, { type: 'player_move', player: 'C', before: 'A' });  // pure reorder
  assert.deepEqual(s.players, ['C', 'A', 'B']);
  assert.equal(s.teams.C, 'Red');
  s = reduce(s, { type: 'player_move', player: 'A', team: 'Blue', before: 'C' });
  assert.deepEqual(s.players, ['A', 'C', 'B']);
  assert.equal(s.teams.A, 'Blue');
});

test('configure changes settings live; pad re-derives; log untouched', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'correct' });          // +15 under old config
  s = reduce(s, { type: 'configure', patch: { points: { superpower: 20 } } });
  assert.deepEqual(s.config.pointPad, [15, 10, -5, 20]);
  assert.equal(scores(s).A, 15);                       // history unchanged
  s = reduce(s, { type: 'configure', patch: { scoring: false } });
  assert.equal(s.config.scoring, false);
  assert.equal(s.config.points.superpower, 20);        // deep merge kept it
});

function teamsStart() {
  let s = initialState();
  return play(s,
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'player_join', player: 'A2', team: 'Red' },
    { type: 'player_join', player: 'B1', team: 'Blue' },
    { type: 'player_join', player: 'Solo' },
    { type: 'question_start', qid: 'q1', powerIdx: 10, unitCount: 40 });
}

test('team bonus lines raise the team score, not the player score', () => {
  let s = teamsStart();
  s = play(s,
    { type: 'buzz', player: 'A1', unitIdx: 5 },
    { type: 'verdict', result: 'correct' },                              // +15 to A1
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 10 },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 1, points: 0 },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 2, points: 10 });
  assert.equal(scores(s).A1, 15);                    // tossup only
  assert.equal(teamScores(s).Red, 35);               // 15 + 20 bonus
});

test('a teamless controller keeps bonus points individually', () => {
  let s = teamsStart();
  s = play(s,
    { type: 'buzz', player: 'Solo', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },
    { type: 'bonus_part', qid: 'q1', player: 'Solo', partIdx: 0, points: 10 });
  assert.equal(scores(s).Solo, 20);
  assert.equal(teamScores(s).Red ?? 0, 0);
  assert.equal(bonusStats(s).players.Solo.points, 10);
});

test('re-sending a bonus part supersedes it (give/ungive toggling)', () => {
  let s = teamsStart();
  s = play(s,
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 10 },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 0 },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 10 });
  assert.equal(teamScores(s).Red, 10);               // last line wins
  assert.equal(liveLog(s).filter(e => e.kind === 'bonus').length, 1);
  assert.equal(s.log.filter(e => e.kind === 'bonus').length, 3);  // history intact
});

test('bonusStats: heard counts distinct bonuses, zeros included; ppb', () => {
  let s = teamsStart();
  s = play(s,
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 10 },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 1, points: 10 },
    { type: 'bonus_part', qid: 'q2', team: 'Red', partIdx: 0, points: 0 },   // 0-30 bonus
    { type: 'bonus_part', qid: 'q2', team: 'Red', partIdx: 1, points: 0 },
    { type: 'bonus_part', qid: 'q3', team: 'Blue', partIdx: 0, points: 10 });
  const b = bonusStats(s);
  assert.equal(b.teams.Red.heard, 2);
  assert.equal(b.teams.Red.points, 20);
  assert.equal(b.teams.Red.ppb, 10);
  assert.equal(b.teams.Blue.heard, 1);
});

test('scoreless mode logs bonus parts at 0 (heard still tracked)', () => {
  let s = initialState({ scoring: false });
  s = play(s,
    { type: 'player_join', player: 'A1', team: 'Red' },
    { type: 'bonus_part', qid: 'q1', team: 'Red', partIdx: 0, points: 10 });
  assert.equal(teamScores(s).Red, 0);
  assert.equal(bonusStats(s).teams.Red.heard, 1);
});

test('tossupStats counts powers/gets/negs; superpowers fold into powers', () => {
  let s = start({ points: { superpower: 20 } }, { powerIdx: 10, superpowerIdx: 5 });
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 20 },
    { type: 'verdict', result: 'wrong' },              // B neg
    { type: 'buzz', player: 'A', unitIdx: 4 },
    { type: 'verdict', result: 'correct' },            // A superpower
    { type: 'question_start', qid: 'q2', powerIdx: 10, unitCount: 40 },
    { type: 'buzz', player: 'A', unitIdx: 9 },
    { type: 'verdict', result: 'correct' },            // A power
    { type: 'question_start', qid: 'q3', powerIdx: 10, unitCount: 40 },
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },            // A get
    { type: 'question_start', qid: 'q4', powerIdx: 10, unitCount: 40 },
    { type: 'reading_finished' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong' });             // B miss, not a neg
  assert.deepEqual(tossupStats(s).A, { powers: 2, gets: 1, negs: 0 });
  assert.deepEqual(tossupStats(s).B, { powers: 0, gets: 0, negs: 1 });
});

test('pad-forced points set the kind for the stat line', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: null },      // voice mode: no position
    { type: 'verdict', result: 'correct', points: 15 });
  assert.equal(s.log[0].kind, 'power');
  let t = start();
  t = play(t,
    { type: 'reading_finished' },
    { type: 'buzz', player: 'B', unitIdx: 39 },
    { type: 'verdict', result: 'wrong', points: -5 }); // host insists on the neg
  assert.equal(t.log[0].kind, 'neg');
  assert.deepEqual(tossupStats(t).B, { powers: 0, gets: 0, negs: 1 });
});

test('pad-forced 0 on a wrong buzz is a miss, not a neg', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },         // mid-reading
    { type: 'verdict', result: 'wrong', points: 0 });  // host declines the penalty
  assert.equal(scores(s).A, 0);
  assert.equal(s.log[0].kind, 'miss');
  assert.deepEqual(tossupStats(s).A, { powers: 0, gets: 0, negs: 0 });
  assert.deepEqual(s.current.lockouts, ['A'], 'wrong is wrong: still locked out');
});

test('dead + next cycle (dead is logged for history)', () => {
  let s = start();
  s = play(s, { type: 'dead' }, { type: 'next' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.current, null);
  assert.deepEqual(s.log.map(e => e.kind), ['dead']);
  assert.equal(scores(s).A, 0);
});

test('clear_scores empties the log; roster, config, and current question survive', () => {
  let s = start({ points: { superpower: 20 } }, { powerIdx: 10, superpowerIdx: 5 });
  s = play(s,
    { type: 'player_move', player: 'A', team: 'Red' },
    { type: 'player_move', player: 'B', team: 'Blue' },
    { type: 'buzz', player: 'B', unitIdx: 3 },
    { type: 'verdict', result: 'wrong' },              // B neg + lockout
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },
    { type: 'bonus_part', partIdx: 0, team: 'Red', points: 10 },
    { type: 'question_start', qid: 'q2', powerIdx: 10, unitCount: 40 },
    { type: 'buzz', player: 'B', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });             // B locked out on q2
  const lockouts = s.current.lockouts;
  assert.equal(scores(s).A, 10);
  s = reduce(s, { type: 'clear_scores' });
  assert.deepEqual(s.log, []);
  assert.deepEqual(scores(s), { A: 0, B: 0 });
  assert.deepEqual(teamScores(s), { Red: 0, Blue: 0 });
  assert.deepEqual(bonusStats(s), { teams: {}, players: {} });
  assert.deepEqual(tossupStats(s).B, { powers: 0, gets: 0, negs: 0 });
  assert.deepEqual(s.players, ['A', 'B']);
  assert.equal(s.config.points.superpower, 20);
  assert.equal(s.phase, 'reading');                    // q2 keeps going
  assert.equal(s.current.qid, 'q2');
  assert.deepEqual(s.current.lockouts, lockouts);      // B stays locked out
});

test('clear_scores works between questions (no current)', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },
    { type: 'next' },
    { type: 'clear_scores' });
  assert.deepEqual(s.log, []);
  assert.equal(s.phase, 'idle');
  assert.equal(scores(s).A, 0);
});

test('retract voids a line: scores, stats, and history re-derive', () => {
  let s = start();
  s = play(s,
    { type: 'player_move', player: 'A', team: 'Red' },
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },
    { type: 'bonus_part', partIdx: 0, team: 'Red', points: 10 });
  assert.equal(scores(s).A, 10);
  s = reduce(s, { type: 'retract', entryIdx: 0 });
  assert.equal(scores(s).A, 0);
  assert.deepEqual(tossupStats(s).A, { powers: 0, gets: 0, negs: 0 });
  assert.equal(liveLog(s).length, 1);            // only the bonus line remains
  assert.equal(s.log.length, 2, 'raw log keeps the voided line (event sourcing)');
  const again = reduce(s, { type: 'retract', entryIdx: 0 });
  assert.equal(liveLog(again).length, 1, 'double retract is a no-op');
});

test('retracting a current-question neg releases the team lockout', () => {
  let s = start();
  s = play(s,
    { type: 'player_move', player: 'A', team: 'Red' },
    { type: 'player_move', player: 'B', team: 'Red' },
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });       // whole Red team locked
  assert.deepEqual([...s.current.lockouts].sort(), ['A', 'B']);
  s = reduce(s, { type: 'retract', entryIdx: 0 });
  assert.deepEqual(s.current.lockouts, []);
  assert.equal(scores(s).A, 0);
  // B can buzz again
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 20 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 10);
});

test('retract on a PAST question leaves the current one untouched', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },              // q1: A +10
    { type: 'question_start', qid: 'q2', powerIdx: 10, unitCount: 40 },
    { type: 'buzz', player: 'B', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' });               // q2: B locked
  s = reduce(s, { type: 'retract', entryIdx: 0 });       // undo q1's get
  assert.equal(scores(s).A, 0);
  assert.deepEqual(s.current.lockouts, ['B'], 'q2 lockout survives');
  assert.equal(s.phase, 'reading');
});

test('award with qid + kind: the review "redo" scores a past question honestly', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },              // q1: A +10 (mis-attributed)
    { type: 'question_start', qid: 'q2', powerIdx: 10, unitCount: 40 },
    { type: 'retract', entryIdx: 0 },                    // undo A's buzz on q1
    { type: 'award', player: 'B', points: 15, qid: 'q1', kind: 'power' });
  assert.equal(scores(s).A, 0);
  assert.equal(scores(s).B, 15);
  assert.equal(tossupStats(s).B.powers, 1, 'redo counts in stat lines');
  const line = liveLog(s).find(e => e.player === 'B');
  assert.equal(line.qid, 'q1', 'attributed to the reviewed question');
  // plain adjustments still land on the current question with kind award
  s = reduce(s, { type: 'award', player: 'A', points: 5, reason: 'adjust' });
  const adj = liveLog(s).at(-1);
  assert.equal(adj.qid, 'q2');
  assert.equal(adj.kind, 'adjust');
});

test('a retracted bonus line un-hears the bonus and frees the supersede slot', () => {
  let s = start();
  s = play(s,
    { type: 'player_move', player: 'A', team: 'Red' },
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' },
    { type: 'bonus_part', partIdx: 0, team: 'Red', points: 10 });
  assert.equal(bonusStats(s).teams.Red.heard, 1);
  const bonusIdx = s.log.findIndex(e => e.kind === 'bonus');
  s = reduce(s, { type: 'retract', entryIdx: bonusIdx });
  assert.deepEqual(bonusStats(s), { teams: {}, players: {} });
  // a re-logged part shows up again (retraction didn't wedge the slot)
  s = reduce(s, { type: 'bonus_part', qid: 'q1', partIdx: 0, team: 'Red', points: 10 });
  assert.equal(bonusStats(s).teams.Red.points, 10);
});

test('retracting the current question\'s winning line reopens it', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 20 },
    { type: 'verdict', result: 'correct' });
  assert.equal(s.phase, 'done');
  s = reduce(s, { type: 'retract', entryIdx: 0 });
  assert.equal(s.phase, 'reading', 'question reopens');
  s = play(s,
    { type: 'buzz', player: 'B', unitIdx: 25 },
    { type: 'verdict', result: 'correct' });
  assert.equal(scores(s).B, 10);
  assert.equal(scores(s).A, 0);
});

test('retracting a neg keeps the question done while a winner stands', () => {
  let s = start();
  s = play(s,
    { type: 'buzz', player: 'A', unitIdx: 5 },
    { type: 'verdict', result: 'wrong' },
    { type: 'buzz', player: 'B', unitIdx: 20 },
    { type: 'verdict', result: 'correct' });
  s = reduce(s, { type: 'retract', entryIdx: 0 });
  assert.equal(s.phase, 'done');
  assert.equal(scores(s).B, 10);
  assert.deepEqual(s.current.lockouts, []);
});
