// engine.js — the qb-scorekeeper game engine.
//
// A pure, event-sourced reducer (see SPEC.md). No I/O, no clocks, no
// randomness: callers pass timestamps and reveal-unit positions in the
// events. Scores are always derived from the log via scores(), never
// stored, so host corrections are ordinary log edits.
//
// Runs unchanged in a browser tab (solo mode) and inside the room
// server (v1). Keep it dependency-free and serializable.

/** Fill a scoring config with defaults (see SPEC.md "Scoring config"). */
export function defaultConfig(overrides = {}) {
  const points = {
    power: 15, get: 10, neg: -5, superpower: null, bonusPart: 10,
    ...(overrides.points || {}),
  };
  const pointPad = overrides.pointPad
    || [points.power, points.get, points.neg,
        ...(points.superpower != null ? [points.superpower] : [])];
  return {
    scoring: true,
    humanJudge: false,
    ...overrides,
    points,
    pointPad,
  };
}

export function initialState(config = {}) {
  return {
    config: defaultConfig(config),
    players: [],
    teams: {},            // player -> team name (absent/null = unassigned)
    phase: 'idle',        // idle | reading | buzzed | done
    current: null,        // {qid, powerIdx, superpowerIdx, unitCount,
                          //  readingFinished, buzz, lockouts: []}
    log: [],              // [{qid, player, points, kind, unitIdx, ts}]
  };
}

/** The log with superseded bonus lines and retracted entries removed:
 * a later `bonus` entry for the same (qid, partIdx) replaces the
 * earlier one (give/ungive toggling as ordinary appends), and a
 * `retract` voids any line. Everything derived — scores, stats,
 * history — reads this, never state.log directly. */
export function liveLog(state) {
  const last = new Map();
  state.log.forEach((e, i) => {
    if (!e.retracted && e.kind === 'bonus' && e.partIdx != null) last.set(e.qid + '\0' + e.partIdx, i);
  });
  return state.log.filter((e, i) =>
    !e.retracted && (e.kind !== 'bonus' || e.partIdx == null || last.get(e.qid + '\0' + e.partIdx) === i));
}

/** Total points per player, derived from the log. Bonus lines carry a
 * team instead of a player (unless the controlling player is teamless),
 * so individual scores are tossup-only. */
export function scores(state) {
  const totals = {};
  for (const p of state.players) totals[p] = 0;
  for (const e of liveLog(state)) {
    if (e.player != null) totals[e.player] = (totals[e.player] || 0) + e.points;
  }
  return totals;
}

/** Total points per team: members' points plus team-attributed lines
 * (bonuses). Players without a team are excluded. */
export function teamScores(state) {
  const per = scores(state);
  const totals = {};
  for (const p of state.players) {
    const t = state.teams[p];
    if (t) totals[t] = (totals[t] || 0) + per[p];
  }
  for (const e of liveLog(state)) {
    if (e.team != null) totals[e.team] = (totals[e.team] || 0) + e.points;
  }
  return totals;
}

/** Bonus conversion, split by attribution: {teams: {name: {heard,
 * points, ppb}}, players: {...}} (players = teamless controllers). A
 * bonus counts as heard once any of its parts is logged, 0s included. */
export function bonusStats(state) {
  const acc = { teams: {}, players: {} };
  for (const e of liveLog(state)) {
    if (e.kind !== 'bonus') continue;
    const bucket = e.team != null ? acc.teams : acc.players;
    const key = e.team ?? e.player;
    if (key == null) continue;
    const s = bucket[key] || (bucket[key] = { points: 0, qids: new Set() });
    s.qids.add(e.qid);
    s.points += e.points;
  }
  for (const bucket of [acc.teams, acc.players]) {
    for (const s of Object.values(bucket)) {
      s.heard = s.qids.size;
      delete s.qids;
      s.ppb = s.heard ? s.points / s.heard : 0;
    }
  }
  return acc;
}

/** Per-player tossup counts {powers, gets, negs}; superpowers count as
 * powers. Post-reading misses and pad adjustments are not counted. */
export function tossupStats(state) {
  const acc = {};
  for (const p of state.players) acc[p] = { powers: 0, gets: 0, negs: 0 };
  for (const e of liveLog(state)) {
    if (e.player == null || !acc[e.player]) continue;
    if (e.kind === 'superpower' || e.kind === 'power') acc[e.player].powers++;
    else if (e.kind === 'get') acc[e.player].gets++;
    else if (e.kind === 'neg') acc[e.player].negs++;
  }
  return acc;
}

/** A wrong buzz locks out the buzzer's whole team (standard rules);
 * unassigned players lock out individually. */
function teammates(state, player) {
  const t = state.teams[player];
  if (!t) return [player];
  return state.players.filter(p => state.teams[p] === t);
}

/** Kind for a correct buzz at unitIdx, per the rule table. An unknown
 * position (unitIdx null — manual-read/voice mode) is never a power;
 * the host point pad is how those get 15s. (Beware: null < 10 is true
 * in JS, hence the explicit guard.) */
