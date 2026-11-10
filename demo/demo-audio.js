/* demo-audio.js -- le SON de la démo web de MarkerList : joue les trois morceaux (partition : demo-music.js) en suivant la tête de lecture du simulateur (demo-engine.js).
 *
 * Ce que ce fichier fait, dans l'ordre :
 *  1. des instruments synthétisés avec l'API Web Audio (kick, caisse claire, charleston, basse, nappe, piano électrique, pizzicato, guitare, voix...) -- aucun fichier audio pour la musique ;
 *  2. une console : une piste par instrument (CLICK, DRUMS, BASS, KEYS, GUITARS, VOX) avec mute, solo et volume pris dans « Pistes Ableton », le volume principal, le métronome ;
 *  3. un programmateur : à chaque pas du simulateur il demande sa PRÉVISION du transport (Server.forecast : les tronçons que la tête de lecture va parcourir, boucles et cues compris), programme les notes des
 *     0,35 s à venir à l'heure exacte de l'horloge audio, et quand une action du visiteur change la prévision (STOP, saut, boucle posée, cue...), coupe en fondu ce qui n'a pas encore sonné au-delà du point
 *     de divergence et repart de la nouvelle prévision. Le retour au début d'une boucle tombe donc pile, sans à-coup, parce qu'il est prévu avant d'avoir lieu.
 *  4. les annonces vocales : le simulateur prévient (onVoice) quand l'application annoncerait une section ou une boucle ; le clip de l'application (demo-voice.js, tiré de tts_defaults/) part à l'instant audio
 *     qui correspond, aligné sur la musique, la musique baisse un peu pendant qu'il parle, et un STOP le coupe.
 *
 * Mise en route : MarkerListDemoAudio.enable() doit être appelée depuis un geste du visiteur (règle des navigateurs), elle crée le contexte audio ; tant qu'il ne tourne pas, rien ne sonne. Le son n'envoie rien
 * nulle part : tout est calculé dans l'onglet.
 *
 * Horloges : la simulation et l'audio ont chacune la leur. `offset` (secondes audio - secondes de simulation) est fixé à la synchronisation puis corrigé très lentement ; un écart brutal (onglet figé...)
 * déclenche une resynchronisation complète. Le son est volontairement en retard de START_DELAY (40 ms) sur l'image : c'est la marge qui permet de programmer la première note d'un saut avant qu'elle ne sonne.
 */
