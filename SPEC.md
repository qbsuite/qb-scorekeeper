# qb-scorekeeper — engine & protocol spec

Version: 0.1 (solo mode). The room protocol (v1) extends these same
events over WebSocket; the engine is identical in a browser tab and in
the room server.

## Design rules

- **The engine is a pure, event-sourced reducer.** No I/O, no clocks, no
  randomness: every event carries the data it needs (timestamps,
  positions). State is fully serializable; **scores are derived from the
  event log**, never stored — so host corrections are just log edits and
  the scoreboard can always be recomputed.
- **Positions are abstract unit indexes** (a "unit" is one reveal token —
  see Reveal units below). The engine never sees question text; the
  caller resolves text/audio time → unit index. This is what lets the
  same engine adjudicate powers from a text clock (rooms) or an audio
  clock via qb-audio sidecars (read-aloud).
- **Every automatic verdict is a suggestion.** The host can override any
  verdict and edit any score line; the human-manned mode simply makes
  host input the only verdict source.

## Scoring config

```js
{
  scoring: true,            // false = scoreless (buzz order + reveal only)
  points: {
    power: 15,              // correct before the power mark
    get: 10,                // correct after the power mark
    neg: -5,                // wrong while still reading; after reading: 0
    superpower: null,       // e.g. 20 for sets with (+) marks; null = off
    bonusPart: 10,
  },
  pointPad: [15, 10, -5],   // host quick-award buttons (voice mode's
                            // primary scoring path); +20 appended when
                            // superpower is enabled; any values allowed
  humanJudge: false,        // true = no auto-checker; host adjudicates
}
```

