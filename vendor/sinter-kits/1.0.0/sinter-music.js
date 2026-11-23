/* sinter-music 1.0.0 - own code (S1NTR). Pure pattern helpers for Tone.js and Strudel pieces:
 * Euclidean rhythms, arpeggio ordering, Markov melodies and song-structure plans. No audio dependency. */
(function (root) {
  'use strict';
  /** Bjorklund-style Euclidean rhythm: array of 0/1, `steps` long with `pulses` hits, rotated. */
  function euclid(steps, pulses, rotate) {
    var out = [], i, r = 0;
    for (i = 0; i < steps; i++) { out.push((i * pulses) % steps < pulses ? 1 : 0); }
    r = ((rotate || 0) % steps + steps) % steps;
    return out.slice(r).concat(out.slice(0, r));
  }
  /** Strudel mini-notation for a Euclidean rhythm, e.g. euclidMini('bd', 3, 8) -> "bd ~ ~ bd ~ ~ bd ~". */
  function euclidMini(sound, steps, pulses, rotate) { return euclid(steps, pulses, rotate).map(function (h) { return h ? sound : '~'; }).join(' '); }
  /** Order notes: up, down, updown, converge, random (seeded by `seed`). */
  function arp(notes, mode, seed) {
    var n = notes.slice(), i;
    if (mode === 'down') return n.reverse();
    if (mode === 'updown') return n.concat(n.slice(1, -1).reverse());
    if (mode === 'converge') { var o = [], a = 0, b = n.length - 1; while (a <= b) { o.push(n[a++]); if (a <= b) o.push(n[b--]); } return o; }
    if (mode === 'random') { var s = (seed || 1) >>> 0; for (i = n.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; var j = s % (i + 1), t = n[i]; n[i] = n[j]; n[j] = t; } return n; }
    return n;
  }
  /** First-order Markov melody: learn transitions from `train`, walk `length` notes. */
  function markov(train, length, seed) {
    var tab = {}, i, s = (seed || 1) >>> 0;
    for (i = 0; i < train.length - 1; i++) (tab[train[i]] = tab[train[i]] || []).push(train[i + 1]);
    function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    var cur = train[0], out = [cur];
    while (out.length < length) { var nx = tab[cur]; cur = nx && nx.length ? nx[Math.floor(rnd() * nx.length)] : train[Math.floor(rnd() * train.length)]; out.push(cur); }
    return out;
  }
  var FORMS = {
    'verse-chorus': ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
    aaba: ['A', 'A', 'B', 'A'], 'arc': ['quiet', 'build', 'peak', 'release'], rondo: ['A', 'B', 'A', 'C', 'A']
  };
  /** Song structure as [{name, bars}] (bars per section default 8). */
  function structure(form, bars) { return (FORMS[form] || FORMS.arc).map(function (name) { return { name: name, bars: bars || 8 }; }); }
  root.SinterMusic = { euclid: euclid, euclidMini: euclidMini, arp: arp, markov: markov, structure: structure, FORMS: Object.keys(FORMS) };
})(typeof window !== 'undefined' ? window : globalThis);