function correctKind(config, current) {
  const { unitIdx } = current.buzz;
  if (unitIdx == null) return 'get';
  if (config.points.superpower != null && current.superpowerIdx != null
      && unitIdx < current.superpowerIdx) return 'superpower';
  if (current.powerIdx != null && unitIdx < current.powerIdx) return 'power';
  return 'get';
}

function correctPoints(config, current) {
  if (!config.scoring) return 0;
  const kind = correctKind(config, current);
  const p = config.points;
  return kind === 'superpower' ? p.superpower : kind === 'power' ? p.power : p.get;
}

/** When the host pad forces the points (voice/manual mode, position
 * unknown), the kind follows the forced value — a pad +15 IS a power in
 * the stat line. Unrecognized values fall back to position-derived. */
function padKind(config, points) {
  const p = config.points;
  if (p.superpower != null && points === p.superpower) return 'superpower';
  if (points === p.power) return 'power';
  if (points === p.get) return 'get';
  return null;
}

/**
 * Apply one event; returns the next state (input state is not mutated).
 * Unknown or out-of-phase events return the state unchanged — the
 * engine is authoritative and simply refuses impossible transitions.
 */
export function reduce(state, event) {
  const { type } = event;

  if (type === 'player_join') {
    if (state.players.includes(event.player)) return state;
    return {
      ...state,
      players: [...state.players, event.player],
      teams: { ...state.teams, [event.player]: event.team ?? null },
    };
  }
  if (type === 'player_leave') {
    const teams = { ...state.teams };
    delete teams[event.player];
    return { ...state, teams, players: state.players.filter(p => p !== event.player) };
  }
  if (type === 'player_move') {
    // Moves between teams AND/OR reorders: the player is re-inserted
    // before event.before (or at the end). team undefined = keep team
    // (pure reorder); team null = unassign.
    if (!state.players.includes(event.player)) return state;
    const players = state.players.filter(p => p !== event.player);
    const at = event.before && players.includes(event.before)
      ? players.indexOf(event.before) : players.length;
    players.splice(at, 0, event.player);
    const team = event.team === undefined
      ? (state.teams[event.player] ?? null) : (event.team ?? null);
    return { ...state, players, teams: { ...state.teams, [event.player]: team } };
  }

  if (type === 'configure') {
    // Live settings change (scoring on/off, point values, humanJudge).
    // The point pad re-derives from the new values unless the patch
    // pins its own. Applies to future verdicts; the log is untouched.
    const merged = {
      ...state.config,
      ...event.patch,
      points: { ...state.config.points, ...(event.patch.points || {}) },
    };
    if (!event.patch.pointPad) delete merged.pointPad;
    return { ...state, config: defaultConfig(merged) };
  }

  if (type === 'clear_scores') {
    // Fresh scoreboard: the log empties, so every score, stat line, and
    // ppb re-derives to zero. Roster, config, and the current question
    // (lockouts included) are untouched.
    return { ...state, log: [] };
  }

  if (type === 'retract') {
    // Surgically void one past log entry (review's "undo buzz"): the
    // line stays in the raw log (event sourcing) but liveLog drops it,
    // so scores, stats, and history re-derive without it. Retracting a
    // wrong buzz on the CURRENT question also releases its lockouts —
    // they rebuild from the remaining live wrong entries.
    const target = state.log[event.entryIdx];
    if (!target || target.retracted) return state;
    const log = state.log.map((e, i) =>
      i === event.entryIdx ? { ...e, retracted: true } : e);
    let current = state.current;
    if (current && target.qid === current.qid
        && (target.kind === 'neg' || target.kind === 'miss')) {
      const locked = new Set();
      for (const e of log) {
        if (e.retracted || e.qid !== current.qid) continue;
        if (e.kind !== 'neg' && e.kind !== 'miss') continue;
        for (const p of teammates(state, e.player)) locked.add(p);
      }
      current = { ...current, lockouts: [...locked] };
    }
    // If the retraction removed whatever ENDED the current question — a
    // winning buzz, a dead call, or the last exhausting lockout — the
    // question reopens (clocks stay paused until the host acts).
    let phase = state.phase;
    if (current && target.qid === current.qid && phase === 'done') {
      const stillEnded = log.some(e => !e.retracted && e.qid === current.qid
          && (e.kind === 'superpower' || e.kind === 'power' || e.kind === 'get' || e.kind === 'dead'))
        || (current.readingFinished && state.players.length > 0
            && state.players.every(p => current.lockouts.includes(p)));
      if (!stillEnded) phase = 'reading';
    }
    return { ...state, phase, log, current };
  }

  if (type === 'question_start') {
    return {
      ...state,
      phase: 'reading',
      current: {
        qid: event.qid,
        powerIdx: event.powerIdx ?? null,
        superpowerIdx: event.superpowerIdx ?? null,
        unitCount: event.unitCount ?? null,
        readingFinished: false,
        buzz: null,
        lockouts: [],
      },
    };
  }

  if (!state.current && type !== 'award' && type !== 'bonus_part') return state;

  if (type === 'reading_finished') {
    if (state.phase !== 'reading') return state;
    return { ...state, current: { ...state.current, readingFinished: true } };
  }

  if (type === 'buzz') {
    // First non-locked-out buzzer wins; reading pauses (caller's job).
    if (state.phase !== 'reading') return state;
    if (state.current.lockouts.includes(event.player)) return state;
    return {
      ...state,
      phase: 'buzzed',
      current: {
        ...state.current,
        buzz: { player: event.player, unitIdx: event.unitIdx, ts: event.ts ?? null },
      },
    };
  }

  if (type === 'verdict') {
    if (state.phase !== 'buzzed') return state;
    const cur = state.current;
    const { player, unitIdx, ts } = cur.buzz;

    if (event.result === 'correct') {
      // event.points overrides the rule table — the host point pad in
      // voice/manual-read mode, where the app can't know the position.
      const kind = (event.points != null && padKind(state.config, event.points))
        || correctKind(state.config, cur);
      const entry = {
        qid: cur.qid, player, kind,
        points: event.points ?? correctPoints(state.config, cur), unitIdx, ts,
        source: event.source ?? 'host', answer: event.answer ?? null,
      };
      return {
        ...state,
        phase: 'done',
        current: { ...cur, buzz: null },
        log: [...state.log, entry],
      };
    }

    // Wrong: neg only while the question was still being read. Pad-
    // forced points override — the neg value IS a neg even post-reading
    // (the host insisted on a penalty), and anything else (an explicit
    // 0) is a penalty-free miss that stays out of the neg stat.
    const neg = state.config.scoring && !cur.readingFinished;
    const kind = event.points != null
      ? (event.points === state.config.points.neg ? 'neg' : 'miss')
      : cur.readingFinished ? 'miss' : 'neg';
    const entry = {
      qid: cur.qid, player, kind,
      points: event.points ?? (neg ? state.config.points.neg : 0), unitIdx, ts,
      source: event.source ?? 'host', answer: event.answer ?? null,
    };
    const lockouts = [...new Set([...cur.lockouts, ...teammates(state, player)])];
    // Everyone locked out after reading finished -> nothing left, dead.
    const exhausted = cur.readingFinished
      && state.players.length > 0
      && state.players.every(p => lockouts.includes(p));
    return {
      ...state,
      phase: exhausted ? 'done' : 'reading',
      current: { ...cur, buzz: null, lockouts },
      log: [...state.log, entry],
    };
  }

  if (type === 'award') {
    // Direct score line: the host point pad (voice mode's primary
    // scoring path), one-off corrections, and review's "redo the buzz"
    // — which targets a past question via `qid` and passes a tossup
    // `kind` (power/get/neg) so stat lines count it like a real buzz.
    return {
      ...state,
      log: [...state.log, {
        qid: event.qid ?? (state.current ? state.current.qid : null),
        player: event.player, kind: event.kind ?? event.reason ?? 'award',
        points: event.points, unitIdx: null, ts: event.ts ?? null,
        source: 'host', answer: null,
      }],
    };
  }

  if (type === 'bonus_part') {
    // One bonus part's outcome, attributed to a team — or to a teamless
    // controlling player, whose individual score then includes it.
    // Re-sending the same (qid, partIdx) supersedes the earlier line
    // (see liveLog), which is how checkboxes give/ungive points. Parts
    // are logged even at 0 so bonuses-heard (ppb) is derivable.
    return {
      ...state,
      log: [...state.log, {
        qid: event.qid ?? (state.current ? state.current.qid : null),
        player: event.player ?? null, team: event.team ?? null,
        kind: 'bonus', partIdx: event.partIdx,
        points: state.config.scoring ? event.points : 0,
        unitIdx: null, ts: event.ts ?? null, source: 'host', answer: null,
      }],
    };
  }

  if (type === 'dead') {
    if (state.phase !== 'reading' && state.phase !== 'buzzed') return state;
    return {
      ...state,
      phase: 'done',
      current: { ...state.current, buzz: null },
      // Logged so game history shows dead tossups, not silent gaps.
      log: [...state.log, { qid: state.current.qid, player: null, kind: 'dead',
                            points: 0, unitIdx: null, ts: event.ts ?? null,
                            source: 'host', answer: null }],
    };
  }

  if (type === 'next') {
    if (state.phase !== 'done') return state;
    return { ...state, phase: 'idle', current: null };
  }

  if (type === 'override') {
    // Host edits a past score line; totals recompute from the log. On
    // tossup lines the kind follows the new points — a get re-scored
    // to the neg value IS a neg, 0 a miss — so stat lines stay honest.
    const TOSSUP_KINDS = ['superpower', 'power', 'get', 'neg', 'miss'];
    const log = state.log.map((e, i) => {
      if (i !== event.entryIdx) return e;
      let kind = e.kind;
      if (TOSSUP_KINDS.includes(e.kind)) {
        kind = event.points === state.config.points.neg ? 'neg'
          : event.points === 0 ? 'miss'
          : padKind(state.config, event.points) ?? e.kind;
      }
      return { ...e, points: event.points, kind, overridden: true };
    });
    return { ...state, log };
  }

  return state;
}