Rule table (applied on VERDICT, using the buzz's unit index):

| Condition | Points |
|---|---|
| correct ∧ `unitIdx < superpowerIdx` (if enabled) | `points.superpower` |
| correct ∧ `unitIdx < powerIdx` | `points.power` |
| correct (otherwise) | `points.get` |
| wrong ∧ reading not finished | `points.neg` + lockout |
| wrong ∧ reading finished | 0 + lockout |

With `scoring: false` the same transitions happen with 0-point log
entries (buzz order, lockouts, and history still work).

## Engine events

| Event | Payload | Effect |
|---|---|---|
| `question_start` | `{qid, powerIdx, superpowerIdx, unitCount}` | phase → `reading`, clears buzz state |
| `reading_finished` | `{}` | closes the neg window (phase stays askable) |
| `buzz` | `{player, unitIdx, ts}` | first non-locked-out player wins: phase → `buzzed`, reading pauses |
| `verdict` | `{result: 'correct'\|'wrong', source: 'checker'\|'host', answer?, points?}` | scores per rule table — `points` overrides it (the host point pad in voice/manual-read mode, where position is unknown); correct → phase `done`; wrong → lockout, phase → `reading` (resume) or `dead` if everyone is locked out and reading finished |
| `award` | `{player, points, reason, qid?, kind?}` | direct score line (host point pad, corrections); `qid` targets a past question and a tossup `kind` (power/get/neg) makes it count in stat lines — review's "redo the buzz" |
| `retract` | `{entryIdx}` | surgically voids one log entry — the raw log keeps it (event sourcing) but `liveLog` drops it, so scores/stats/history re-derive as if the buzz never happened; a current-question neg's lockouts rebuild from the remaining live entries |
| `bonus_part` | `{qid, team?, player?, partIdx, points}` | one bonus part's outcome, attributed to the controlling player's **team** (or to the player only when teamless — Denis's rule: bonuses score to the team). Logged at 0 too, so bonuses-heard/ppb is derivable. Re-sending the same `(qid, partIdx)` **supersedes** the earlier line (`liveLog()` keeps the last) — give/ungive toggling is ordinary appends |
| `dead` | `{}` | give up on the question: phase → `done`, no score |
| `next` | `{}` | ready for the next `question_start` |
| `override` | `{entryIdx, points}` | edits a past log entry (scores recompute) |
| `clear_scores` | `{}` | empties the log: every score, stat line, and ppb re-derives to zero; roster, config, and the current question (lockouts included) are untouched |
| `player_join` / `player_leave` | `{player, team?}` | roster; team is optional |
| `player_move` | `{player, team?, before?}` | reassign team and/or reorder: re-inserted before `before` (or at the end); `team` omitted = keep (pure reorder) |
| `configure` | `{patch}` | live settings change: merges scoring/points/humanJudge; pointPad re-derives from new points unless the patch pins one; the log is untouched |

State shape: `{config, players[], teams: {player: teamName|null}, phase,
current: {qid, powerIdx, superpowerIdx, unitCount, readingFinished,
buzz: {player, unitIdx} | null, lockouts: []}, log: [{qid, player,
team?, points, kind, partIdx?, unitIdx, ts}]}`. Selectors over `log`
(all via `liveLog()`, which drops superseded bonus lines):
`scores(state)` — per player, tossup-only unless teamless bonuses;
`teamScores(state)` — members' points + team-attributed bonus lines;
`bonusStats(state)` — `{teams, players}` of `{heard, points, ppb}`;
`tossupStats(state)` — per player `{powers, gets, negs}` from entry
kinds (superpowers count as powers; when a verdict carries forced pad
points, the kind follows the forced value — a pad +15 is a power, a
forced −5 after reading a neg — so voice-mode stat lines stay honest).
**Teams**: a wrong buzz locks out the buzzer's
whole team (standard rules); unassigned players lock out individually;
the question deads when every player is locked after reading finishes.

## Reading modes (app-level; the engine only sees events)

- `audio` — qb-audio TTS; question text AND answer hidden until the
  question ends, so the host can play. Position from the audio clock via
  sidecars. Falls back to `reveal` when a qid has no audio (never to
  full text — no spoilers). A ⟲ button replays the audio from the top
  (missed/glitched playback); scores, lockouts, and the engine are
  untouched — only the position clock rewinds with it. With a room and
  the Broadcast setting on, phones play the same files, started on a
  shared server-clock instant (see Room protocol → Audio broadcast).
- Every question loads into a **ready state** first (audio pre-buffered,
  room buzzers closed). Only the first question of a freshly loaded
  packet waits for the host's Start button; Next starts reading the
  following question automatically, in all three modes.
- `reveal` — reader-contract word-by-word reveal (wpm + slow note-run
  spans); host can play; answer hidden until done. The default mode.
- `text` — full text + answer always visible: the host is the moderator
  and reads aloud themselves. Position unknown (`unitIdx: null`).

**Bonus cycle** (app-level toggle; engine-wise `bonus_part` events):
after a correct buzz the bonus reads part by part, tossup kept on
screen. **Space** steps the reveal — current part's answer, then the
next part's text. A **checkbox left of each part** (or keys **1/2/3**)
gives/ungives that part's points to the controlling **team** —
toggleable any time while the bonus is up, each toggle a superseding
`bonus_part`. A part logs (at 0) the moment its answer shows, which is
what feeds bonuses-heard/ppb. **Answers hidden until space** is the
default in audio and reveal modes (the host plays along — no bonus TTS
exists, the host reads the part aloud without seeing the answer) and
off in full-text mode; a ⚙ setting (`auto`/`hidden`/`shown`,
persisted) overrides the mode default, captured per bonus. Team panels
show `bonus +X · ppb Y.Y`; player rows show a `powers/gets/negs` stat
line (tossup-only scores). While a bonus is up, the display snapshot
carries the controlling team/player as `bonus`, and room players' buzz
buttons read `Red · bonus`. A **heard** bonus (any part logged) ships
its text + answers with the question's qlog entry, so room players'
Past Questions include it; unheard bonuses stay off the wire until
review scores them late (they can still be read aloud — no spoilers).
Tested in `tests/bonus.test.mjs` (sliced real handlers + real engine).
The roster UI exposes per-player point buttons (pointPad + 0): during
reading they capture buzz + verdict in one tap; otherwise they're direct
`award` adjustments.

**Power tiers on a host-read clock**: with a power mark in the question
and mode full-text or reveal (the moderator reads aloud, so the
on-screen position is approximate), a correct verdict needs an explicit
tier — the ✓ becomes +15/+10 buttons (+20 first when superpowers are
on) and a checker accept only fills the adjudication field instead of
auto-scoring. TTS-audio mode keeps auto verdicts (the audio clock IS
the position). Tested in `tests/answers.test.mjs`.

**Clear** (adjudication row, next to ✓/✗): drops a pending buzz with no
engine events at all — no verdict, no score line, no lockout (buzzer
checks, accidental taps). The buzzer's phone releases (`answer_result:
done`), reading resumes, and the room re-arms; the buzz's undo mark is
discarded (the voided-buzz pattern), so undo history reads as if the
buzz never happened. Tested in `tests/answers.test.mjs`.

**Undo** (app-level, event replay): every engine event funnels through
one recorder; each host action (buzz, verdict, pad tap, bonus step or
toggle, dead, next, start, review edit) pushes a mark + a snapshot of
the app-side mutables (cur incl. bonus progress, tuIdx, pendingBuzz,
qlog length, audio position). ↶ / ctrl+z rebuilds the engine state by
replaying everything before the mark, KEEPING roster and `configure`
events that landed after it — a mid-question room join survives
undoing the verdict it interrupted. Reading states restore paused;
audio reloads + seeks to the snapshot position when the question
changed. Undoing a pending remote buzz releases the phone's answer bar
(`answer_result: done`). Right-click reaches the same machinery: the
red buzz button offers "undo buzz" (= Clear), and any history line
offers "undo from here" — the stack replays until that line and
everything after it is gone. Tested in `tests/undo.test.mjs`.

**Session persistence** (survive a host refresh): the whole session —
engine event log, packet position, the live question, a pending buzz,
the room code — saves to localStorage after every host action (plus a
`beforeunload` flush for the live audio position) and rebuilds by
replay via a Resume row in the set sheet (12h TTL, matching the room).
Rejoining the room is just the normal host reconnect, so this costs
zero extra server traffic. Mid-question resumes come back paused at
the saved position (undo semantics); the undo stack is the one thing
that does not survive. Tested in `tests/session.test.mjs`.

**Review** (browse previous questions): ◂ steps back through the
current packet's completed tossups (between questions only; ▸ returns
toward the live one). A reviewed question shows its full text +
answer, its score lines with an edit pad (`override` — kind re-derives
from the new points so stat lines stay honest), and its bonus with
live checkboxes / 1-2-3 keys (`bonus_part` supersede re-scores it; a
bonus the tossup winner's team never heard can be scored late,
attributed via the winning line). **Undo + redo a buzz**: right-click
a score line to retract it (`retract` — as if the buzz never
happened), then the roster point pad scores the replacement onto the
REVIEWED question (`award` with qid + kind, so a +15 is a power in
the stat lines); the bonus re-attributes to the new winner as its
parts are re-toggled. Review edits refresh the matching qlog entry so
room players' Past Questions stay truthful. Tested end-to-end in
`tests/dom_session.test.mjs`.

## Reveal units (shared contract with the reader)

A question's text splits into reveal units exactly as `reader.js
buildUnits` does (whitespace tokens; dash-joined note runs split; the
power mark `(*)` is its own unit). `powerIdx` = index of the `(*)` unit
(absent → no powers). Audio mode maps `currentTime` through the qb-audio
sidecar (`{qid}.json` chunk spans → chunk text word offsets) to the same
unit indexes; files without sidecars fall back to proportional
`currentTime/duration`.

## Data contracts consumed (all plain HTTP)

- **Questions**: the site's R2 data plane — `catalog.json`
  (`sets: [{slug, name, year, difficulty, standard}]`) and
  `sets/{slug}.json` (`{packets: [{number, name, tossups, bonuses}]}`,
  API-shaped docs).
- **Audio**: the qb-audio dataset — `audio_index.json` manifest,
  `tossups/{qid[-2:]}/{qid}.opus`, `{qid}.json` sidecars.
- **Answer checking**: qbreader's qb-answer-checker, vendored
  (`app/vendor/answer_checker.js`, ISC, unmodified from the site's vendor
  copy) — verdicts are suggestions for the host.

## Room protocol — v1 BUILT (host-authoritative relay)

`rooms/worker.js`: one SQLite-backed Durable Object per room (WebSocket
Hibernation, free plan), self-hostable via `rooms/wrangler.toml`;
default instance `https://qb-rooms.denisliu10.workers.dev`. **v1
deliberately simplifies the docs/rooms.md design: the engine stays in
the host's browser** (this is an in-person tool — the host is the
moderator and is trusted); the DO does only what a server must —
atomic first-buzz arbitration, fan-out, and a stored display snapshot
for late joiners.

- `POST /rooms` → `{code}` (4 chars, unambiguous alphabet; the code IS
  the DO name — no registry, rooms are temporary).
- `GET /rooms/:code/ws?name=&role=host|player` → WebSocket.
- player→DO: `{t:'buzz'}` — accepted only while armed; otherwise
  `{t:'rejected'}` to the sender. Also `{t:'pong', n, ts}` echoing an
  RTT probe, and `{t:'answer', text}` — a typed answer, relayed to
  hosts as `{t:'answer', name, text}` (capped at 300 chars; the host
  app drops answers from anyone but the pending buzzer).
- **Latency-equalized arbitration**: the DO pings players (`{t:'ping',
  n, ts}`, on join + each arm) and keeps a per-connection median RTT.
  The first buzz while armed disarms atomically (DO messages are
  serial) and opens a collection window sized to the slowest connected
  player's RTT (cap 200ms); buzzes arriving within it compete on
  **estimated press time** (arrival − RTT/2, compensation cap 100ms) and
  the winner is broadcast as `{t:'buzz', name}`, losers get
  `{t:'rejected'}`. So a cross-country remote player races a local one
  fairly; the caps bound both the announcement delay and what faking
  lag (delaying pongs — the irreducible attack) can steal. Clients that
  never pong get zero compensation, and with no RTT data at all the
  window is 0ms — plain first-arrival, the pre-equalization behavior
  (fully backward compatible). Roster entries carry each player's `rtt`
  so hosts can eyeball implausible values. Hosts additionally get
  `{t:'buzz_pending', name}` the INSTANT the window opens (first
  arrival) — the moderator's stop-reading cue; the equalized winner in
  the following `{t:'buzz'}` may differ, so attribution waits for it
  while the clock pause does not.
- host→DO: `{t:'state', snapshot}` (stored + fanned out),
  `{t:'arm'}` / `{t:'disarm'}`, `{t:'close'}` — end the room:
  `{t:'closed'}` broadcast (players stop reconnecting and return to
  their join screen), all sockets closed, storage wiped so the code
  returns to the pool immediately (additive, July 2026 — old workers
  ignore it and the host just leaves; the shared default instance
  serves consensus-scorekeeper too, whose UIs add their own close
  affordance) — and `{t:'answer_result', name, result,
  prompt?}` — broadcast verbatim. **Typed-answer flow**: the buzz
  winner's phone shows an answer input; the submitted text relays to
  the host, which runs the vendored checker — accept/reject score the
  buzz immediately (`applyVerdict`), `prompt` goes back as
  `{result:'prompt', prompt: directedPrompt?}` and keeps the buzz open
  for a retype (repeatable; the host's ✓/✗ can end the loop any time).
  Every verdict on a remote buzz — typed or host-tapped — is broadcast
  as an `answer_result` (`correct`/`wrong`; `done` releases the bar
  with no verdict, e.g. deading over a pending buzz), so the buzzer's
  phone always shows the outcome. With checker suggestions off, typed
  answers just fill the host's adjudication field.
- DO→client: `{t:'welcome', snapshot, armed, roster}` on connect, plus
  join/leave fan-out.
- Host app (`app/room.js`): sends a display snapshot after every engine
  event, arms exactly when `phase==='reading' && !cur.pending &&
  !pendingBuzz` (each question loads into a ready state — audio
  buffered, buzzers closed — and reads on the host's Start for a fresh
  packet's first question, automatically on Next after that), maps an
  incoming buzz to `pendingBuzz` at the host's current clock position
  with the player preselected; locked-out players' buzzes re-arm.
  Player joins auto-`player_join` the engine roster.
- Player page (`app/player.html`): join by code (+`?code=`/`?server=`
  URL params), full-screen buzz button (armed/waiting/mine/other/
  locked states; the buzz winner's name stays on everyone's button
  until the verdict or re-arm), typed-answer bar (input → sent →
  prompt/correct/wrong), live scoreboard, vibration, auto-reconnect.
- Live protocol test: `node tests/rooms.e2e.mjs` (not in CI — hits the
  deployed instance).

### Audio broadcast (v1.1, additive — online play)

With the **Broadcast TTS audio to phones** setting on (off by default;
in-person rooms stay silent), phones play the same qb-audio files as
the host. Design rules:

- **Audio bytes never transit the worker.** The host ships an
  `{t:'audio_manifest', entries: [{qid, url}]}` once per packet load
  (stored by the DO like the qlog; `welcome` carries it to late
  joiners); each phone downloads every `.opus` straight from the
  qb-audio CDN (2 at a time, into blob URLs) and reports
  `{t:'audio_ready'|'audio_error', qid}` per file — relayed to hosts
  with the player's name. The DO relays small control JSON only.
- **Clock sync**: any client sends `{t:'sync', c}` and the DO echoes
  `{t:'sync', c, s}` immediately (`s` = server now); clients keep the
  last 8 samples and use the min-RTT one's NTP-style offset
  (`app/sync.js`, pure + unit-tested, shared by host and player as a
  classic-script global like reveal_units). Burst of 3 on every socket
  open. Clients with no reply fall back to a coarse offset from the
  first stamped relay.
- **Scheduled start (the strict global-begin handshake)**: the host's
  Start/Next waits on a **ready gate** — every connected player has
  resolved (downloaded or failed) the question's audio, or a 4s
  deadline passes (stragglers get a roster mark, the game proceeds).
  It then sends `{t:'audio_start', qid, pos, rate}`; the DO stamps
  `sv` (server now) and `at = sv + AUDIO_LEAD_MS (300ms)` and
  broadcasts to EVERYONE — **the host included**, which schedules its
  own playback (and `question_start`, hence the buzzer arm) off the
  echo, so all devices begin at the same server instant. Late
  arrivals start immediately, seeked forward by the overshoot ×
  playbackRate. A host that never sees its echo (old worker) starts
  locally after 1s — exactly the pre-broadcast behavior.
- **Event-anchored, no heartbeat**: phones re-anchor only on
  `audio_pause` / `audio_resume` (scheduled like start) /
  `audio_rate` (rate + position in one anchor) / `audio_stop` /
  `audio_state {qid, playing, pos, rate, for?}` — every anchor carries
  the host's authoritative `currentTime` as `pos` (`t` is the message
  type key on the wire). The host element stays the buzz-position
  clock; nothing about position mapping changed. A phone that
  (re)joins mid-question sends `{t:'audio_resync'}` after `welcome`
  and gets a targeted `audio_state {for: name}` back.
- **Fast pause**: `{t:'buzz_pending', name}` is now **broadcast to
  everyone** (was hosts-only) — phones pause the instant the buzz
  window opens, skipping the host round trip, and the buzzer's own
  phone pauses optimistically on send. The host's `audio_pause`
  follows purely to re-pin the exact position; a voided buzz (winner
  locked out) is corrected by the host's scheduled `audio_resume`.
  Phones never resume on `rejected`.
- **Deployment order**: the worker must deploy before the app — the
  old worker silently drops unknown host messages, which the host
  fallback timers turn back into local-only (today's) behavior.
- Unlock: the phone's Join tap creates and primes the shared Audio
  element (autoplay policy); a per-phone 🔊/🔇 mute toggle covers
  players sitting in the same room as the host.

**Second consumer — consensus-scorekeeper** (July 2026,
github.com/consensus-scorekeeper): the Consensus trivia scorekeeper runs
its phone-buzzer rooms against the same default instance and vendors
`app/room.js` byte-identical (`src/vendor/room.js` there, with a drift
test against this checkout). The wire protocol above and `app/room.js`'s
exported API (`DEFAULT_SERVER`, `createRoom`, `connectHost`, the handle's
`playerUrl`/`send`/`close`) are therefore **frozen** — changes must be
backward-compatible and land here first. (July 2026, additive: an
optional `onMessage(m)` handler receives messages no named branch
consumed — the audio-broadcast traffic arrives there; consensus should
re-vendor at its convenience, older copies keep working.) Note the DO never inspects
`snapshot` or `qlog` payloads: each consumer defines its own shapes
(qb-scorekeeper's are described above; consensus renders its scoreboard
snapshot), so the shared instance serves both without coordination.

Server-authoritative grading + remote text reveal (the full rooms.md
design) remain the v2 path if online play beyond one room ever matters.
