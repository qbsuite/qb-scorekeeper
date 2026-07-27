// reveal_units.js — THE canonical reveal-unit contract (classic script).
//
// SINGLE SOURCE OF TRUTH, shared by the qb-scorekeeper app and the
// library-of-stock reader: the site's build vendors this exact file
// (lib/js/reveal_units.js) from this repo — edit it HERE, never there.
// Unit splitting must stay identical across every consumer: powerIdx
// and buzz positions are unit indexes, so a drifted splitter mis-scores
// powers.
//
// Loadable everywhere: a classic <script> (the site is no-build vanilla
// JS) that attaches globalThis.qbRevealUnits; ESM/node consumers import
// the file for its side effect and read the global.
//
// A "unit" is one reveal token: whitespace-split words, except dash-
// joined musical note runs ("E–F♯–G–E"), which split into per-note
// units so score clues don't pop all at once. slowSpans marks note runs
// for slower text-reveal pacing (SLOW_FACTOR); audio mode doesn't use
// it. (Splitter logic originated in reader.js, July 2026.)
(function () {
'use strict';

var NOTEISH = /^["“(«]?(?:[A-G](?:♯|♭|#|b)?(?:-?(?:sharp|flat|natural))?|[Dd]o|[Rr]e|[Mm]i|[Ff]a|[Ss]ol|[Ll]a|[Tt]i|[Ss]i)(?:['’]?s)?[”")»\],.;:!?–—-]*$/;
var NOTE_CONT = /^(?:double[-\s]?)?(?:sharps?|flats?|naturals?|longs?|shorts?|repeated|dotted|tied|slurred|staccato|triplets?|high(?:er)?|low(?:er)?|notes?|majors?|minors?|eighths?|quarters?|sixteenths?|thirty|second|halves|half|whole|ascending|descending|rising|falling|pause|rest|sustained|grace|augmented|diminished|perfect|two|three|four|five|six|seven|eight)[”")»\],.;:!?]*$/i;
var NOTE_GLUE = /^(?:and|then|to|or|a|an|back|up|down|again|from|by|via|of|followed)[,.;:]?$/i;
var LONE_DASH = /^[–—-]+$/;
var GLUE_MAX = 3;
var SLOW_FACTOR = 2.4;

function splitNoteRun(w) {
  if (!/[–—-]/.test(w) || w.length < 3) return null;
  var parts = w.split(/(?<=[–—-])/);
  var merged = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (merged.length && /^(sharp|flat|natural)[–—-]?["”")\],.;:!?]*$/i.test(p)) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  if (merged.length < 3) return null;
  if (!merged.every(function (x) { return NOTEISH.test(x); })) return null;
  return merged;
}

function buildUnits(words) {
  var units = [];
  for (var i = 0; i < words.length; i++) {
    var parts = splitNoteRun(words[i]);
    if (parts) parts.forEach(function (p, j) { units.push({ t: p, sep: j === 0 ? ' ' : '' }); });
    else units.push({ t: words[i], sep: ' ' });
  }
  return units;
}

function slowSpans(words) {
  var slow = new Set();
  var runStart = -1, noteCount = 0, gap = 0;
  function flush(end) {
    if (noteCount >= 3) for (var k = runStart; k < end; k++) slow.add(k);
    runStart = -1; noteCount = 0; gap = 0;
  }
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (NOTEISH.test(w)) { if (runStart < 0) runStart = i; noteCount++; gap = 0; }
    else if (runStart >= 0 && (NOTE_CONT.test(w) || LONE_DASH.test(w))) { /* extend, don't count */ }
    else if (runStart >= 0 && NOTE_GLUE.test(w) && gap < GLUE_MAX) { gap++; }
    else if (runStart >= 0) { flush(i); }
  }
  flush(words.length);
  return slow;
}

/** Units for a question's sanitized text + the power/superpower unit
 * indexes ((*) and (+) marks; null when absent). */
function questionUnits(questionSanitized) {
  var units = buildUnits(questionSanitized.split(/\s+/).filter(Boolean));
  function idxOf(mark) {
    for (var i = 0; i < units.length; i++) if (units[i].t === mark) return i;
    return null;
  }
  return { units: units, powerIdx: idxOf('(*)'), superpowerIdx: idxOf('(+)') };
}

globalThis.qbRevealUnits = {
  buildUnits: buildUnits,
  slowSpans: slowSpans,
  questionUnits: questionUnits,
  SLOW_FACTOR: SLOW_FACTOR,
};
})();
