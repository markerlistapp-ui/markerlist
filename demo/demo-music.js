/* demo-music.js -- la PARTITION des trois morceaux de la démo web de MarkerList (sans aucun son ici : demo-audio.js les joue).
 *
 * Pourquoi de la musique « écrite » : la démo n'a pas d'Ableton, donc pas d'enregistrement des morceaux. Les trois morceaux de démonstration (NEON SKYLINE, GRAVITY, PAPER HEARTS : 40 mesures chacun, cinq sections de 8 mesures, mêmes sections et
 * mêmes tempos que le simulateur) sont donc composés ici, à la main, sous forme de motifs : accords, grille de batterie, lignes de basse, arpèges, nappes, mélodies. Une piste par instrument, comme dans le set d'Ableton
 * (CLICK, DRUMS, BASS, KEYS, GUITARS, VOX) : couper, isoler ou baisser une piste dans « Pistes Ableton » s'entend vraiment.
 *
 * La partition est une FONCTION DE LA POSITION : eventsBetween(a, b) renvoie les notes qui commencent entre les temps a et b (positions absolues du set, comme celles du simulateur), sans rien retenir d'une
 * lecture à l'autre. Un saut, un retour de boucle ou un cue tombent donc sur la bonne musique, quel que soit l'endroit d'où l'on vient. Aucune note ne franchit une barre de mesure (les sections, les boucles et les
 * cues commencent et finissent toutes sur une barre), pour qu'un retour de boucle ne laisse jamais traîner une note de l'autre côté.
 *
 * Évènement : {beat, dur, track, kind, midi, vel, s} -- beat : début (temps absolu) ; dur : durée en temps ; track : 'drums' | 'bass' | 'keys' | 'guitars' | 'vox' ;
 * kind : la voix à jouer (kick, snare, clap, rim, hat, ohat, crash, tom, bass, pad, stab, ep, pluck, strum, lead, ahh, ooh) ; midi : hauteur (absente pour la batterie) ; vel : 0 à 1 ;
 * s : la couleur du morceau pour cette voix (voir STYLE : « house », « deep »...), qui règle le timbre dans demo-audio.js.
 */