(function (global) {
  'use strict';
  var Core = global.MarkerListDemoCore, Music = global.MarkerListDemoMusic;
  if (!Core || !Music) { throw new Error('demo-audio.js : demo-engine.js et demo-music.js doivent être chargés avant'); }

  var LOOKAHEAD = 0.35;                     // s : horizon de la prévision = musique programmée d'avance
  var START_DELAY = 0.04;                   // s : retard constant du son sur l'image
  var RESYNC = 0.05;                        // s : dérive tolérée entre les deux horloges avant resynchronisation
  var DIVERGENCE_BEATS = 0.06;              // temps : écart de position en dessous duquel deux prévisions sont « la même »
  var CANCEL_FADE = 0.03;                   // s : fondu de ce qui est coupé
  var TRACK_INDEX = { click: 0, drums: 1, bass: 2, keys: 3, guitars: 4, vox: 5 };
  var TRIM = [0.55, 1, 1, 1, 1, 1];         // niveaux relatifs de la console (réglés à l'écoute de la partition entière, voir tools/ ou web_demo/audio_render.mjs)
  var REVERB_SEND = [0, 0.05, 0, 0.3, 0.2, 0.36];
  var MASTER_TRIM = 0.9;
  var VOICE_LEVEL = 1.4;                    // niveau de la voix des annonces avant le compresseur (réglé par mesure, avec VOICE_DUCK : web_demo/audio_voice_check.mjs --sweep)
  var VOICE_DUCK = 0.35;                    // gain de la musique pendant que la voix parle (-9 dB ; 1 = pas d'atténuation) : sans cela la voix se noie dans le refrain d'un petit haut-parleur, le compresseur
                                            // de sortie rattrapant tout niveau de voix supplémentaire (+6 dB de voix ne donnent que +1,4 dB à l'oreille)
  var VOICE_FADE = 0.03;                    // s : fondu d'une annonce coupée par un STOP
  var VOICE_PHRASES = { looping: 'loop', final_loop_fixed: 'one more time', final_loop_infinite: 'last time' };       // tts_engine.DEFAULT_LOOP_PHRASE / DEFAULT_ONE_MORE_TIME_PHRASE / DEFAULT_FINAL_LOOP_PHRASE (casse ignorée)

  // ------------------------------------------------------------------ outils
  function mtof(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  /* courbe d'un fader d'Ableton : 0,85 = 0 dB */
  function faderGain(v) { return Math.pow(clamp01(Number(v)) / 0.85, 2.2); }
  function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function tempoAt(beat) { return Core.songAt(beat).tempo; }
  function posAt(runs, t) {                 // position (en temps) à l'instant de simulation t, ou null si la lecture est arrêtée
    for (var i = runs.length - 1; i >= 0; i--) {
      var r = runs[i];
      if (t >= r.t0 - 1e-9 && (r.t1 === null || t < r.t1 - 1e-9)) { return Core.advance(r.b0, t - r.t0); }
    }
    return null;
  }

  // ------------------------------------------------------------------ le graphe audio
  function makeImpulse(ctx) {               // réverbération : bruit stéréo qui s'éteint (reproductible : graine fixe)
    var sr = ctx.sampleRate, len = Math.floor(sr * 1.5), buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var rand = lcg(1234 + c * 77), d = buf.getChannelData(c), low = 0;
      for (var i = 0; i < len; i++) {
        var x = i / len;
        low += ((rand() * 2 - 1) - low) * (0.18 + 0.5 * (1 - x));          // plus sombre avec le temps
        d[i] = low * Math.pow(1 - x, 2.6) * 2.2;
      }
    }
    return buf;
  }
  function makeNoise(ctx) {
    var sr = ctx.sampleRate, buf = ctx.createBuffer(1, sr * 2, sr), d = buf.getChannelData(0), rand = lcg(99);
    for (var i = 0; i < d.length; i++) { d[i] = rand() * 2 - 1; }
    return buf;
  }
  function curve(k) {                       // saturation douce (tanh) de force k
    var n = 1024, c = new Float32Array(n), norm = Math.tanh(k);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }

  /* Une « époque » : des gains qui précèdent les bus de pistes. Tout ce qui est programmé passe par l'époque courante ; couper une époque en fondu fait taire d'un coup tout ce qu'elle a programmé et pas encore joué. */
  function makeEpoch(G) {
    var e = { gains: [] };
    for (var i = 0; i < G.buses.length; i++) { var g = G.ctx.createGain(); g.connect(G.buses[i]); e.gains.push(g); }
    return e;
  }

  function buildGraph(ctx) {
    var G = { ctx: ctx, buses: [], epoch: null, noiseCursor: 1, voices: [], voiceBuffers: {} };
    G.noise = makeNoise(ctx);
    G.curveSoft = curve(2.4); G.curveDrive = curve(14);
    G.mix = ctx.createGain();
    G.comp = ctx.createDynamicsCompressor();
    G.comp.threshold.value = -16; G.comp.knee.value = 10; G.comp.ratio.value = 3; G.comp.attack.value = 0.012; G.comp.release.value = 0.2;
    G.limiter = ctx.createDynamicsCompressor();
    G.limiter.threshold.value = -4; G.limiter.knee.value = 0; G.limiter.ratio.value = 20; G.limiter.attack.value = 0.001; G.limiter.release.value = 0.08;
    G.out = ctx.createGain(); G.out.gain.value = MASTER_TRIM * faderGain(0.85);
    G.air = ctx.createBiquadFilter(); G.air.type = 'highshelf'; G.air.frequency.value = 3200; G.air.gain.value = 4;                       // un peu de présence : sans cela le tout sonne étouffé sur un petit haut-parleur
    G.duck = ctx.createGain(); G.duckAmount = VOICE_DUCK; G.duckEnd = 0; G.duckRelease = null;                                            // la musique baisse pendant que la voix parle (voir duckFor)
    G.mix.connect(G.duck); G.duck.connect(G.air); G.air.connect(G.comp); G.comp.connect(G.limiter); G.limiter.connect(G.out); G.out.connect(ctx.destination);
    G.analyser = ctx.createAnalyser(); G.analyser.fftSize = 2048; G.out.connect(G.analyser);
    G.voice = ctx.createGain(); G.voice.gain.value = VOICE_LEVEL; G.voice.connect(G.comp);        // la voix des annonces : hors des pistes (ni mute, ni solo, ni volume de piste), mais sous le volume principal, comme tout ce qui passe par Ableton
    G.verbIn = ctx.createGain(); G.verb = ctx.createConvolver(); G.verb.buffer = makeImpulse(ctx); G.verbOut = ctx.createGain(); G.verbOut.gain.value = 0.9;
    G.verbIn.connect(G.verb); G.verb.connect(G.verbOut); G.verbOut.connect(G.mix);
    G.echoIn = ctx.createGain(); G.echo = ctx.createDelay(1); G.echo.delayTime.value = 0.3125;       // croche à 96 bpm : l'écho du solo de GRAVITY
    var feedback = ctx.createGain(); feedback.gain.value = 0.34;
    var echoTone = ctx.createBiquadFilter(); echoTone.type = 'lowpass'; echoTone.frequency.value = 2400;
    var echoOut = ctx.createGain(); echoOut.gain.value = 0.55;
    G.echoIn.connect(G.echo); G.echo.connect(echoTone); echoTone.connect(feedback); feedback.connect(G.echo); echoTone.connect(echoOut); echoOut.connect(G.mix);
    G.track = [];
    for (var i = 0; i < 6; i++) {
      var bus = ctx.createGain(), send = ctx.createGain();
      send.gain.value = REVERB_SEND[i];
      if (i === 0) { G.clickGate = ctx.createGain(); bus.connect(G.clickGate); G.clickGate.connect(G.mix); } else { bus.connect(G.mix); }
      bus.connect(send); send.connect(G.verbIn);
      G.buses.push(bus); G.track.push(bus);
    }
    G.epoch = makeEpoch(G);
    return G;
  }

  // ------------------------------------------------------------------ les instruments
  function outOf(G, ev) { return G.epoch.gains[TRACK_INDEX[ev.track]]; }
  function noiseSrc(G, t, dur) {
    var s = G.ctx.createBufferSource();
    G.noiseCursor = (G.noiseCursor * 48271) % 2147483647;
    s.buffer = G.noise; s.loop = true;
    s.start(t, (G.noiseCursor % 1000) / 1000 * 1.5);
    s.stop(t + dur);
    return s;
  }
  function filter(G, type, freq, q) { var f = G.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q !== undefined) { f.Q.value = q; } return f; }
  /* enveloppe : attaque a, descente d vers le niveau s, tenue jusqu'à `hold`, extinction r. Renvoie l'instant où le son est éteint. */
  function adsr(param, t, peak, a, d, s, hold, r) {
    hold = Math.max(hold, a + d + 0.002);
    var sus = Math.max(peak * s, 0.0001);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(sus, t + a + d);
    param.setValueAtTime(sus, t + hold);
    param.exponentialRampToValueAtTime(0.0001, t + hold + r);
    return t + hold + r;
  }
  function osc(G, type, freq, t, end, detune) {
    var o = G.ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    if (detune) { o.detune.value = detune; }
    o.start(t); o.stop(end);
    return o;
  }
  function perc(G, out, t, peak, attack, length) {     // gain percussif : montée courte puis chute exponentielle
    var g = G.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    g.connect(out);
    return g;
  }

  var V = {};
  V.kick = function (G, t, dur, ev) {
    var deep = ev.s === 'deep', house = ev.s === 'house', len = deep ? 0.46 : house ? 0.3 : 0.36;
    var o = G.ctx.createOscillator(), sh = G.ctx.createWaveShaper(), g = perc(G, outOf(G, ev), t, 0.9 * ev.vel, 0.003, len);
    o.type = 'sine'; sh.curve = G.curveSoft;
    o.frequency.setValueAtTime(deep ? 125 : house ? 200 : 165, t);
    o.frequency.exponentialRampToValueAtTime(deep ? 54 : 58, t + (deep ? 0.11 : 0.07));
    o.connect(sh); sh.connect(g); o.start(t); o.stop(t + len + 0.02);
    var n = noiseSrc(G, t, 0.02), hp = filter(G, 'highpass', 2200), cg = perc(G, outOf(G, ev), t, 0.18 * ev.vel, 0.0005, 0.014);     // le claquement de la peau
    n.connect(hp); hp.connect(cg);
  };
  V.snare = function (G, t, dur, ev) {
    var n = noiseSrc(G, t, 0.25), bp = filter(G, 'bandpass', 2100, 0.7), hp = filter(G, 'highpass', 800), g = perc(G, outOf(G, ev), t, 0.55 * ev.vel, 0.001, 0.19);
    n.connect(bp); bp.connect(hp); hp.connect(g);
    var o = G.ctx.createOscillator(), og = perc(G, outOf(G, ev), t, 0.3 * ev.vel, 0.001, 0.11);
    o.type = 'triangle'; o.frequency.setValueAtTime(205, t); o.frequency.exponentialRampToValueAtTime(125, t + 0.06); o.connect(og); o.start(t); o.stop(t + 0.14);
  };
  V.clap = function (G, t, dur, ev) {
    var n = noiseSrc(G, t, 0.3), bp = filter(G, 'bandpass', 1500, 1.1), g = G.ctx.createGain(), p = 0.5 * ev.vel;
    var q = g.gain;
    q.setValueAtTime(0.0001, t);
    [0, 0.011, 0.022].forEach(function (d) { q.setValueAtTime(0.0001, t + d); q.linearRampToValueAtTime(p, t + d + 0.001); q.exponentialRampToValueAtTime(p * 0.18, t + d + 0.009); });
    q.linearRampToValueAtTime(p * 0.7, t + 0.034); q.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp); bp.connect(g); g.connect(outOf(G, ev));
  };
  V.rim = function (G, t, dur, ev) {
    var o = G.ctx.createOscillator(), g = perc(G, outOf(G, ev), t, 0.32 * ev.vel, 0.0005, 0.045);
    o.type = 'sine'; o.frequency.setValueAtTime(1900, t); o.frequency.exponentialRampToValueAtTime(1150, t + 0.03); o.connect(g); o.start(t); o.stop(t + 0.06);
    var n = noiseSrc(G, t, 0.03), bp = filter(G, 'bandpass', 3200, 1), ng = perc(G, outOf(G, ev), t, 0.2 * ev.vel, 0.0005, 0.02);
    n.connect(bp); bp.connect(ng);
  };
  V.hat = function (G, t, dur, ev) {
    var n = noiseSrc(G, t, 0.09), hp = filter(G, 'highpass', 7500, 0.5), g = perc(G, outOf(G, ev), t, 0.3 * ev.vel, 0.001, 0.05);
    n.connect(hp); hp.connect(g);
  };
  V.ohat = function (G, t, dur, ev) {
    var len = ev.s === 'house' ? 0.2 : 0.15, n = noiseSrc(G, t, len + 0.05), hp = filter(G, 'highpass', 6800, 0.5), g = perc(G, outOf(G, ev), t, 0.26 * ev.vel, 0.001, len);
    n.connect(hp); hp.connect(g);
  };
  V.crash = function (G, t, dur, ev) {
    var n = noiseSrc(G, t, 2.2), hp = filter(G, 'highpass', 4200, 0.4), g = perc(G, outOf(G, ev), t, 0.18 * ev.vel, 0.002, 1.8);
    n.connect(hp); hp.connect(g);
  };

  V.bass = function (G, t, dur, ev) {
    var f = mtof(ev.midi), round = ev.s === 'round', pick = ev.s === 'pick', end = t + dur + 0.2;
    var o1 = osc(G, round ? 'triangle' : 'sawtooth', f, t, end), o2 = osc(G, 'sine', f, t, end);
    var lp = filter(G, 'lowpass', round ? 900 : pick ? 2800 : 2300, round ? 1 : 3), g = G.ctx.createGain(), sub = G.ctx.createGain();
    if (round) { var o3 = osc(G, 'sawtooth', f, t, end), body = G.ctx.createGain(); body.gain.value = 0.6; o3.connect(body); body.connect(lp); }          // quelques harmoniques : sans elles la basse ronde disparaît sur un petit haut-parleur
    lp.frequency.setValueAtTime(round ? 900 : pick ? 2800 : 2300, t); lp.frequency.exponentialRampToValueAtTime(round ? 520 : 380, t + 0.14);
    sub.gain.value = 0.5;
    o1.connect(lp); lp.connect(g); o2.connect(sub); sub.connect(g);
    adsr(g.gain, t, 0.16 * ev.vel, 0.004, 0.12, 0.78, dur, 0.07);
    g.connect(outOf(G, ev));
  };
  V.pad = function (G, t, dur, ev) {
    var f = mtof(ev.midi), end = t + dur + 0.6;
    var a = osc(G, 'sawtooth', f, t, end, -7), b = osc(G, 'sawtooth', f, t, end, 7), lp = filter(G, 'lowpass', 600, 0.7), g = G.ctx.createGain();
    lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1500, t + Math.min(dur, 1.2));
    a.connect(lp); b.connect(lp); lp.connect(g);
    adsr(g.gain, t, 0.085 * ev.vel, 0.22, 0.2, 1, dur, 0.5);
    g.connect(outOf(G, ev));
  };
  V.stab = function (G, t, dur, ev) {
    var f = mtof(ev.midi), len = Math.min(dur + 0.08, 0.5);
    var a = osc(G, 'sawtooth', f, t, t + len + 0.05, -9), b = osc(G, 'sawtooth', f, t, t + len + 0.05, 9), lp = filter(G, 'lowpass', 3200, 2), g = perc(G, outOf(G, ev), t, 0.11 * ev.vel, 0.002, len);
    lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(700, t + 0.2);
    a.connect(lp); b.connect(lp); lp.connect(g);
  };
  V.ep = function (G, t, dur, ev) {                         // piano électrique / piano : deux sinus en modulation de fréquence, la modulation retombe vite
    var f = mtof(ev.midi), piano = ev.s === 'piano', end = t + Math.max(dur, 0.1) + 0.3;
    var car = osc(G, 'sine', f, t, end), mod = osc(G, 'sine', f * (piano ? 2 : 1), t, end), mg = G.ctx.createGain(), g = G.ctx.createGain();
    var idx = (piano ? 2.1 : 1.5) * ev.vel * f * (piano ? 2 : 1);
    mg.gain.setValueAtTime(idx, t); mg.gain.exponentialRampToValueAtTime(Math.max(idx * 0.12, 1), t + (piano ? 0.35 : 0.6));
    mod.connect(mg); mg.connect(car.frequency); car.connect(g);
    var peak = 0.26 * ev.vel, fall = Math.min(dur, piano ? 1.0 : 1.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.004); g.gain.exponentialRampToValueAtTime(peak * (piano ? 0.3 : 0.4), t + fall);
    g.gain.setValueAtTime(peak * (piano ? 0.3 : 0.4), t + dur); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
    g.connect(outOf(G, ev));
  };
  V.pluck = function (G, t, dur, ev) {
    var f = mtof(ev.midi), synth = ev.s === 'synth', len = Math.min(dur + 0.05, synth ? 0.4 : 0.8), end = t + len + 0.06;
    var a = osc(G, synth ? 'sawtooth' : 'triangle', f, t, end), b = osc(G, synth ? 'square' : 'sawtooth', f, t, end, synth ? -6 : 4), bg = G.ctx.createGain();
    var lp = filter(G, 'lowpass', synth ? 5200 : 3200, synth ? 3 : 1), g = perc(G, outOf(G, ev), t, (synth ? 0.26 : 0.2) * ev.vel, 0.002, len);
    bg.gain.value = synth ? 0.5 : 0.35;
    lp.frequency.setValueAtTime(synth ? 5200 : 3200, t); lp.frequency.exponentialRampToValueAtTime(synth ? 1100 : 800, t + (synth ? 0.16 : 0.22));
    a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(g);
  };
  V.strum = function (G, t, dur, ev) {
    var f = mtof(ev.midi), drive = /drive/.test(ev.s), end = t + dur + 0.2;
    var a = osc(G, 'sawtooth', f, t, end, -5), b = osc(G, 'sawtooth', f, t, end, 5), lp = filter(G, 'lowpass', 2600, 0.7), g = G.ctx.createGain(), mix = G.ctx.createGain();
    lp.frequency.setValueAtTime(drive ? 3600 : 3000, t); lp.frequency.exponentialRampToValueAtTime(drive ? 1800 : 1500, t + 0.09);
    a.connect(mix); b.connect(mix);
    if (drive) { var sh = G.ctx.createWaveShaper(); sh.curve = G.curveDrive; mix.connect(sh); sh.connect(lp); } else { mix.connect(lp); }
    lp.connect(g);
    adsr(g.gain, t, (drive ? 0.07 : 0.08) * ev.vel, 0.003, 0.5, 0.55, dur, 0.1);
    g.connect(outOf(G, ev));
  };
  V.lead = function (G, t, dur, ev) {                       // solo de guitare : deux dents de scie saturées, vibrato qui s'installe, écho
    var f = mtof(ev.midi), end = t + dur + 0.4;
    var a = osc(G, 'sawtooth', f, t, end, -8), b = osc(G, 'sawtooth', f, t, end, 8), mix = G.ctx.createGain(), sh = G.ctx.createWaveShaper(), lp = filter(G, 'lowpass', 3400, 1), g = G.ctx.createGain();
    var lfo = osc(G, 'sine', 5.4, t, end), lg = G.ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(11, t + Math.min(0.35, dur)); lfo.connect(lg); lg.connect(a.detune); lg.connect(b.detune);
    sh.curve = G.curveDrive; a.connect(mix); b.connect(mix); mix.connect(sh); sh.connect(lp); lp.connect(g);
    adsr(g.gain, t, 0.15 * ev.vel, 0.012, 0.15, 0.85, dur, 0.2);
    g.connect(outOf(G, ev));
    var send = G.ctx.createGain(); send.gain.value = 0.4; g.connect(send); send.connect(G.echoIn);
  };
  var FORMANTS = { ahh: [[800, 1], [1200, 0.5], [2800, 0.2]], ooh: [[330, 1], [800, 0.28], [2500, 0.08]] };
  V.ahh = V.ooh = function (G, t, dur, ev) {                // voix : dents de scie filtrées par trois formants, vibrato qui s'installe
    var f = mtof(ev.midi), end = t + dur + 0.5, bright = ev.s === 'bright', warm = ev.s === 'warm';
    var a = osc(G, 'sawtooth', f, t, end, -6), b = osc(G, 'sawtooth', f, t, end, 6), src = G.ctx.createGain(), g = G.ctx.createGain();
    var lfo = osc(G, 'sine', warm ? 4.8 : 5.4, t, end), lg = G.ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(warm ? 11 : 8, t + Math.min(0.4, dur)); lfo.connect(lg); lg.connect(a.detune); lg.connect(b.detune);
    src.gain.value = 0.55; a.connect(src); b.connect(src);
    FORMANTS[ev.kind].forEach(function (fm) {
      var bp = filter(G, 'bandpass', fm[0] * (bright ? 1.08 : 1), 9), fg = G.ctx.createGain();
      fg.gain.value = fm[1] * 1.7; src.connect(bp); bp.connect(fg); fg.connect(g);
    });
    adsr(g.gain, t, 0.52 * ev.vel, 0.07, 0.1, 0.95, dur, 0.28);
    g.connect(outOf(G, ev));
  };
  V.click = function (G, t, dur, ev) {
    var accent = ev.vel > 0.9, o = G.ctx.createOscillator(), g = perc(G, outOf(G, ev), t, 0.5 * ev.vel, 0.0008, 0.04);
    o.type = 'sine'; o.frequency.value = accent ? 1900 : 1350; o.connect(g); o.start(t); o.stop(t + 0.06);
  };

  function playEvent(G, ev, t, durSec) {
    var voice = V[ev.kind];
    if (!voice) { return; }
    if (ev.level !== undefined && ev.level !== 1) { var scaled = Object.create(ev); scaled.vel = ev.vel * ev.level; ev = scaled; }          // équilibre propre au morceau (voir MIX dans demo-music.js)
    try { voice(G, t, Math.max(0.03, durSec), ev); } catch (error) { if (global.console) { console.error('[démo] voix', ev.kind, error); } }
  }

  // ------------------------------------------------------------------ les annonces vocales
  /* Les clips de l'application (demo-voice.js, généré par tools/build_web_demo_voice.py) : PCM 16 bits mono en base64. Le tampon audio d'un clip est construit à la première annonce qui en a besoin.
     null : aucun clip pour ce texte (l'application, elle aussi, saute alors l'annonce) ; undefined : le fichier de clips n'est pas encore arrivé (la page le charge en différé) -- on réessaiera. */
  function voiceBuffer(G, text) {
    if (G.voiceBuffers[text] !== undefined) { return G.voiceBuffers[text]; }
    var data = global.MarkerListDemoVoice;
    if (!data || !data.clips) { return undefined; }
    var clip = data.clips[text];
    if (!clip) { G.voiceBuffers[text] = null; return null; }
    var binary = global.atob(clip.pcm), floats = new Float32Array(clip.count), i;
    for (i = 0; i < clip.count; i++) {
      var v = (binary.charCodeAt(2 * i + 1) << 8) | binary.charCodeAt(2 * i);
      floats[i] = (v >= 32768 ? v - 65536 : v) / 32768;
    }
    var buffer = G.ctx.createBuffer(1, clip.count, clip.rate);
    if (buffer.copyToChannel) { buffer.copyToChannel(floats, 0); } else { buffer.getChannelData(0).set(floats); }
    G.voiceBuffers[text] = { buffer: buffer, lead: clip.lead, dur: clip.dur, length: clip.count / clip.rate };
    return G.voiceBuffers[text];
  }
  /* joue le clip de `text` : le fichier d'origine commence à `when` (audio), sa parole `lead` secondes plus tard (le silence du début est retiré du clip mais gardé dans le temps : « One more time » se fait
     attendre plus d'une seconde dans l'application aussi). Renvoie la durée du fichier d'origine (pour enchaîner un second clip), 0 si rien n'a été joué. */
  function playVoice(G, text, when, log) {
    var clip = voiceBuffer(G, text);
    if (!clip) { return 0; }
    var ctx = G.ctx, source = ctx.createBufferSource(), gain = ctx.createGain(), voice = { source: source, gain: gain };
    source.buffer = clip.buffer; gain.gain.value = 1;
    source.connect(gain); gain.connect(G.voice);
    source.onended = function () { var at = G.voices.indexOf(voice); if (at >= 0) { G.voices.splice(at, 1); } try { gain.disconnect(); } catch (error) { /* déjà détaché */ } };
    source.start(when + clip.lead);
    duckFor(G, when + clip.lead, when + clip.lead + clip.length);
    G.voices.push(voice);
    if (log) { log.push({ at: when + clip.lead, text: text, length: clip.length, lead: clip.lead }); }
    return clip.dur;
  }
  /* la musique baisse (VOICE_DUCK) pendant que le clip parle : attaque juste avant la première syllabe, retour progressif après la dernière. Une annonce qui commence avant que la musique ait fini de remonter
     (« Last time » juste après « Loop »...) repousse seulement la remontée. */
  function duckFor(G, from, to) {
    if (!(G.duckAmount < 1)) { return; }
    var gain = G.duck.gain;
    if (G.duckRelease !== null && from <= G.duckEnd + 0.15) { gain.cancelScheduledValues(G.duckRelease); }
    else { gain.setTargetAtTime(G.duckAmount, Math.max(0, from - 0.05), 0.02); G.duckEnd = 0; }
    G.duckEnd = Math.max(G.duckEnd, to); G.duckRelease = G.duckEnd;
    gain.setTargetAtTime(1, G.duckEnd, 0.12);
  }
  /* coupe en fondu toutes les annonces en cours ou à venir (STOP, son coupé) */
  function stopVoices(G, at, log) {
    var list = G.voices.slice();
    G.voices = [];
    if (G.duckAmount < 1) { G.duck.gain.cancelScheduledValues(at); G.duck.gain.setTargetAtTime(1, at, 0.05); G.duckEnd = 0; G.duckRelease = null; }       // la musique reprend sa place
    list.forEach(function (voice) {
      try {
        voice.gain.gain.cancelScheduledValues(at); voice.gain.gain.setValueAtTime(1, at); voice.gain.gain.linearRampToValueAtTime(0, at + VOICE_FADE);
        voice.source.stop(at + VOICE_FADE + 0.01);
      } catch (error) { /* déjà terminée */ }
    });
    if (log && list.length) { log.push({ stop: true, at: at, count: list.length }); }
  }
  /* AnnonceVocale -> les clips à jouer, dans l'ordre (TTSAnnouncer.announce : la phrase de boucle d'abord, puis le nom ; le second part quand le premier est fini) */
  function voiceTexts(event) {
    var texts = [];
    if (event.state && VOICE_PHRASES[event.state]) { texts.push(VOICE_PHRASES[event.state]); }
    if (event.name) { texts.push(String(event.name).trim().toLowerCase()); }
    return texts;
  }

  // ------------------------------------------------------------------ la console (mute, solo, volumes, métronome)
  /* mix : {trackState: [{muted, soloed, volume}...], master: {volume}, metronome} -- la même forme que le simulateur */
  function applyMix(G, mix, when, smooth) {
    var anySolo = mix.trackState.some(function (t) { return t.soloed; });
    for (var i = 0; i < 6; i++) {
      var st = mix.trackState[i] || { muted: false, soloed: false, volume: 0.85 };
      var audible = !st.muted && (!anySolo || st.soloed);
      var target = audible ? faderGain(st.volume) * TRIM[i] : 0;
      if (smooth) { G.buses[i].gain.setTargetAtTime(target, when, 0.012); } else { G.buses[i].gain.value = target; }
    }
    var click = mix.metronome ? 1 : 0, master = MASTER_TRIM * faderGain(mix.master.volume);
    if (smooth) { G.clickGate.gain.setTargetAtTime(click, when, 0.005); G.out.gain.setTargetAtTime(master, when, 0.02); }
    else { G.clickGate.gain.value = click; G.out.gain.value = master; }
  }

  // ------------------------------------------------------------------ programmation d'une portion de tronçon
  /* Programme les évènements des temps [from, to) d'un tronçon dont l'origine est (run.t0 sim, run.b0 temps) ; `at(simTime)` donne l'instant audio. `fresh` : le tronçon vient de commencer (saut, démarrage) --
     on y ajoute les notes déjà tenues à cet endroit. Renvoie le nombre d'évènements programmés. */
  function schedulePart(G, run, from, to, fresh, at, nowAudio, log) {
    var count = 0, list = [], i;
    if (fresh) {
      var held = Music.sustainedAt(from);
      for (i = 0; i < held.length; i++) { list.push({ ev: held[i], beat: from, rest: held[i].beat + held[i].dur - from }); }
    }
    var evs = Music.eventsBetween(from, to);
    for (i = 0; i < evs.length; i++) { list.push({ ev: evs[i], beat: evs[i].beat, rest: evs[i].dur }); }
    for (var b = Math.ceil(from); b < to && b < Core.END_BEAT; b++) {                               // le clic : un par temps, accentué sur le premier de la mesure (bornes EXACTES : le même nombre sert de fin à une portion et de début à la suivante)
      list.push({ ev: { track: 'click', kind: 'click', vel: b % Core.SIGNATURE === 0 ? 1 : 0.7 }, beat: b, rest: 0.1 });
    }
    for (i = 0; i < list.length; i++) {
      var item = list[i], when = at(run.t0 + Core.secondsBetween(run.b0, Math.max(run.b0, item.beat)));
      if (when < nowAudio - 0.002) { continue; }                                                     // déjà passé (onglet figé...) : on ne rattrape pas
      when = Math.max(when, nowAudio + 0.002);
      var secs = item.rest * 60 / tempoAt(item.beat);
      playEvent(G, item.ev, when, secs);
      if (log) { log.push({ at: when, beat: item.beat, track: item.ev.track, kind: item.ev.kind, midi: item.ev.midi, vel: item.ev.vel, sim: run.t0 + Core.secondsBetween(run.b0, Math.max(run.b0, item.beat)) }); }
      count += 1;
    }
    return count;
  }

  // ------------------------------------------------------------------ le moteur en direct
  var A = { enabled: false, ctx: null, G: null, runs: [], until: 0, offset: null, est0: 0, lastMix: '', server: null, log: null, voiceLog: null, handlers: null, cancels: 0, resyncs: 0, announced: 0 };

  function notifyParent(on) {
    try { if (global.parent && global.parent !== global) { global.parent.postMessage({ source: 'markerlist-demo', event: 'sound', on: !!on, state: A.ctx ? A.ctx.state : 'none' }, '*'); } } catch (error) { /* page isolée */ }
  }

  function fadeEpoch(epoch, at) {
    var ctx = A.ctx;
    epoch.gains.forEach(function (g) { g.gain.cancelScheduledValues(at); g.gain.setValueAtTime(1, at); g.gain.linearRampToValueAtTime(0, at + CANCEL_FADE); });
    setTimeout(function () { epoch.gains.forEach(function (g) { try { g.disconnect(); } catch (error) { /* déjà détaché */ } }); }, Math.max(0, (at - ctx.currentTime) + 0.5) * 1000);
  }
  function cutAll(at) {
    var old = A.G.epoch;
    A.G.epoch = makeEpoch(A.G);
    fadeEpoch(old, at);
  }
  /* coupe ce qui n'a pas encore sonné à partir de l'instant de simulation `simT` */
  function cancelFrom(simT, nowAudio, simNow) {
    var cut = Math.max(nowAudio + 0.004, simT - 0.02 + A.offset);       // le visiteur a pu agir juste après le pas précédent : on coupe dès cet instant-là
    /* Aucun tronçon programmé n'a encore commencé (le PLAY est annulé pendant le décompte : application 1.8.0, voir Server._cancelPending) : rien ne sonne, tout ce qui est programmé est à venir, donc on coupe
       TOUT DE SUITE. Sinon le fondu ne commence que 20 ms avant la première note, qui sort alors à ~18 % de son niveau (la grosse caisse et le clic du premier temps, mesurés à -19 dB au pic dans Chrome). */
    var started = A.runs.some(function (r) { return r.t0 <= simNow + 1e-9; });
    if (!started) { cut = nowAudio + 0.004; }
    cutAll(cut);
    A.cancels += 1;
    A.runs = A.runs.filter(function (r) { return r.t0 < simT - 1e-9; });
    var last = A.runs[A.runs.length - 1];
    if (last && (last.t1 === null || last.t1 > simT)) { last.t1 = simT; last.b1 = Core.advance(last.b0, simT - last.t0); last.closed = true; last.sched = last.b1; }
    A.until = simT;
    if (A.log) { A.log.push({ cancel: simT, at: cut }); }
  }

  function divergence(committed, fresh, from, until) {
    if (until <= from) { return null; }
    for (var t = from; t < until - 1e-9; t += 0.01) {
      var a = posAt(committed, t), b = posAt(fresh, t);
      if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > DIVERGENCE_BEATS)) { return Math.max(from, t - 0.01); }
    }
    return null;
  }

  /* fusionne la prévision dans les tronçons déjà suivis : un tronçon qui prolonge ou répète un tronçon connu garde SON origine (les instants des notes restent cohérents d'un pas à l'autre) */
  function merge(fcRuns) {
    var lastMatched = null;
    fcRuns.forEach(function (f) {
      var found = null, i;
      for (i = A.runs.length - 1; i >= 0 && !found; i--) {
        var c = A.runs[i];
        if (c.closed) { continue; }
        if (Math.abs(c.t0 - f.t0) < 0.03 && Math.abs(c.b0 - f.b0) < 1e-6) { found = c; }                                              // même tronçon
        else if (c.t0 <= f.t0 + 1e-9 && (c.t1 === null || c.t1 > f.t0 - 1e-9) && Math.abs(Core.advance(c.b0, f.t0 - c.t0) - f.b0) <= DIVERGENCE_BEATS && (f.contiguous || f === fcRuns[0])) { found = c; }   // prolongement
      }
      if (found) { found.t1 = f.t1; found.b1 = f.b1; lastMatched = found; }
      else { A.runs.push({ t0: f.t0, b0: f.b0, t1: f.t1, b1: f.b1, sched: undefined, closed: false }); lastMatched = A.runs[A.runs.length - 1]; }
    });
  }

  function pump(server) {
    var ctx = A.ctx;
    if (!A.enabled || !ctx || ctx.state !== 'running') { return; }
    var G = A.G, now = ctx.currentTime, simNow = server.simNow;
    if (!(now > 0)) { return; }                                                                    // l'horloge audio n'a pas encore démarré (le matériel s'initialise) : rien à programmer
    var mixState = { trackState: server.trackState, master: server.master, metronome: server.metronome };
    var key = JSON.stringify(mixState);
    if (key !== A.lastMix) { applyMix(G, mixState, now, true); A.lastMix = key; }
    // horloges : le son = la simulation + offset
    var est = now - simNow;
    if (A.offset === null || Math.abs(est - A.est0) > RESYNC) {
      if (A.offset !== null) { A.resyncs += 1; A.lastResync = { diff: +(est - A.est0).toFixed(3), now: now, sim: simNow }; }
      cutAll(now + 0.004);
      A.est0 = est; A.offset = est + START_DELAY; A.runs = []; A.until = simNow;
    } else {
      A.est0 += (est - A.est0) * 0.03; A.offset = A.est0 + START_DELAY;                           // dérive lente des deux horloges
    }
    var fc = server.forecast(LOOKAHEAD);
    var tDiv = divergence(A.runs, fc.runs, simNow, A.until);
    if (tDiv !== null) { cancelFrom(tDiv, now, simNow); }
    A.runs = A.runs.filter(function (r) { return r.sched !== undefined || r.t0 <= simNow + 1e-9; });       // un tronçon pas encore programmé (démarrage après le pré-roll...) n'engage à rien : la prévision actuelle le remplace
    merge(fc.runs);
    var end = simNow + LOOKAHEAD, at = function (simTime) { return simTime + A.offset; };
    for (var i = 0; i < A.runs.length; i++) {
      var r = A.runs[i];
      if (r.done || r.t0 >= end) { continue; }
      var fresh = r.sched === undefined, from = fresh ? r.b0 : r.sched;
      var to = r.t1 !== null ? r.b1 : Core.advance(r.b0, end - r.t0) - 1e-7;                // tronçon sans fin connue : on s'arrête un poil avant l'horizon, pour qu'une note pile sur un retour de boucle attende la prévision suivante
      if (to > from) { schedulePart(G, r, from, to, fresh, at, now, A.log); r.sched = to; } else if (fresh) { r.sched = from; }
      if (r.t1 !== null) { r.done = true; }
    }
    A.until = end;
    A.runs = A.runs.filter(function (r) { return r.t1 === null || r.t1 > simNow - 1; });
  }

  /* Une annonce vocale part (demo-engine.js, _voiceAnnounce) : réactive, comme dans l'application (qui joue le clip à l'instant où elle constate le franchissement) -- pas de programmation à l'avance. Le clip
     part à l'instant audio qui correspond à l'instant de simulation de l'annonce (le même décalage que la musique, donc aligné sur elle), au plus tôt dans 2 ms. */
  function onVoice(event) {
    if (!A.enabled || !A.ctx || !A.G || A.ctx.state !== 'running') { return; }
    var now = A.ctx.currentTime, when = Math.max(A.offset !== null ? event.at + A.offset : now + START_DELAY, now + 0.002);
    voiceTexts(event).forEach(function (text) { when += playVoice(A.G, text, when, A.voiceLog); });
    A.announced += 1;
  }
  /* STOP : une annonce ne continue jamais de parler après un arrêt (TTSAnnouncer.stop) -- coupée au même instant que la musique */
  function onVoiceStop(event) {
    if (!A.ctx || !A.G) { return; }
    var now = A.ctx.currentTime;
    stopVoices(A.G, Math.max(A.offset !== null ? event.at + A.offset - 0.02 : now, now + 0.004), A.voiceLog);
  }

  // ------------------------------------------------------------------ mise en route
  function newContext() {
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) { return null; }
    try { return new Ctor({ latencyHint: 'interactive' }); } catch (error) { try { return new Ctor(); } catch (error2) { return null; } }
  }
  /* iPhone : le commutateur silencieux coupe l'audio web, sauf si la page se déclare « lecture de média » (API récente, sinon un élément <audio> muet qui boucle fait le même effet) */
  function keepAudible() {
    try { if (global.navigator && global.navigator.audioSession) { global.navigator.audioSession.type = 'playback'; } } catch (error) { /* tant pis */ }
  }
  function unlock() {
    var ctx = A.ctx;
    if (!ctx) { return; }
    try {
      if (ctx.state !== 'running') { var p = ctx.resume(); if (p && p.then) { p.then(onState, function () { /* refusé : au prochain geste */ }); } }
      var buffer = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = buffer; s.connect(ctx.destination); s.start(0);        // débloque Safari
    } catch (error) { /* tant pis */ }
    keepAudible();
  }
  function onState() { notifyParent(A.enabled); }
  /* Un navigateur refuse (et signale en console) un contexte audio créé avant tout geste du visiteur : tant qu'il n'y en a pas eu dans cette page, on attend le premier -- le PLAY de la démo, par exemple. */
  function activated() {
    try { return global.navigator && global.navigator.userActivation ? global.navigator.userActivation.hasBeenActive : true; } catch (error) { return true; }
  }
  function ensureContext() {
    if (A.ctx) { return true; }
    var ctx = newContext();
    if (!ctx) { return false; }
    A.ctx = ctx; A.G = buildGraph(ctx); ctx.onstatechange = onState;
    return true;
  }
  function addGestureHandlers() {
    if (A.handlers || !global.document) { return; }
    A.handlers = function () { if (A.enabled && ensureContext() && A.ctx.state !== 'running') { unlock(); } };           // reste branché : iOS « interrompt » le contexte (appel, autre appli), le geste suivant le relance
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (name) { global.document.addEventListener(name, A.handlers, true); });
  }
  function removeGestureHandlers() {
    if (!A.handlers || !global.document) { return; }
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (name) { global.document.removeEventListener(name, A.handlers, true); });
    A.handlers = null;
  }

  var API = {
    supported: function () { return !!(global.AudioContext || global.webkitAudioContext); },
    isEnabled: function () { return A.enabled; },
    state: function () { return { enabled: A.enabled, context: A.ctx ? A.ctx.state : 'none', cancels: A.cancels, resyncs: A.resyncs, announced: A.announced }; },
    /* À appeler depuis un geste du visiteur. `options.context` / `options.server` : pour les tests (contexte factice, simulateur à horloge maîtrisée). */
    enable: function (options) {
      options = options || {};
      var server = options.server || global.MarkerListDemo;
      if (!A.ctx && options.context) { A.ctx = options.context; A.G = buildGraph(A.ctx); A.ctx.onstatechange = onState; }       // essais : contexte factice
      if (!A.ctx && !options.context && !API.supported()) { return false; }
      A.server = server; A.enabled = true; A.offset = null; A.lastMix = '';
      server.onFrame = pump; server.onVoice = onVoice; server.onVoiceStop = onVoiceStop;
      if (!options.context) {
        if (A.ctx || activated()) { ensureContext(); unlock(); }
        addGestureHandlers();                                  // le premier geste dans la page crée (si besoin) et débloque le contexte
      }
      notifyParent(true);
      return true;
    },
    disable: function () {
      if (!A.enabled) { return; }
      A.enabled = false;
      if (A.server) { A.server.onFrame = null; A.server.onVoice = null; A.server.onVoiceStop = null; }
      if (A.ctx && A.G) {                                       // coupé par le visiteur : silence tout de suite, queue de réverbération comprise (le volume principal revient à la prochaine activation, voir pump)
        var at = A.ctx.currentTime;
        stopVoices(A.G, at + 0.005, A.voiceLog);
        cutAll(at + 0.005); A.runs = [];
        A.G.out.gain.cancelScheduledValues(at); A.G.out.gain.setTargetAtTime(0, at, 0.02);
      }
      removeGestureHandlers();
      notifyParent(false);
    },
    toggle: function () { if (A.enabled) { API.disable(); } else { API.enable(); } return A.enabled; },
    /* ferme le contexte audio (sans prévenir la page parente) : Safari sur iPhone n'en laisse que 4 ouverts à la fois, or « Recommencer » recrée la démo ; appelée par le site avant de retirer l'iframe, et à la fermeture de la page */
    dispose: function () {
      var ctx = A.ctx;
      A.enabled = false;
      if (A.server) { A.server.onFrame = null; A.server.onVoice = null; A.server.onVoiceStop = null; }
      removeGestureHandlers();
      A.ctx = null; A.G = null; A.runs = []; A.offset = null;
      if (ctx && ctx.close) { try { var closing = ctx.close(); if (closing && closing.catch) { closing.catch(function () { /* déjà fermé */ }); } } catch (error) { /* tant pis */ } }
    },
    /* hors ligne : rend les temps [from, to) d'un morceau en audio (tests, écoute, export) -- mêmes instruments, même console. opts : {from, to, sampleRate, tail, click, mix, trackState} */
    render: function (opts) {
      var Offline = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      var from = opts.from, to = opts.to, sr = opts.sampleRate || 44100, tail = opts.tail === undefined ? 2.5 : opts.tail, lead = 0.05;
      var seconds = Core.secondsBetween(from, to) + tail + lead;
      var ctx = new Offline(2, Math.ceil(seconds * sr), sr), G = buildGraph(ctx);
      if (opts.voiceLevel !== undefined) { G.voice.gain.value = opts.voiceLevel; }                                                              // réglages d'essai (web_demo/audio_voice_check.mjs)
      if (opts.duck !== undefined) { G.duckAmount = opts.duck; }
      if (opts.dry) { G.comp.ratio.value = 1; G.limiter.ratio.value = 1; G.limiter.threshold.value = 0; G.comp.threshold.value = 0; }      // sans compresseur ni limiteur : les niveaux mesurés sont ceux des instruments
      var tracks = []; for (var i = 0; i < 6; i++) { tracks.push({ muted: false, soloed: false, volume: 0.85 }); }
      var mix = opts.mix || { trackState: tracks, master: { volume: 0.85 }, metronome: !!opts.click };
      if (opts.trackState) { mix.trackState = opts.trackState; }
      applyMix(G, mix, 0, false);
      if (opts.dry) { G.out.gain.value = 1; }                                                                                              // et sans l'atténuation du volume principal : on mesure les instruments eux-mêmes
      var run = { t0: lead, b0: from }, count = schedulePart(G, run, from, to, true, function (t) { return t; }, 0, opts.log || null);
      (opts.voices || []).forEach(function (v) { playVoice(G, String(v.text).toLowerCase(), lead + v.at, opts.voiceLog || null); });       // annonces : [{text, at}] (secondes depuis `from`)
      return ctx.startRendering().then(function (buffer) { buffer.eventCount = count; return buffer; });
    },
    _pump: pump,
    _debug: function () { return A; },
    _setLog: function (list) { A.log = list; },
    _setVoiceLog: function (list) { A.voiceLog = list; },
    constants: { LOOKAHEAD: LOOKAHEAD, START_DELAY: START_DELAY, CANCEL_FADE: CANCEL_FADE, RESYNC: RESYNC, DIVERGENCE_BEATS: DIVERGENCE_BEATS, VOICE_LEVEL: VOICE_LEVEL, VOICE_DUCK: VOICE_DUCK, VOICE_FADE: VOICE_FADE }
  };
  global.MarkerListDemoAudio = API;
  if (global.addEventListener) { global.addEventListener('pagehide', function () { API.dispose(); }); }
})(window);