(function (global) {
  'use strict';
  var Core = global.MarkerListDemoCore;
  if (!Core) { throw new Error('demo-music.js : demo-engine.js doit être chargé avant'); }
  var SONGS = Core.SONGS, SIGNATURE = Core.SIGNATURE, END_BEAT = Core.END_BEAT;
  var STEP = 0.25;                                            // un pas = une double croche = 1/4 de temps ; une mesure = 16 pas

  // ------------------------------------------------------------------ accords et hauteurs
  var PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function parseChord(symbol) {
    var m = /^([A-G])(#|b)?(m)?(7)?$/.exec(symbol);
    if (!m) { throw new Error('accord inconnu : ' + symbol); }
    var pc = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, iv = m[3] ? [0, 3, 7] : [0, 4, 7];
    if (m[4]) { iv.push(10); }
    return { pc: pc, iv: iv };
  }
  function lift(pc, low) { return low + (((pc - low) % 12) + 12) % 12; }          // la plus petite note de classe `pc` qui est >= low
  function bassRoot(ch) { return 36 + ch.pc; }                                    // C2 à B2 : audible même sur un petit haut-parleur grâce aux harmoniques du timbre
  function padNotes(ch) { var r = lift(ch.pc, 53); return ch.iv.map(function (i) { return r + i; }); }
  function arpTone(ch, n) {                                                       // 1 fondamentale, 2 tierce, 3 quinte, 4 octave, 5 tierce haute, 6 quinte haute
    var r = lift(ch.pc, 60), tones = [r, r + ch.iv[1], r + ch.iv[2], r + 12, r + 12 + ch.iv[1], r + 12 + ch.iv[2]];
    return tones[n - 1];
  }
  function powerChord(ch) { var r = lift(ch.pc, 40); return [r, r + 7, r + 12]; }
  function openChord(ch) { var r = lift(ch.pc, 48); return ch.iv.slice(0, 3).map(function (i) { return r + i; }).concat([r + 12]); }

  // ------------------------------------------------------------------ motifs (16 pas par mesure)
  /* batterie : une chaîne de 16 caractères par pièce ; X accent, x fort, o moyen, g fantôme, . rien */
  var HIT = { X: 1, x: 0.75, o: 0.5, g: 0.28 };
  var DRUMS = {
    house_sparse: { hat: 'o...g...o...g...', ohat: '' },
    house_build:  { kick: 'o...o...o...o...', hat: '.g.g.g.g.g.g.g.g', snare: '............g.og' },
    house_groove: { kick: 'X...X...X...X...', clap: '....x.......x...', ohat: '..x...x...x...x.', hat: '.g.g.g.g.g.g.g.g' },
    house_full:   { kick: 'X...X...X...X...', clap: '....X.......X...', snare: '....o.......o...', ohat: '..x...x...x...x.', hat: 'gogogogogogogogo' },
    house_break:  { clap: '....o.......o...', hat: '.g.g.g.g.g.g.g.g' },
    house_roll:   { snare: 'gggoooxxxxxxXXXX', kick: '................' },
    ballad_in:    { rim: '........g.......', hat: 'o...o...o...o...' },
    rock_half:    { kick: 'X.......X.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
    rock_full:    { kick: 'X.......X.x.x...', snare: '....X.......X...', ohat: 'x.x.x.x.x.x.x.x.' },
    ballad:       { kick: 'X.......X.......', rim: '....x.......x...', hat: 'o...o...o...o...' },
    pop_build:    { kick: 'o.......o.......', hat: 'o.o.o.o.o.o.o.o.', snare: '............gogx' },
    pop_verse:    { kick: 'X.....x.X.......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
    pop_chorus:   { kick: 'X.....x.X.....x.', snare: '....X.......X..x', clap: '....x.......x...', ohat: 'x.x.x.x.x.x.x.x.' },
    pop_half:     { kick: 'X.......X.......', snare: '....X.......X...', hat: 'o...o...o...o...' },
    pop_end:      { kick: 'X...............', snare: '', hat: '' }
  };
  /* basse : r fondamentale, o octave, f quinte, 3 tierce ; - tient la note, . silence ; la durée d'une note = pas jusqu'à la suivante ou au silence */
  var BASS = {
    sub:      { p: 'r---------------', gate: 0.98 },
    pulse8:   { p: 'r-r-r-o-r-r-r-o-', gate: 0.7 },
    drive:    { p: 'r--r--r-r--r--o-', gate: 0.75 },
    roots:    { p: 'r-------r-r-r---', gate: 0.85 },
    eighths:  { p: 'r-r-r-r-r-r-r-o-', gate: 0.7 },
    punk8:    { p: 'r-r-r-r-r-r-r-r-', gate: 0.65 },
    bounce:   { p: 'r-r-o-r-r-r-o-r-', gate: 0.7 },
    held:     { p: 'r-------f-------', gate: 0.95 }
  };
  /* accords (claviers) : c = un accord ; - tient ; . silence */
  var KEYS = {
    pad:    { p: 'c---------------', kind: 'pad', gate: 0.99 },
    stab:   { p: 'c-.c-.c-..c-....', kind: 'stab', gate: 1 },
    epcomp: { p: 'c-----c---c-----', kind: 'ep', gate: 1 },
    epfull: { p: 'c-----c-c-c-----', kind: 'ep', gate: 1 },
    off8:   { p: '..c-..c-..c-..c-', kind: 'ep', gate: 1 },
    eighths:{ p: 'c-c-c-c-c-c-c-c-', kind: 'ep', gate: 0.8 },
    long:   { p: 'c---------------', kind: 'ep', gate: 0.99 }
  };
  /* guitares : un chiffre = une note d'arpège (arpTone) ; D / U = coup de médiator vers le bas / le haut sur l'accord ; - tient ; . silence */
  var GUITARS = {
    arp8:    { p: '1-3-5-4-5-3-5-4-', kind: 'pluck', gate: 0.8 },
    arp16:   { p: '1345435413454354', kind: 'pluck', gate: 0.9 },
    cleanarp:{ p: '1-3-2-3-1-3-2-3-', kind: 'pluck', gate: 0.9 },
    strum8:  { p: 'D-D-D-D-D-D-D-D-', kind: 'strum', gate: 0.5 },
    strumopen:{ p: 'D-D-U-D-D-D-U-D-', kind: 'strum', gate: 0.9 },
    power:   { p: 'D---D-U---U-D-U-', kind: 'strum', gate: 0.85 },
    ring:    { p: 'D---------------', kind: 'strum', gate: 0.99 }
  };
  /* voix tenues : une note de l'accord (tierce ou quinte) tenue toute la mesure */
  var VOX = { ahh: { kind: 'ahh', pick: 2 }, ooh: { kind: 'ooh', pick: 4 } };       // pick : indice dans [fondamentale, tierce, quinte, fondamentale+12, tierce+12, quinte+12]

  // ------------------------------------------------------------------ mélodies [mesure, pas, durée en pas, note MIDI]
  var HOOKS = {
    neon: {
      lead: [[0, 0, 8, 72], [0, 8, 4, 69], [0, 12, 4, 72], [1, 0, 12, 76], [1, 12, 4, 74], [2, 0, 8, 74], [2, 8, 4, 71], [2, 12, 4, 74], [3, 0, 12, 72], [3, 12, 4, 69]],
      harm: [[0, 0, 8, 69], [0, 8, 8, 65], [1, 0, 12, 67], [1, 12, 4, 71], [2, 0, 8, 71], [2, 8, 8, 67], [3, 0, 16, 64]]
    },
    gravity: {
      lead: [[0, 0, 8, 76], [0, 8, 4, 74], [0, 12, 4, 72], [1, 0, 12, 74], [1, 12, 4, 71], [2, 0, 8, 69], [2, 8, 8, 74], [3, 0, 12, 71], [3, 12, 4, 76]],
      harm: [[0, 0, 8, 72], [0, 8, 8, 67], [1, 0, 12, 71], [1, 12, 4, 67], [2, 0, 8, 66], [2, 8, 8, 69], [3, 0, 16, 67]]
    },
    hearts: {
      lead: [[0, 0, 4, 76], [0, 4, 4, 76], [0, 8, 4, 74], [0, 12, 4, 72], [1, 0, 8, 71], [1, 8, 8, 74], [2, 0, 4, 69], [2, 4, 4, 69], [2, 8, 4, 71], [2, 12, 4, 74], [3, 0, 12, 76], [3, 12, 4, 74]],
      harm: [[0, 0, 8, 72], [0, 8, 8, 67], [1, 0, 8, 67], [1, 8, 8, 71], [2, 0, 8, 66], [2, 8, 8, 69], [3, 0, 12, 71], [3, 12, 4, 67]]
    }
  };
  /* le solo de GRAVITY : 8 mesures sur Em C G D Em C G D -- les quatre premières posent la phrase, les quatre suivantes lui répondent plus haut (notes de l'accord ou de la gamme de mi mineur) */
  var SOLO = [[0, 0, 4, 71], [0, 4, 4, 76], [0, 8, 6, 79], [0, 14, 2, 76], [1, 0, 4, 76], [1, 4, 4, 72], [1, 8, 8, 79], [2, 0, 6, 74], [2, 6, 2, 71], [2, 8, 4, 74], [2, 12, 4, 71], [3, 0, 8, 69], [3, 8, 4, 74], [3, 12, 4, 78],
              [4, 0, 4, 83], [4, 4, 4, 79], [4, 8, 4, 76], [4, 12, 4, 79], [5, 0, 4, 76], [5, 4, 4, 79], [5, 8, 8, 79], [6, 0, 6, 83], [6, 6, 2, 79], [6, 8, 4, 74], [6, 12, 4, 79], [7, 0, 8, 78], [7, 8, 4, 81], [7, 12, 4, 78]];
  var HOOK_BARS = 4;                                          // les mélodies de refrain (HOOKS) font 4 mesures : elles se répètent sur les 8 mesures d'un refrain

  // ------------------------------------------------------------------ arrangement : une entrée par morceau, une par section (même ordre que le simulateur)
  /* Chaque section dure 8 mesures (voir demo-engine.js : l'annonce vocale part 3 mesures avant la fin, donc à la mesure 6). Trois outils pour les écrire sans les recopier huit fois :
       rep(['Am', 'F'], 4)   la phrase répétée : Am F Am F Am F Am F          hold('sub', 4)        la même valeur pendant 4 mesures      ramp(0.55, 0.85, 8)   une énergie qui monte (ou descend) mesure après mesure */
  var BARS = 8;
  function rep(list, times) { var out = []; for (var i = 0; i < times; i++) { out = out.concat(list); } return out; }
  function hold(value, bars) { var out = []; for (var i = 0; i < bars; i++) { out.push(value); } return out; }
  function ramp(from, to, bars) { var out = []; for (var i = 0; i < bars; i++) { out.push(Math.round((from + (to - from) * i / (bars - 1)) * 100) / 100); } return out; }
  /* mix : l'équilibre des pistes propre à chaque morceau (multiplie les vélocités), réglé par mesure du niveau de chaque piste (web_demo/audio_render.mjs --dry --stems) : le but est le même niveau de piste d'un morceau à l'autre. */
  /* Un champ est une chaîne (la même pour toutes les mesures de la section) ou un tableau (une valeur par mesure) ; null = rien ; « a+b » superpose deux motifs.
     crash : true = un crash sur la première mesure, ou la liste des mesures qui en ont un ; fill : roulement de caisse claire sur les deux derniers temps de la dernière mesure ;
     harm : l'harmonie du refrain (true, false ou une valeur par mesure) ; hook : la mélodie du refrain, reprise toutes les 4 mesures. */
  var ARR = {
    'NEON SKYLINE': {
      style: { kick: 'house', bass: 'saw', keys: 'saw', gtr: 'synth', vox: 'airy' },
      mix: { drums: 0.84, bass: 0.95, keys: 0.83, guitars: 1.3, vox: 0.81 },
      sections: [
        // INTRO : deux mesures de nappe, d'arpège et de charleston seuls, puis la grosse caisse et la basse entrent (mesure 3) et l'énergie monte jusqu'au couplet
        { chords: rep(['Am', 'F'], 4), energy: ramp(0.55, 0.85, BARS), drums: hold('house_sparse', 2).concat(hold('house_build', 6)), bass: hold(null, 2).concat(hold('sub', 6)), keys: 'pad', gtr: 'arp8' },
        { chords: rep(['Am', 'F', 'C', 'G'], 2), energy: hold(0.85, 4).concat(hold(0.9, 4)), drums: 'house_groove', fill: true, bass: 'pulse8', keys: 'pad', gtr: 'arp8', vox: rep([null, null, 'ooh', 'ooh'], 2) },
        { chords: rep(['F', 'C', 'G', 'Am'], 2), energy: 1, crash: [0, 4], drums: 'house_full', fill: true, bass: 'drive', keys: 'pad+stab', gtr: 'arp16', hook: 'neon' },
        // BRIDGE : le break (claps et charleston), la grosse caisse revient, puis le roulement de la dernière mesure
        { chords: rep(['Dm', 'E'], 4), energy: ramp(0.75, 0.95, BARS), drums: hold('house_break', 4).concat(hold('house_build', 3), ['house_roll']), bass: 'sub', keys: 'pad', vox: 'ahh' },
        { chords: rep(['F', 'C', 'G', 'Am'], 2), energy: 1, crash: [0, 4], drums: 'house_full', bass: 'drive', keys: 'pad+stab', gtr: 'arp16', hook: 'neon', harm: true, ending: true }
      ]
    },
    'GRAVITY': {
      style: { kick: 'deep', bass: 'round', keys: 'ep', gtr: 'clean', vox: 'warm' },
      mix: { drums: 0.88, bass: 0.67, keys: 0.4, guitars: 0.82, vox: 1.52 },
      sections: [
        { chords: rep(['Em', 'C'], 4), energy: ramp(0.6, 0.8, BARS), drums: hold(null, 2).concat(hold('ballad_in', 6)), bass: hold(null, 2).concat(hold('held', 6)), keys: 'long', gtr: 'cleanarp' },
        { chords: rep(['Em', 'C', 'G', 'D'], 2), energy: hold(0.85, 4).concat(hold(0.9, 4)), drums: 'rock_half', fill: true, bass: 'roots', keys: 'epcomp', gtr: 'cleanarp' },
        { chords: rep(['C', 'G', 'D', 'Em'], 2), energy: 1, crash: [0, 4], drums: 'rock_full', fill: true, bass: 'eighths', keys: 'pad+epfull', gtr: 'power', hook: 'gravity' },
        { chords: rep(['Em', 'C', 'G', 'D'], 2), energy: 1, drums: 'rock_full', fill: true, bass: 'eighths', keys: 'pad', solo: true },
        // OUTRO : la batterie légère jusqu'au bout, la basse tient puis ne joue plus que la fondamentale, l'énergie retombe
        { chords: rep(['C', 'Em'], 4), energy: ramp(0.8, 0.45, BARS), drums: 'ballad', bass: hold('held', 6).concat(hold('sub', 2)), keys: 'long', gtr: 'cleanarp', vox: 'ooh', ending: true }
      ]
    },
    'PAPER HEARTS': {
      style: { kick: 'pop', bass: 'pick', keys: 'piano', gtr: 'strum', vox: 'bright' },
      mix: { drums: 0.91, bass: 0.96, keys: 0.51, guitars: 0.75, vox: 0.89 },
      sections: [
        { chords: rep(['G', 'D'], 4), energy: ramp(0.65, 0.85, BARS), drums: hold(null, 2).concat(hold('pop_build', 6)), bass: hold(null, 2).concat(hold('punk8', 6)), gtr: 'strum8' },
        { chords: rep(['G', 'D', 'Em', 'C'], 2), energy: hold(0.85, 4).concat(hold(0.9, 4)), drums: 'pop_verse', fill: true, bass: 'punk8', keys: 'off8', gtr: 'strum8' },
        { chords: rep(['Am', 'D'], 4), energy: ramp(0.8, 1, BARS), drums: hold('house_break', 4).concat(hold('house_build', 3), ['house_roll']), bass: 'sub', keys: 'long', gtr: null, vox: 'ahh' },
        { chords: rep(['C', 'G', 'D', 'Em'], 2), energy: 1, crash: [0, 4], drums: 'pop_chorus', fill: true, bass: 'bounce', keys: 'eighths', gtr: 'strumopen', hook: 'hearts' },
        // OUTRO : le refrain une dernière fois à pleine énergie, puis les quatre dernières mesures s'éteignent jusqu'au coup de grosse caisse final
        { chords: rep(['C', 'G', 'D', 'G'], 2), energy: hold(1, 6).concat([0.9, 0.8]), crash: true, drums: hold('pop_chorus', 6).concat(['pop_half', 'pop_end']), bass: hold('bounce', 6).concat(['punk8', 'sub']), keys: hold('eighths', 6).concat(['long', 'long']), gtr: hold('strumopen', 6).concat(['strum8', 'ring']), hook: 'hearts', harm: true, ending: true }
      ]
    }
  };

  // ------------------------------------------------------------------ outils de construction
  function perBar(field, index, fallback) {
    if (field === undefined) { return fallback === undefined ? null : fallback; }
    return Array.isArray(field) ? (field[index] === undefined ? null : field[index]) : field;
  }
  function jitter(si, bar, step, salt) {                          // variation de vélocité reproductible (±6 %) : la même note a toujours la même force
    var h = (si * 73856093) ^ (bar * 19349663) ^ (step * 83492791) ^ (salt * 2654435761);
    h = ((h >>> 0) % 1000) / 1000;
    return 0.94 + 0.12 * h;
  }
  /* lit une chaîne de motif : [{step, len, sym}] -- len en pas, jusqu'au prochain départ ou silence */
  function notesOf(pattern, starts) {
    var out = [], current = null;
    for (var i = 0; i < pattern.length; i++) {
      var c = pattern.charAt(i);
      if (starts.indexOf(c) >= 0) { current = { step: i, len: 1, sym: c }; out.push(current); }
      else if (c === '-' && current) { current.len += 1; }
      else { current = null; }
    }
    return out;
  }

  // ------------------------------------------------------------------ une mesure de musique
  var cache = {};
  function sectionIndexAt(si, localBeat) {
    var secs = SONGS[si].sections;
    for (var i = 0; i < secs.length; i++) { if (localBeat >= secs[i][1] && localBeat < secs[i][1] + secs[i][2]) { return i; } }
    return secs.length - 1;
  }
  function barEvents(si, bar) {
    var key = si + ':' + bar;
    if (cache[key]) { return cache[key]; }
    var song = SONGS[si], arr = ARR[song.name], out = [], base = song.start + bar * SIGNATURE;
    var local = bar * SIGNATURE, sIndex = sectionIndexAt(si, local), sec = arr.sections[sIndex], secBars = song.sections[sIndex][2] / SIGNATURE;
    var b = bar - song.sections[sIndex][1] / SIGNATURE;                              // numéro de la mesure dans sa section
    var last = b === secBars - 1, style = arr.style;
    var chord = parseChord(sec.chords[b]), energy = perBar(sec.energy, b, 1), sectionLast = sIndex === arr.sections.length - 1;

    function add(track, kind, step, len, midi, vel, s, extraBeat) {
      var beat = base + step * STEP + (extraBeat || 0), end = Math.min(base + SIGNATURE, beat + len * STEP);
      if (end - beat < 0.02) { end = beat + 0.02; }
      var ev = { beat: beat, dur: end - beat, track: track, kind: kind, vel: Math.max(0, Math.min(1, vel)), s: s, level: (arr.mix && arr.mix[track]) || 1 };
      if (midi !== undefined && midi !== null) { ev.midi = midi; }
      out.push(ev);
    }

    // ---- batterie
    var dname = perBar(sec.drums, b);
    if (dname) {
      var pat = DRUMS[dname], fill = sec.fill && last && !sectionLast;
      var pieces = [['kick', 'kick'], ['snare', 'snare'], ['clap', 'clap'], ['rim', 'rim'], ['hat', 'hat'], ['ohat', 'ohat']];
      pieces.forEach(function (pair, pi) {
        var str = pat[pair[0]];
        if (!str) { return; }
        for (var i = 0; i < 16; i++) {
          var ch = str.charAt(i);
          if (!HIT[ch]) { continue; }
          if (fill && i >= 12) { continue; }                                          // le roulement de caisse claire remplace tout le reste des deux derniers temps
          add('drums', pair[1], i, 1, null, HIT[ch] * energy * jitter(si, bar, i, pi + 1), style.kick);
        }
      });
      if (fill) { [0.4, 0.55, 0.75, 0.95].forEach(function (v, k) { add('drums', 'snare', 12 + k, 1, null, v * energy, style.kick); }); }
      if (Array.isArray(sec.crash) ? sec.crash.indexOf(b) >= 0 : (sec.crash && b === 0)) { add('drums', 'crash', 0, 12, null, 0.8 * energy, style.kick); }
      if (dname === 'pop_end') { add('drums', 'crash', 0, 12, null, 0.8, style.kick); }
    }

    // ---- basse
    var bname = perBar(sec.bass, b);
    if (bname) {
      var bp = BASS[bname], root = bassRoot(chord);
      notesOf(bp.p, 'rof3').forEach(function (n) {
        var midi = n.sym === 'o' ? root + 12 : n.sym === 'f' ? root + 7 : n.sym === '3' ? root + chord.iv[1] : root;
        add('bass', 'bass', n.step, n.len * bp.gate, midi, (n.step === 0 ? 1 : 0.85) * energy * jitter(si, bar, n.step, 7), style.bass);
      });
    }

    // ---- claviers (plusieurs motifs superposés avec « + »)
    var kname = perBar(sec.keys, b);
    if (kname) {
      kname.split('+').forEach(function (one, ki) {
        var kp = KEYS[one], notes = padNotes(chord);
        notesOf(kp.p, 'c').forEach(function (n) {
          notes.forEach(function (midi, ni) {
            add('keys', kp.kind, n.step, n.len * kp.gate, midi, (kp.kind === 'pad' ? 0.8 : 0.9) * energy * jitter(si, bar, n.step, 11 + ni + ki), style.keys, kp.kind === 'ep' ? ni * 0.006 : 0);
          });
        });
      });
    }

    // ---- guitares
    var gname = perBar(sec.gtr, b);
    if (gname) {
      var gp = GUITARS[gname];
      if (gp.kind === 'pluck') {
        notesOf(gp.p, '123456').forEach(function (n) { add('guitars', 'pluck', n.step, n.len * gp.gate, arpTone(chord, Number(n.sym)), 0.85 * energy * jitter(si, bar, n.step, 13), style.gtr); });
      } else {
        var shape = gname === 'power' ? powerChord(chord) : openChord(chord);
        notesOf(gp.p, 'DU').forEach(function (n) {
          (n.sym === 'D' ? shape : shape.slice().reverse()).forEach(function (midi, si2) {
            add('guitars', 'strum', n.step, n.len * gp.gate, midi, (n.sym === 'D' ? 0.9 : 0.6) * energy * jitter(si, bar, n.step, 17 + si2), style.gtr + (gname === 'power' ? '-drive' : ''), si2 * 0.012);
          });
        });
      }
    }

    // ---- voix : mélodie du refrain (et son harmonie), ou note tenue
    var voxName = perBar(sec.vox, b);
    if (voxName) {
      var vp = VOX[voxName], third = padNotes(chord).concat(padNotes(chord).map(function (n) { return n + 12; }));
      add('vox', vp.kind, 0, 16 * 0.99, third[vp.pick], 0.7 * energy, style.vox);
    }
    if (sec.hook) {
      var hook = HOOKS[sec.hook];
      var hb = b % HOOK_BARS;                                                       // la mélodie fait 4 mesures : elle revient à la mesure 5 d'un refrain de 8
      hook.lead.forEach(function (n) { if (n[0] === hb) { add('vox', 'ahh', n[1], n[2] * 0.94, n[3], 0.95 * energy, style.vox); } });
      if (perBar(sec.harm, b)) { hook.harm.forEach(function (n) { if (n[0] === hb) { add('vox', 'ooh', n[1], n[2] * 0.94, n[3], 0.6 * energy, style.vox); } }); }
    }
    if (sec.solo) {
      SOLO.forEach(function (n) { if (n[0] === b) { add('guitars', 'lead', n[1], n[2] * 0.97, n[3], 0.95 * energy, style.gtr); } });
    }
    out.sort(function (a, c) { return a.beat - c.beat; });
    cache[key] = out;
    return out;
  }

  // ------------------------------------------------------------------ interrogation par position
  function songIndexAt(beat) {
    for (var i = SONGS.length - 1; i >= 0; i--) { if (beat >= SONGS[i].start) { return i; } }
    return 0;
  }
  /* les évènements qui COMMENCENT dans [a, b) (temps absolus) */
  function eventsBetween(a, b) {
    var out = [];
    if (!(b > a)) { return out; }
    var from = Math.max(0, a), to = Math.min(END_BEAT, b);
    for (var bar = Math.floor(from / SIGNATURE); bar * SIGNATURE < to; bar++) {
      var si = songIndexAt(bar * SIGNATURE);
      var inSong = bar - SONGS[si].start / SIGNATURE;
      if (inSong < 0 || inSong >= Core.SONG_BEATS / SIGNATURE) { continue; }
      var list = barEvents(si, inSong);
      for (var i = 0; i < list.length; i++) { if (list[i].beat >= from && list[i].beat < to) { out.push(list[i]); } }
    }
    return out;
  }
  /* les notes déjà commencées avant `beat` et encore tenues à `beat` (pour repartir au milieu d'une mesure après un saut) */
  function sustainedAt(beat) {
    var out = [];
    if (beat < 0 || beat >= END_BEAT) { return out; }
    var bar = Math.floor(beat / SIGNATURE), si = songIndexAt(bar * SIGNATURE), inSong = bar - SONGS[si].start / SIGNATURE;
    if (inSong < 0 || inSong >= Core.SONG_BEATS / SIGNATURE) { return out; }
    var list = barEvents(si, inSong);
    for (var i = 0; i < list.length; i++) { if (list[i].beat < beat - 1e-9 && list[i].beat + list[i].dur > beat + 0.05 && list[i].track !== 'drums') { out.push(list[i]); } }
    return out;
  }

  global.MarkerListDemoMusic = { eventsBetween: eventsBetween, sustainedAt: sustainedAt, barEvents: barEvents, ARR: ARR, DRUMS: DRUMS, TRACKS: ['drums', 'bass', 'keys', 'guitars', 'vox'] };
})(window);
