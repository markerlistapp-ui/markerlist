/* demo-engine.js -- le SIMULATEUR de la démo web de MarkerList.
 *
 * Contexte. La démo web fait tourner la VRAIE page tablette de l'application (exportée par tools/export_web_demo.py) dans le navigateur du visiteur, sans Ableton ni serveur. Cette page parle à un serveur
 * par socket.io (46 évènements reçus, 42 envoyés) : demo-socket.js la branche sur CE fichier, qui joue le rôle du serveur ET du moteur de l'application, face à un Ableton simulé.
 *
 * Fidélité. Chaque règle ci-dessous reprend ce que le VRAI moteur fait (EngineThread + WebControlServer), relevé sur des enregistrements de la démo de l'application (web_demo/golden_traces.json,
 * produits par test_web_demo_record.py ; test_web_demo.py rejoue les mêmes scénarios ici et compare) : formes des messages, cadences, délais (annonce de pré-roll 2 s + décompte + 0,45 s de démarrage),
 * arrêt à la fin d'un morceau sauf s'il est « chaîné », boucles de section x1 / x2 / infini avec relâche, boucle de morceau, cues de section, plan de boucles préparé d'avance, mixeur, sondage du tempo, annonces vocales (web_demo/golden_voice.json).
 *
 * Ce que la démo ne fait PAS : aucun vrai Ableton, rien n'est envoyé ni enregistré (aucune requête réseau). Elle n'a pas les fonctions qui demandent la vraie machine (export PDF, préréglages,
 * messages, alertes, vue LTC, routages audio) : l'état annonce `allow_pdf_export: false`, `allow_alerts: false`, `allow_ltc_view: false` pour que la page ne les propose pas.
 * Le SON n'est pas ici : demo-music.js (la partition des trois morceaux) et demo-audio.js (les instruments, la console, la programmation, la voix) jouent la musique et les annonces dans le navigateur en suivant
 * la tête de lecture de ce simulateur. Ce fichier ne leur donne que : `forecast(horizon)` (où ira la tête de lecture dans les prochaines secondes, voir plus bas), `onFrame` (appelé à chaque pas), `onVoice` et
 * `onVoiceStop` (quand l'application ANNONCERAIT une section ou une boucle à voix haute, et quand elle coupe la voix : voir « annonces vocales »), et `MarkerListDemoCore`.
 *
 * Horloge. Le temps de simulation avance par pas bornés (jamais plus de 100 ms d'un coup) : un onglet laissé en arrière-plan met la lecture en PAUSE au lieu de rattraper des minutes d'évènements.
 * `MarkerListDemo._tick(secondes)` fait avancer cette horloge à la main (tests).
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ jeu de démonstration (identique à ableton_simulator.FakeAbleton.load_showcase_set)
  var SIGNATURE = 4;                        // temps par mesure (4/4 partout)
  var SONG_BEATS = 160;                     // 40 mesures par morceau : cinq sections de 8 mesures (voir plus bas)
  var END_BEAT = 480;                       // repère END_LIVE
  /* Des sections de 8 mesures, pas moins : l'annonce vocale part 3 mesures avant la fin de la section jouée (ou dès son début si elle fait moins de 3 mesures). Avec des sections de 2 et 4 mesures (la première
     version de ce jeu) la voix annonçait la section suivante dès la première seconde de la section jouée ; à 8 mesures elle parle à la mesure 6, vers la fin de la section, comme sur scène. */
  var SONGS = [
    { name: 'NEON SKYLINE', start: 0, tempo: 124, sections: [['INTRO', 0, 32], ['VERSE 1', 32, 32], ['CHORUS 1', 64, 32], ['BRIDGE', 96, 32], ['CHORUS 2', 128, 32]] },
    { name: 'GRAVITY', start: 160, tempo: 96, sections: [['INTRO', 0, 32], ['VERSE', 32, 32], ['CHORUS', 64, 32], ['SOLO', 96, 32], ['OUTRO', 128, 32]] },
    { name: 'PAPER HEARTS', start: 320, tempo: 132, sections: [['INTRO', 0, 32], ['VERSE', 32, 32], ['BRIDGE', 64, 32], ['CHORUS', 96, 32], ['OUTRO', 128, 32]] }
  ];
  var TRACKS = [   // [nom, couleur, « percussif » (0 à 1, voir meterLevel)]
    ['CLICK', '#9aa5b1', 0.9], ['DRUMS', '#ff6b57', 1.0], ['BASS', '#4fa3ff', 0.7], ['KEYS', '#b77bff', 0.15], ['GUITARS', '#58d68d', 0.35], ['VOX', '#ffc857', 0.2], ['SECTION', '#5a8edb', 0.3]
  ];

  // délais relevés sur le vrai moteur
  var PREROLL_ANNOUNCE_S = 2.0;             // le nom du morceau s'affiche avant le décompte (ui.PREROLL_ANNOUNCE_SECONDS)
  var START_LATENCY_S = 0.45;               // reprise réelle de la lecture après le dernier temps du décompte
  var LIVE_VIEW_PERIOD_S = 0.065;           // vue Live : ~15 messages par seconde en lecture
  var LIVE_VIEW_IDLE_PERIOD_S = 0.25;       // à l'arrêt, la page n'extrapole pas : inutile d'en envoyer autant
  var SLOW_PERIOD_S = 1.07;                 // next_marker_info, metronome_state, marker_progress, music_remaining
  var METER_PERIOD_S = 0.1;
  var PREROLL_CYCLE = [1, 2, 4, 0];         // le bouton « pré-roll » fait défiler 1 → 2 → 4 mesures → désactivé
  var VOICE_LEAD_BARS = 3;                  // l'annonce vocale part 3 mesures avant la fin de la section (ui.py : tts_trigger_position_beats(..., 3 * signature))

  // ------------------------------------------------------------------ outils
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function songByName(name) { for (var i = 0; i < SONGS.length; i++) { if (SONGS[i].name === name) { return SONGS[i]; } } return null; }
  function songAt(beat) {
    var index = Math.floor(beat / SONG_BEATS);
    return SONGS[Math.max(0, Math.min(SONGS.length - 1, index))];
  }
  function songEnd(song) { return song.start + SONG_BEATS; }
  function beatsPerSecond(beat) { return songAt(beat).tempo / 60; }
  /* position atteinte en jouant `seconds` secondes depuis `beat`, en suivant les tempos de chaque morceau */
  function advance(beat, seconds) {
    var remaining = seconds;
    while (remaining > 0) {
      var song = songAt(beat), bps = song.tempo / 60, boundary = beat >= END_BEAT ? Infinity : songEnd(song);
      var toBoundary = (boundary - beat) / bps;
      if (remaining <= toBoundary || boundary === Infinity) { return beat + remaining * bps; }
      beat = boundary; remaining -= toBoundary;
    }
    return beat;
  }
  /* durée pour aller du temps `a` au temps `b` (a <= b) */
  function secondsBetween(a, b) {
    var total = 0;
    while (a < b - 1e-9) {
      var song = songAt(a), bps = song.tempo / 60, boundary = Math.min(b, a >= END_BEAT ? Infinity : songEnd(song));
      total += (boundary - a) / bps; a = boundary;
    }
    return total;
  }
  function sectionsOf(song) {
    return song.sections.map(function (s) { return { name: s[0], position_beats: song.start + s[1], end_beats: song.start + s[1] + s[2] }; });
  }
  function findSection(song, name, position) {
    var list = sectionsOf(song), match = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name && (position === undefined || position === null || Math.abs(list[i].position_beats - position) < 0.1)) { return list[i]; }
      if (list[i].name === name && !match) { match = list[i]; }
    }
    return position === undefined || position === null ? match : null;
  }
  function sectionAt(song, beat) {
    var list = sectionsOf(song);
    for (var i = 0; i < list.length; i++) { if (beat >= list[i].position_beats && beat < list[i].end_beats) { return list[i]; } }
    return null;
  }
  /* la section qui commence PILE là où une autre se termine (EngineThread._next_section_name_in_song, tolérance 0,1 temps) ; null pour la dernière section du morceau */
  function sectionStartingAt(song, beat) {
    var list = sectionsOf(song);
    for (var i = 0; i < list.length; i++) { if (Math.abs(list[i].position_beats - beat) <= 0.1) { return list[i]; } }
    return null;
  }
  var MODE_CYCLE = [null, 'x1', 'x2', 'infinite'];

  // ------------------------------------------------------------------ le simulateur
  function Server() {
    this.sockets = [];
    this.simNow = 0;                        // secondes de simulation
    this._last = null;                      // dernier instant réel vu par la boucle (performance.now)
    this._timer = null;
    this._timers = [];                      // actions différées {at, run}
    this.reset();
  }

  Server.prototype.reset = function () {
    this.playing = false;
    this.anchorPos = 0;                     // position (temps) à l'instant anchorTime
    this.anchorTime = 0;
    this.stoppedPos = 0;
    this.lastPos = 0;
    this.active = SONGS[0].name;
    this.visible = SONGS.map(function (s) { return s.name; });
    this.chain = [];                        // morceaux « chaînés » (ils enchaînent sur le suivant au lieu de s'arrêter)
    this.songLoops = [];                    // morceaux dont le badge « boucle de morceau » est allumé
    this.plans = {};                        // song -> [{section_name, position_beats, mode}] (boucles préparées d'avance)
    this.cues = {};                         // song -> [{source_name, source_start_beats, target_name, target_start_beats}]
    this.loop = null;                       // boucle ARMÉE : {section_name, start_beats, end, mode, remaining, releasing}
    this.prerollMeasures = 1;
    this.metronome = true;
    this.pending = null;                    // lecture demandée, en préparation : {at, commitAt, stopAfter, jumpTo} (voir on_transport_play)
    this.pinned = [];                       // pistes épinglées au mixeur
    this.trackState = TRACKS.map(function () { return { muted: false, soloed: false, volume: 0.85 }; });
    this.master = { volume: 0.85, cue: 0.85 };
    this.show = { band_name: 'MarkerList Demo', venue: '', show_date: '', end_time: '' };
    this.meters = {};                       // index -> true pour les pistes dont la tablette suit le niveau
    this._lastBeat = null;
    this.autoArmed = {};                    // sections / morceaux dont l'armement automatique est « décidé » pour cette sélection de morceau (EngineThread._auto_armed_sections)
    this.tempoSeen = SONGS[0].tempo;        // dernier tempo envoyé aux tablettes (le vrai moteur le sonde toutes les ~1 s et n'envoie que les changements)
    this.voiceFired = null;                 // clé « morceau|section|début » de la section dont l'annonce vocale est déjà partie (EngineThread._tts_announce_fired_for)
    this.voiceLog = [];                     // les dernières annonces {at, state, name, song, pos} (tests, mesures)
    this._acc = { live: 0, slow: 0, meter: 0 };
    this._started = {};                     // première utilisation de chaque fonction (mesure d'usage, voir notify)
  };

  // -------- horloge
  Server.prototype.start = function () {
    var self = this;
    if (this._timer || this.manualClock) { return; }          // manualClock : les tests font avancer le temps eux-mêmes (_tick)
    this._last = global.performance ? global.performance.now() : Date.now();
    this._timer = setInterval(function () {
      var real = global.performance ? global.performance.now() : Date.now();
      var dt = Math.max(0, (real - self._last) / 1000);
      self._last = real;
      self._tick(Math.min(dt, 0.1));
      if (self.onFrame) { try { self.onFrame(self); } catch (error) { if (global.console) { console.error('[démo] son :', error); } } }       // le son (demo-audio.js) suit la tête de lecture à chaque pas
    }, 20);
  };
  Server.prototype.stopClock = function () { if (this._timer) { clearInterval(this._timer); this._timer = null; } };

  Server.prototype._tick = function (dt) {
    // un pas plus grand que 50 ms est découpé : les franchissements (boucle, cue, fin de morceau) restent détectés dans l'ordre
    var step = 0.02;
    while (dt > 1e-9) {
      var d = Math.min(step, dt);
      this.simNow += d; dt -= d;
      this._step(d);
    }
  };

  // -------- position
  Server.prototype.position = function () {
    return this.playing ? advance(this.anchorPos, this.simNow - this.anchorTime) : this.stoppedPos;
  };
  Server.prototype._setPosition = function (beat) {
    this.anchorPos = beat; this.anchorTime = this.simNow; this.stoppedPos = beat; this.lastPos = beat;
  };

  // -------- envoi
  Server.prototype.attach = function (socket) { if (this.sockets.indexOf(socket) < 0) { this.sockets.push(socket); } };
  Server.prototype.detach = function (socket) { this.sockets = this.sockets.filter(function (s) { return s !== socket; }); };
  Server.prototype.emit = function (name, payload) { for (var i = 0; i < this.sockets.length; i++) { this.sockets[i]._deliver(name, payload); } };
  Server.prototype.emitTo = function (socket, name, payload) { socket._deliver(name, payload); };

  // -------- charges utiles (mêmes formes que web_control.py)
  Server.prototype.activeSong = function () { return songByName(this.active) || SONGS[0]; };
  Server.prototype.nextVisible = function (name) { var i = this.visible.indexOf(name); return i >= 0 && i < this.visible.length - 1 ? this.visible[i + 1] : null; };
  Server.prototype.previousVisible = function (name) { var i = this.visible.indexOf(name); return i > 0 ? this.visible[i - 1] : null; };

  Server.prototype.loopPayload = function () {
    var l = this.loop;
    return l ? { section_name: l.section_name, start_beats: l.start_beats, mode: l.mode, remaining: l.remaining, releasing: l.releasing } : null;
  };

  Server.prototype.stateEvent = function () {
    return {
      markers: this.visible.slice(), all_markers: SONGS.map(function (s) { return s.name; }), active: this.active, chain_next: this.chain.slice(),
      loop_plan_songs: Object.keys(this.plans).filter(function (k) { return this.plans[k].length; }, this), song_loop_songs: this.songLoops.slice(),
      mixer_pinned_tracks: this.pinned.slice().sort(), next_marker_info: this.nextMarkerInfo(), music_remaining: this.musicRemaining(),
      calibration_active: false, calibration_duration_s: null, calibration_remaining_s: null, calibration_kind: 'osc', preroll_measures: this.prerollMeasures, loop_state: this.loopPayload(),
      allow_drag_drop: true, allow_track_control: true, allow_pdf_export: false, allow_preroll: true, allow_preroll_customization: true, allow_live_view: true, allow_ltc_view: false,
      allow_alerts: false, allow_song_loop: true, ableton_unresponsive: false, foreign_loop: false, peer_address: null, is_standby: false,
      /* ajoutés par l'application 1.8.0 : Live répond « 0 repère » (bandeau « Aucun repère »), et le réglage « PLAY après un STOP » -- la démo le masque et ne simule aucune pause, ses valeurs sont celles d'une installation neuve */
      no_markers: false, resume_mode: 'restart', resume_align: 'exact', resume_preroll: null, resume_available: true
    };
  };

  Server.prototype.nextMarkerInfo = function () {
    var song = this.activeSong(), p = this.position(), next = this.nextVisible(song.name);
    return { name: next, seconds_remaining: secondsBetween(Math.min(p, songEnd(song)), songEnd(song)), previous_name: this.previousVisible(song.name) };
  };
  Server.prototype.musicRemaining = function () { return { seconds_remaining: secondsBetween(Math.min(this.position(), END_BEAT), END_BEAT) }; };
  Server.prototype.markerProgress = function () {
    var song = this.activeSong(), p = this.position();
    return { percent: Math.max(0, Math.min(100, (p - song.start) / SONG_BEATS * 100)) };
  };

  Server.prototype.liveViewState = function () {
    var song = this.activeSong(), plan = this.plans[song.name] || [], cues = this.cues[song.name] || [];
    var subs = sectionsOf(song).map(function (s) {
      var planned = null, cue = null, i;
      for (i = 0; i < plan.length; i++) { if (plan[i].section_name === s.name && Math.abs(plan[i].position_beats - s.position_beats) < 0.1) { planned = plan[i].mode; } }
      for (i = 0; i < cues.length; i++) { if (cues[i].source_name === s.name && Math.abs(cues[i].source_start_beats - s.position_beats) < 0.1) { cue = cues[i]; } }
      return { name: s.name, position_beats: s.position_beats, end_beats: s.end_beats, planned_mode: planned, cue_target_name: cue ? cue.target_name : null, cue_target_start_beats: cue ? cue.target_start_beats : null };
    });
    return { marker_name: song.name, next_marker_name: this.nextVisible(song.name), position_beats: this.position(), tempo: song.tempo, signature: SIGNATURE, signature_denominator: 4,
             segment_start_beats: song.start, segment_end_beats: songEnd(song), sub_markers: subs, is_playing: this.playing };
  };

  Server.prototype.sectionsInfo = function (songName) {
    var song = songByName(songName);
    if (!song) { return null; }
    var cues = this.cues[song.name] || [], plan = this.plans[song.name] || [];
    return {
      song_name: song.name,
      sections: sectionsOf(song).map(function (s) {
        var cue = null;
        for (var i = 0; i < cues.length; i++) { if (cues[i].source_name === s.name && Math.abs(cues[i].source_start_beats - s.position_beats) < 0.1) { cue = cues[i]; } }
        return { section_name: s.name, position_beats: s.position_beats, end_beats: s.end_beats, duration_seconds: (s.end_beats - s.position_beats) * 60 / song.tempo,
                 cue_target_name: cue ? cue.target_name : null, cue_target_start_beats: cue ? cue.target_start_beats : null };
      }),
      plan: plan.map(function (e) { return { section_name: e.section_name, position_beats: e.position_beats, mode: e.mode }; })
    };
  };

  Server.prototype.durations = function () {
    var out = {};
    SONGS.forEach(function (s) { out[s.name] = SONG_BEATS * 60 / s.tempo; });
    return { durations: out };
  };
  Server.prototype.meta = function () {
    var out = {};
    SONGS.forEach(function (s) { out[s.name] = { tempo: s.tempo, signature_num: SIGNATURE, signature_den: 4 }; });
    return { meta: out };
  };
  Server.prototype.tracksPayload = function () {
    return { tracks: TRACKS.map(function (t, i) { return { index: i, name: t[0], muted: this.trackState[i].muted, soloed: this.trackState[i].soloed, color: t[1] }; }, this) };
  };

  /* niveau de sortie d'une piste (même formule que ableton_simulator.LiveModel.meter_level) */
  Server.prototype.meterLevel = function (index) {
    if (!this.playing || index < 0 || index >= TRACKS.length) { return 0; }
    var st = this.trackState[index], anySolo = this.trackState.some(function (t) { return t.soloed; });
    if (st.muted || (anySolo && !st.soloed)) { return 0; }
    var beat = this.position(), punch = TRACKS[index][2];
    var hit = Math.exp(-5 * (beat % 1)), drift = 0.5 + 0.5 * Math.sin(beat * 0.7 + index * 1.9);
    var level = (0.22 + 0.42 * punch * hit + 0.26 * drift * (1 - 0.5 * punch)) * (st.volume / 0.85);
    return Math.max(0, Math.min(1, level));
  };

  /* niveau du bus principal : la somme de ce qui joue (pistes non coupées, ou solo), qui « claque » à chaque temps. Le vrai moteur le mesure par capture audio (master_audio_meter.py) ; ici, un modèle. */
  Server.prototype.masterLevel = function () {
    if (!this.playing) { return 0; }
    var anySolo = this.trackState.some(function (t) { return t.soloed; }), sum = 0;
    this.trackState.forEach(function (t) { if (!t.muted && (!anySolo || t.soloed)) { sum += t.volume / 0.85; } });
    var beat = this.position(), hit = Math.exp(-5 * (beat % 1)), fraction = Math.min(1, sum / TRACKS.length);
    return Math.max(0, Math.min(1, fraction * (0.5 + 0.22 * hit + 0.05 * Math.sin(beat * 0.9)) * (this.master.volume / 0.85)));
  };

  // ------------------------------------------------------------------ connexion
  /* à la connexion d'une tablette : mêmes messages, dans le même ordre, que WebControlServer.on_connect */
  Server.prototype.greet = function (socket) {
    this.emitTo(socket, 'state', this.stateEvent());
    this.emitTo(socket, 'permission_changed', { permission: 'full' });
    this.emitTo(socket, 'tempo', { bpm: this.tempoSeen });
    this.emitTo(socket, 'live_view_state', this.liveViewState());
    this.emitTo(socket, 'ltc_timecode', { timecode: null, receiving: false });
    this.emitTo(socket, 'marker_durations', this.durations());
    this.emitTo(socket, 'marker_meta', this.meta());
    this._slowGroup(socket);
    this.start();
    this.notify('open');
  };

  Server.prototype._slowGroup = function (only) {
    var send = only ? this.emitTo.bind(this, only) : this.emit.bind(this);
    send('next_marker_info', this.nextMarkerInfo());
    send('metronome_state', { enabled: this.metronome });
    send('marker_progress', this.markerProgress());
    send('music_remaining', this.musicRemaining());
  };

  /* mesure d'usage : la page parente (le site) peut écouter ces messages ; rien ne quitte le navigateur d'ici */
  Server.prototype.notify = function (what) {
    if (this._started[what]) { return; }
    this._started[what] = true;
    try { if (global.parent && global.parent !== global) { global.parent.postMessage({ source: 'markerlist-demo', event: what }, '*'); } } catch (error) { /* page isolée : tant pis */ }
  };

  // ------------------------------------------------------------------ boucles, cues, changement de morceau
  Server.prototype._setLoop = function (loop) {
    this.loop = loop;
    this.emit('loop_state', { state: this.loopPayload() });
  };

  Server.prototype._armSong = function (song) {
    this._setLoop({ section_name: null, start_beats: song.start, end: songEnd(song), mode: 'infinite', remaining: null, releasing: false });
    this.voiceFired = null;                                 // handle_loop_cycle : chaque changement d'état de la boucle remet l'annonce de la section en cours à l'étude (voir _voiceTick)
  };

  Server.prototype._loopOnSection = function (section) {
    var L = this.loop;
    return !!L && L.section_name === section.name && Math.abs(L.start_beats - section.position_beats) <= 0.1;
  };
  Server.prototype._planEntry = function (song, section) {
    var plan = this.plans[song.name] || [], found = null;
    for (var i = 0; i < plan.length; i++) { if (plan[i].section_name === section.name && Math.abs(plan[i].position_beats - section.position_beats) < 0.1) { found = plan[i]; } }
    return found;
  };

  /* EngineThread.handle_loop_cycle pour une section EN COURS : arme la boucle (x1 par défaut, x2 / infini si imposé), ou fait avancer son cycle x1 → x2 → infini → relâche */
  Server.prototype._cycleSection = function (section, forcedMode, directInfinite) {
    var L = this.loop, released = false;
    if (!this._loopOnSection(section)) {
      var infinite = forcedMode === 'infinite' || directInfinite;
      L = { section_name: section.name, start_beats: section.position_beats, end: section.end_beats, mode: infinite ? 'infinite' : 'fixed', remaining: infinite ? null : (forcedMode === 'x2' ? 2 : 1), releasing: false };
      this.voiceFired = null;
    } else if (L.mode === 'fixed' && L.remaining === 1) { L.remaining = 2; this.voiceFired = null; }
    else if (L.mode === 'fixed' && L.remaining === 2) { L.mode = 'infinite'; L.remaining = null; this.voiceFired = null; }
    else if (L.mode === 'infinite' && !L.releasing) { L.releasing = true; this.voiceFired = null; released = true; }
    this._setLoop(L);                                       // comme le vrai moteur, l'état de la boucle est rediffusé même quand l'appui ne change rien (relâche déjà demandée)
    if (released) { this._voiceReleaseNow(); }
  };

  /* handle_loop_cycle(whole_song=True) : boucle du morceau ACTIF entier (infinie) ; si c'est déjà elle qui tourne, la relâche. Remplace sans prévenir une boucle de section. */
  Server.prototype._cycleSong = function (song) {
    var L = this.loop;
    if (!(L && L.section_name === null && Math.abs(L.start_beats - song.start) <= 0.1)) { this._armSong(song); return; }
    var released = false;
    if (L.mode === 'infinite' && !L.releasing) { L.releasing = true; this.voiceFired = null; released = true; }
    this._setLoop(L);
    if (released) { this._voiceReleaseNow(); }
  };

  /* armement AUTOMATIQUE, à chaque pas de lecture (EngineThread.run) : la boucle préparée de la section où l'on se trouve, puis la boucle de morceau si son badge est allumé.
     Chaque décision est prise une fois par sélection de morceau (autoArmed, vidé par un saut ou un PLAY) ; un plan par section l'emporte sur la boucle de morceau. */
  Server.prototype._autoArm = function (p) {
    var song = this.activeSong(), section = sectionAt(song, p), key, entry;
    if (section) {
      key = song.name + '|' + section.position_beats;
      if (!this.autoArmed[key]) {
        entry = this._planEntry(song, section);
        if (!entry || this._loopOnSection(section)) { this.autoArmed[key] = true; }
        else {
          this._cycleSection(section, entry.mode);
          if (this._loopOnSection(section)) { this.autoArmed[key] = true; }
        }
      }
    }
    key = song.name + '|song';
    if (!this.autoArmed[key]) {
      if ((this.plans[song.name] || []).length || this.songLoops.indexOf(song.name) < 0 || (this.loop && this.loop.section_name === null)) { this.autoArmed[key] = true; }
      else { this._armSong(song); this.autoArmed[key] = true; }
    }
  };

  Server.prototype._setActive = function (name) {
    this.active = name;
    this.emit('marker_active', { name: name });
  };

  /* le vrai moteur interroge le tempo d'Ableton toutes les ~1 s (TEMPO_CHECK_INTERVAL) et n'envoie « tempo » que s'il a changé : l'en-tête de la tablette suit donc avec un léger retard */
  Server.prototype._checkTempo = function () {
    var bpm = songAt(this.position()).tempo;
    if (bpm !== this.tempoSeen) { this.tempoSeen = bpm; this.emit('tempo', { bpm: bpm }); }
  };

  /* saute (en lecture ou à l'arrêt) au début d'un morceau, comme trigger_marker */
  Server.prototype._goToSong = function (name, keepPlaying) {
    var song = songByName(name);
    if (!song) { return; }
    if (this.loop && name !== this.active) { this._setLoop(null); }     // EngineThread._set_active_marker : la boucle n'est oubliée que si le morceau CHANGE (relancer le même morceau la garde)
    this.autoArmed = {};
    this.voiceFired = null;                                             // un saut est une approche neuve (voir _voiceTick : comme l'application depuis la 1.8.0)
    this._setActive(name);
    this._setPosition(song.start);
    if (!keepPlaying) { this.playing = false; }
    this.emit('live_view_state', this.liveViewState());
    this._slowGroup();
  };

  Server.prototype._stopPlaying = function () {
    if (!this.playing) { return; }
    this.stoppedPos = this.position();
    this.playing = false;
    this.lastPos = this.stoppedPos;
    this._voiceStop();                                                  // _send_stop_command : une annonce ne continue jamais de parler après un arrêt
    this.emit('live_view_state', this.liveViewState());
  };

  Server.prototype._startPlaying = function () {
    var song = this.activeSong();
    this._setPosition(song.start + START_LATENCY_S * song.tempo / 60);        // relevé : la première vue Live « en lecture » est déjà ~1 temps après le début du morceau
    this.playing = true;
    this._lastBeat = Math.floor(this.position());
    this.emit('live_view_state', this.liveViewState());
  };

  // ------------------------------------------------------------------ un pas de simulation
  Server.prototype._step = function (dt) {
    var i;
    // actions différées (démarrage de la lecture après le pré-roll...)
    if (this.pending && this.simNow >= this.pending.at) {
      var late = this.pending;
      this.pending = null;
      this._startPlaying();
      /* ce que le visiteur a demandé APRÈS l'engagement du PLAY (trop tard pour l'annuler : voir on_transport_stop, on_trigger_marker) s'exécute maintenant que le PLAY est fini : le morceau choisi d'abord (la
         lecture saute), l'arrêt ensuite -- dans les deux ordres d'arrivée on finit arrêté sur le morceau choisi */
      if (late.jumpTo) { this._goToSong(late.jumpTo, true); this._lastBeat = Math.floor(this.position()); this.emit('beat', { downbeat: true }); }
      if (late.stopAfter) { this._stopPlaying(); }
    }
    if (this.playing) { this._advanceTransport(); }
    if (this.playing) { this._voiceTick(); }                          // après les franchissements du pas (boucle, cue, morceau), comme le bloc TTS de EngineThread.run()
    // cadences
    this._acc.live += dt; this._acc.slow += dt; this._acc.meter += dt;
    var livePeriod = this.playing ? LIVE_VIEW_PERIOD_S : LIVE_VIEW_IDLE_PERIOD_S;
    if (this._acc.live >= livePeriod) { this._acc.live = Math.min(this._acc.live - livePeriod, livePeriod); this.emit('live_view_state', this.liveViewState()); }
    if (this._acc.slow >= SLOW_PERIOD_S) { this._acc.slow -= SLOW_PERIOD_S; this._slowGroup(); this._checkTempo(); }
    if (this._acc.meter >= METER_PERIOD_S) {
      this._acc.meter = 0;
      for (var key in this.meters) { if (this.meters[key]) { this.emit('track_meter_level', { index: Number(key), level: this.meterLevel(Number(key)) }); } }
      this.emit('master_meter_level', { level: this.masterLevel() });
    }
  };

  /* franchissements entre deux pas : temps (beat), armement automatique, fin de boucle, cue, fin de morceau, fin du set */
  Server.prototype._advanceTransport = function () {
    var prev = this.lastPos, p = this.position(), i;
    // 1. temps (battements)
    var beatIndex = Math.floor(p);
    if (this._lastBeat === null || this._lastBeat > beatIndex) { this._lastBeat = beatIndex; }
    while (this._lastBeat < beatIndex) {
      this._lastBeat += 1;
      this.emit('beat', { downbeat: this._lastBeat % SIGNATURE === 0 });
    }
    // 2. armement automatique (plan de la section, boucle de morceau), puis fin de la boucle armée : retour au début (x1 / x2 / infini) ou sortie (relâchée, ou compte épuisé)
    this._autoArm(p);
    var L = this.loop;
    if (L && prev < L.end && p >= L.end) {
      var over = p - L.end;
      if (L.releasing) {
        this._setLoop(null);                                          // pas de retour : la lecture continue après la section
      } else if (L.mode === 'infinite' || L.remaining > 0) {
        this._setPosition(L.start_beats + over);
        this.voiceFired = null;                                       // chaque bouclage natif est une entrée neuve dans un nouveau tour : l'annonce redevient possible
        if (L.mode === 'fixed') { L.remaining -= 1; }
        this._setLoop(L.mode === 'fixed' && L.remaining <= 0 ? null : L);
        this._lastBeat = Math.floor(this.position());
        this.emit('live_view_state', this.liveViewState());
        this._acc.live = 0;
        return;                                                       // revenu en arrière : rien d'autre à franchir dans ce pas
      }
    }
    var song = this.activeSong();
    // 3. cue de section armé : à la fin de la section source, saut au début de la cible (le cue est consommé)
    var cues = this.cues[song.name] || [];
    for (i = 0; i < cues.length; i++) {
      var source = findSection(song, cues[i].source_name, cues[i].source_start_beats);
      if (source && prev < source.end_beats && p >= source.end_beats) {
        var cue = cues.splice(i, 1)[0], past = p - source.end_beats;
        this._setPosition(cue.target_start_beats + past);
        this._lastBeat = Math.floor(this.position());
        this.emit('state', this.stateEvent());
        this.emit('section_cue_changed', { song_name: song.name, source_name: cue.source_name, source_start_beats: cue.source_start_beats, target_name: null, target_start_beats: null });
        this.emit('live_view_state', this.liveViewState());
        this._acc.live = 0;
        return;
      }
    }
    // 4. fin du set / fin de morceau
    if (p >= END_BEAT) { this._endOfSet(); return; }
    if (p >= songEnd(song)) {
      var next = this.nextVisible(song.name);
      if (next && this.chain.indexOf(song.name) >= 0) {
        // morceau « chaîné » : la lecture continue sur le morceau suivant de la setlist visible
        var target = songByName(next), past2 = p - songEnd(song);
        if (this.loop) { this._setLoop(null); }
        this._setActive(next);
        if (target.start !== songEnd(song)) { this._setPosition(target.start + past2); }
        this.lastPos = this.position();
        this.emit('live_view_state', this.liveViewState());
      } else if (next) {
        // pas chaîné : le transport s'arrête, le morceau suivant est prêt à être lancé
        var nextSong = songByName(next);
        if (this.loop) { this._setLoop(null); }
        this._stopPlaying();
        this._setActive(next);
        this._setPosition(nextSong.start);
        this.lastPos = this.position();
        this.emit('live_view_state', this.liveViewState());
        this._slowGroup();
      } else {
        this._endOfSet();
      }
      return;
    }
    this.lastPos = p;
  };

  Server.prototype._endOfSet = function () {
    if (this.loop) { this._setLoop(null); }
    this.stoppedPos = Math.min(this.position(), END_BEAT);
    this.playing = false;
    this.lastPos = this.stoppedPos;
    this._voiceStop();
    this.emit('live_view_state', this.liveViewState());
    this._slowGroup();
  };

  // ------------------------------------------------------------------ annonces vocales
  /* Ce que l'application annonce à voix haute, et quand -- le bloc TTS de EngineThread.run(), marker_engine.resolve_tts_announcement et tts_trigger_position_beats, repris à l'identique :
       - À chaque pas de lecture : pour la section en cours, si son annonce n'est pas déjà partie (voiceFired) et que la tête de lecture a atteint `fin de la section - 3 mesures` (jamais avant le début de la
         section : une section de moins de 3 mesures est annoncée dès son début), l'annonce part, UNE fois.
       - Ce qu'elle dit : pendant une boucle sur cette section, « Loop » (il reste des tours après celui-ci), « One more time » (dernier tour d'une boucle comptée : badge « x1 ») ou « Last time » (boucle infinie
         déjà relâchée) -- jamais de nom de section avec ; sans boucle sur cette section, le nom de la section où la lecture va (la cible d'un cue de section, sinon la section qui suit). Rien pour la dernière
         section d'un morceau. Une boucle de MORCEAU ENTIER n'annonce pas « Loop » (sa section_name est null : elle n'est jamais « sur cette section »).
       - Remise à zéro de voiceFired : à chaque bouclage natif (chaque tour est une entrée neuve) et à chaque changement d'état de la boucle par le visiteur (armée, x1 -> x2, x2 -> infini, relâche).
       - « Last time » part tout de suite quand on relâche une boucle (sans attendre les 3 mesures), et marque la section comme annoncée pour que le déclenchement normal ne le répète pas.
       - STOP (manuel, fin de morceau non chaîné, fin du set) coupe l'annonce en cours.
     voiceFired est aussi remis à zéro à chaque PLAY et à chaque saut de morceau, comme l'application depuis la 1.8.0 (point 1.5 : EngineThread remet son mémo « déjà annoncé » à zéro à chaque PLAY qui relance le
     morceau et au changement de morceau). Avant, sa clé « morceau, section, début » ne changeait pas si l'on rejouait le même morceau depuis le début après avoir arrêté juste après l'annonce de sa première section :
     cette annonce était muette la seconde fois, et la démo s'en écartait exprès (sur un site où le visiteur appuie sur PLAY, STOP, PLAY c'est le cas courant). L'application a rejoint la démo : plus aucun écart.
     Le simulateur ne joue aucun son : il prévient (onVoice) et le moteur sonore (demo-audio.js) joue le clip. onVoice({state, name, at}) : state = null | 'looping' | 'final_loop_fixed' | 'final_loop_infinite',
     name = nom de section ou null, at = secondes de simulation. */
  Server.prototype._voiceAnnounce = function (state, name) {
    if (state === null && name === null) { return; }
    var event = { state: state, name: name, at: this.simNow, song: this.active, pos: this.position() };
    this.voiceLog.push(event);
    if (this.voiceLog.length > 200) { this.voiceLog.shift(); }
    if (this.onVoice) { try { this.onVoice(event); } catch (error) { if (global.console) { console.error('[démo] annonce :', error); } } }
  };
  Server.prototype._voiceStop = function () {
    if (this.onVoiceStop) { try { this.onVoiceStop({ at: this.simNow }); } catch (error) { if (global.console) { console.error('[démo] annonce :', error); } } }
  };
  /* marker_engine.resolve_tts_announcement */
  Server.prototype._voiceResolve = function (song, section, cueTargetName, nextSectionName) {
    var L = this.loop;
    var looping = !!L && L.section_name === section.name && Math.abs(L.start_beats - section.position_beats) <= 0.1;
    if (looping) {
      var finalPass = (L.mode === 'infinite' && L.releasing) || (L.mode === 'fixed' && L.remaining === 1);       // is_loop_on_final_intentional_pass
      if (!finalPass) { return { state: 'looping', name: null }; }
      return { state: L.mode === 'infinite' ? 'final_loop_infinite' : 'final_loop_fixed', name: null };
    }
    return { state: null, name: cueTargetName !== null ? cueTargetName : nextSectionName };
  };
  Server.prototype._voiceTick = function () {
    var song = this.activeSong(), p = this.position(), section = sectionAt(song, p);
    if (!section) { return; }
    var key = song.name + '|' + section.name + '|' + section.position_beats;
    if (key === this.voiceFired) { return; }
    if (p < Math.max(section.position_beats, section.end_beats - VOICE_LEAD_BARS * SIGNATURE)) { return; }
    this.voiceFired = key;
    var cues = this.cues[song.name] || [], cueTarget = null, i;
    for (i = 0; i < cues.length; i++) {
      if (cues[i].source_name === section.name && Math.abs(cues[i].source_start_beats - section.position_beats) <= 0.1) { cueTarget = cues[i].target_name; break; }
    }
    var following = sectionStartingAt(song, section.end_beats);
    var parts = this._voiceResolve(song, section, cueTarget, following ? following.name : null);
    this._voiceAnnounce(parts.state, parts.name);
  };
  /* _tts_announce_release_now : à la relâche d'une boucle, « Last time » aussitôt -- si la boucle relâchée est bien celle de la section où l'on se trouve (ou une boucle de morceau entier) */
  Server.prototype._voiceReleaseNow = function () {
    var L = this.loop;
    if (!L) { return; }
    var song = this.activeSong(), key;
    if (L.section_name === null) { key = song.name + '|null|' + L.start_beats; }
    else {
      var section = sectionAt(song, this.position());
      if (!section || L.section_name !== section.name || Math.abs(L.start_beats - section.position_beats) > 0.1) { return; }
      key = song.name + '|' + section.name + '|' + section.position_beats;
    }
    this.voiceFired = key;
    this._voiceAnnounce('final_loop_infinite', null);
  };

  // ------------------------------------------------------------------ ce que la tablette envoie
  Server.prototype.fromClient = function (name, data) {
    data = data || {};
    var handler = this['on_' + name];
    if (typeof handler === 'function') { handler.call(this, data); }
    // les autres évènements (export PDF, préréglages, messages, routages...) n'existent pas dans la démo : ignorés sans bruit
  };

  Server.prototype.on_transport_play = function () {
    if (this.playing || this.pending) { return; }
    this.notify('play');
    this.autoArmed = {};
    this.voiceFired = null;                                           // chaque lecture repart d'une approche neuve (voir _voiceTick : comme l'application depuis la 1.8.0)
    var song = this.activeSong();
    /* at : la lecture vue partie par la tablette ; commitAt : l'« engagement » du PLAY (ui.py, EngineThread.handle_play_request : « dernier point d'annulation », la fin de l'annonce et du décompte), START_LATENCY_S avant at.
       Sans pré-roll le PLAY s'engage tout de suite (commitAt = maintenant) : aucun STOP ni choix de morceau ne peut arriver avant, la fenêtre de START_LATENCY_S est « trop tard ». */
    if (this.prerollMeasures > 0) {
      var beats = this.prerollMeasures * SIGNATURE;
      this.emit('preroll_start', { beats: beats, tempo: song.tempo, song_name: song.name });
      var commitAt = this.simNow + PREROLL_ANNOUNCE_S + beats * 60 / song.tempo;
      this.pending = { at: commitAt + START_LATENCY_S, commitAt: commitAt, stopAfter: false, jumpTo: null };
    } else {
      this.pending = { at: this.simNow + START_LATENCY_S, commitAt: this.simNow, stopAfter: false, jumpTo: null };
    }
  };

  /* Application 1.8.0 (06/11, EngineThread.cancel_pending_play) : un STOP, ou un AUTRE morceau choisi, pendant l'annonce / le décompte d'un PLAY l'annule -- Live ne joue jamais et le calque disparaît des tablettes
     (`preroll_cancel`). Passé l'engagement du PLAY (commitAt) c'est trop tard, comme avant : voir on_transport_stop et on_trigger_marker. */
  Server.prototype._cancelPending = function () {
    this.pending = null;
    this.emit('preroll_cancel', {});
  };

  Server.prototype.on_transport_stop = function () {
    if (this.pending) {
      if (this.simNow < this.pending.commitAt) { this._cancelPending(); }       // le STOP est CONSOMMÉ : rien d'autre (pas de « double-stop »)
      else { this.pending.stopAfter = true; }                                    // trop tard : le PLAY va à son terme, l'arrêt est exécuté juste après le départ
      return;
    }
    this._stopPlaying();
  };

  Server.prototype.on_trigger_marker = function (data) {
    if (!songByName(data.name) || this.visible.indexOf(data.name) < 0) { return; }
    this.notify('jump');
    if (this.pending) {
      if (this.simNow >= this.pending.commitAt) { this.pending.jumpTo = data.name; return; }       // trop tard pour annuler : le choix attend la fin du PLAY (verrou de transport), puis saute pendant la lecture
      this._cancelPending();                                                                          // sinon le PLAY est annulé, puis le morceau est choisi à l'arrêt
    }
    this._goToSong(data.name, this.playing);
    if (this.playing) { this._lastBeat = Math.floor(this.position()); this.emit('beat', { downbeat: true }); }
  };

  Server.prototype.on_get_song_sections = function (data) {
    var info = this.sectionsInfo(data.song_name);
    if (info) { this.emit('song_sections_info', info); }
  };

  Server.prototype.on_cycle_loop = function (data) {
    var song = this.activeSong(), p = this.position(), section, current = sectionAt(song, p);
    if (data.section_name) {                                    // une ligne de la liste des sections
      section = findSection(song, data.section_name, data.position_beats);
      if (!section) { this.emit('loop_unavailable', {}); return; }
      this.notify('loop');
      if (!current || current.name !== section.name || Math.abs(current.position_beats - section.position_beats) > 0.1) { this._togglePlan(song, section); return; }   // pas la section en cours : on la PRÉPARE
    } else {                                                    // le bouton « LOOP SECTION » : la section en cours
      section = current;
      if (!section) { this.emit('loop_unavailable', {}); return; }
      this.notify('loop');
    }
    this._cycleSection(section, undefined, !!data.direct_infinite);
  };

  /* boucle préparée d'avance pour une section pas encore atteinte : aucun / x1 / x2 / infini, à chaque appui */
  Server.prototype._togglePlan = function (song, section) {
    var plan = this.plans[song.name] = this.plans[song.name] || [], entry = this._planEntry(song, section);
    var current = entry ? entry.mode : null, next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
    if (entry) { if (next) { entry.mode = next; } else { plan.splice(plan.indexOf(entry), 1); } }
    else { plan.push({ section_name: section.name, position_beats: section.position_beats, mode: next }); }
    this.emit('state', this.stateEvent());
    this.emit('loop_plan_entry_changed', { song_name: song.name, section_name: section.name, position_beats: section.position_beats, mode: next });
  };

  /* handle_loop_release : la boucle en cours, quel que soit son mode, passe en « dernier tour » ; une boucle de morceau retire aussi son badge */
  Server.prototype.on_release_loop = function () {
    var L = this.loop;
    if (!L || L.releasing) { return; }
    L.mode = 'infinite'; L.remaining = null; L.releasing = true;
    this.voiceFired = null;
    this._setLoop(L);
    this._voiceReleaseNow();                                          // « Last time » tout de suite, sans attendre les 3 mesures (handle_loop_release -> _tts_announce_release_now)
    if (L.section_name === null) {
      var i = this.songLoops.indexOf(this.active);
      if (i >= 0) { this.songLoops.splice(i, 1); this.emit('state', this.stateEvent()); }
    }
  };

  Server.prototype.on_set_section_cue = function (data) {
    var song = songByName(data.song_name);
    if (!song) { return; }
    var source = findSection(song, data.source_name, data.source_start_beats), target = findSection(song, data.target_name, data.target_start_beats);
    if (!source || !target) { return; }
    this.notify('cue');
    var list = this.cues[song.name] = this.cues[song.name] || [];
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].source_name === source.name && Math.abs(list[i].source_start_beats - source.position_beats) < 0.1) { list.splice(i, 1); } }
    list.push({ source_name: source.name, source_start_beats: source.position_beats, target_name: target.name, target_start_beats: target.position_beats });
    this.emit('state', this.stateEvent());
    this.emit('section_cue_changed', { song_name: song.name, source_name: source.name, source_start_beats: source.position_beats, target_name: target.name, target_start_beats: target.position_beats });
  };

  Server.prototype.on_clear_section_cue = function (data) {
    var list = this.cues[data.song_name] || [];
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].source_name === data.source_name && Math.abs(list[i].source_start_beats - data.source_start_beats) < 0.1) { list.splice(i, 1); } }
    this.emit('state', this.stateEvent());
    this.emit('section_cue_changed', { song_name: data.song_name, source_name: data.source_name, source_start_beats: data.source_start_beats, target_name: null, target_start_beats: null });
  };

  Server.prototype.on_toggle_chain_marker = function (data) {
    if (!songByName(data.name)) { return; }
    var i = this.chain.indexOf(data.name);
    if (i >= 0) { this.chain.splice(i, 1); } else { this.chain.push(data.name); }
    this.emit('state', this.stateEvent());
  };

  Server.prototype.on_toggle_song_loop = function (data) {
    var song = songByName(data.name);
    if (!song) { return; }
    var i = this.songLoops.indexOf(song.name);
    if (i >= 0) { this.songLoops.splice(i, 1); } else { this.songLoops.push(song.name); }
    this.emit('state', this.stateEvent());
    // le morceau tapé est celui qui est actif : la boucle est armée (ou relâchée) tout de suite, à l'arrêt comme en lecture. Même appel dans les deux sens (WebControlServer.toggle_song_loop).
    if (song.name === this.active) { this._cycleSong(song); }
  };

  Server.prototype.on_toggle_metronome = function (data) {
    this.metronome = data.enabled === undefined ? !this.metronome : !!data.enabled;
    this.emit('metronome_state', { enabled: this.metronome });
  };

  Server.prototype.on_cycle_preroll = function () {
    this.prerollMeasures = PREROLL_CYCLE[(PREROLL_CYCLE.indexOf(this.prerollMeasures) + 1) % PREROLL_CYCLE.length];
    this.emit('state', this.stateEvent());
  };

  Server.prototype.on_reorder_markers = function (data) {
    var order = (Array.isArray(data.order) ? data.order : []).filter(function (n, i, all) { return songByName(n) && all.indexOf(n) === i && this.visible.indexOf(n) >= 0; }, this);
    this.visible.forEach(function (n) { if (order.indexOf(n) < 0) { order.push(n); } });
    this.visible = order;
    this.emit('state', this.stateEvent());
  };

  Server.prototype.on_remove_marker = function (data) { this._remove([data.name]); };
  Server.prototype.on_remove_markers = function (data) { this._remove(Array.isArray(data.names) ? data.names : []); };
  /* retire des morceaux de la setlist visible (WebControlServer._remove_markers_from_setlist) : leurs drapeaux « par morceau » (chaînage, boucle de morceau, plan, cues) sont nettoyés ; la
     lecture et le morceau actif, eux, ne changent pas -- même quand c'est le morceau en cours qui disparaît de la grille. La setlist peut devenir vide. */
  Server.prototype._remove = function (names) {
    var self = this;
    names = names.filter(function (n) { return typeof n === 'string' && songByName(n); });
    this.visible = this.visible.filter(function (n) { return names.indexOf(n) < 0; });
    this.chain = this.chain.filter(function (n) { return names.indexOf(n) < 0; });
    this.songLoops = this.songLoops.filter(function (n) { return names.indexOf(n) < 0; });
    names.forEach(function (n) { delete self.plans[n]; delete self.cues[n]; });
    this.emit('state', this.stateEvent());
  };
  Server.prototype.on_add_marker = function (data) { this._add([data.name]); };
  Server.prototype.on_add_markers = function (data) { this._add(Array.isArray(data.names) ? data.names : []); };
  Server.prototype._add = function (names) {
    var self = this;
    names.forEach(function (n) { if (songByName(n) && self.visible.indexOf(n) < 0) { self.visible.push(n); } });
    this.emit('state', this.stateEvent());
  };

  // -------- mixeur
  Server.prototype.on_get_tracks = function () { this.notify('tracks'); this.emit('tracks_state', this.tracksPayload()); };
  Server.prototype.on_subscribe_track_meter = function (data) { this.meters[data.index] = true; };
  Server.prototype.on_unsubscribe_track_meter = function (data) { this.meters[data.index] = false; };
  Server.prototype.on_track_mute_toggle = function (data) {
    if (!this.trackState[data.index]) { return; }
    this.trackState[data.index].muted = !!data.muted;
    this.emit('track_mute_state', { index: data.index, muted: !!data.muted });
  };
  Server.prototype.on_track_solo_toggle = function (data) {
    if (!this.trackState[data.index]) { return; }
    this.trackState[data.index].soloed = !!data.soloed;
    this.emit('track_solo_state', { index: data.index, soloed: !!data.soloed });
  };
  Server.prototype.on_get_track_volume = function (data) {
    if (this.trackState[data.index]) { this.emit('track_volume_info', { index: data.index, volume: this.trackState[data.index].volume }); }
  };
  Server.prototype.on_set_track_volume = function (data) {
    if (!this.trackState[data.index]) { return; }
    this.trackState[data.index].volume = Math.max(0, Math.min(1, Number(data.volume)));
    this.emit('track_volume_info', { index: data.index, volume: this.trackState[data.index].volume });
  };
  Server.prototype.on_toggle_mixer_track_pin = function (data) {
    var i = this.pinned.indexOf(data.name);
    if (i >= 0) { this.pinned.splice(i, 1); } else { this.pinned.push(data.name); }
    this.emit('state', this.stateEvent());
  };
  function unit(value) { return Math.max(0, Math.min(1, Number(value))); }
  Server.prototype.on_get_master_volume = function () { this.emit('master_volume_info', { volume: this.master.volume }); };
  Server.prototype.on_get_master_cue_volume = function () { this.emit('master_cue_volume_info', { volume: this.master.cue }); };
  Server.prototype.on_set_master_volume = function (data) {
    if (typeof data.volume !== 'number' || !isFinite(data.volume)) { return; }
    this.master.volume = unit(data.volume);
    this.emit('master_volume_info', { volume: this.master.volume });
  };
  Server.prototype.on_set_master_cue_volume = function (data) {
    if (typeof data.volume !== 'number' || !isFinite(data.volume)) { return; }
    this.master.cue = unit(data.volume);
    this.emit('master_cue_volume_info', { volume: this.master.cue });
  };

  // -------- infos du show (Réglages) et plan de boucles enregistré en bloc (fenêtre d'appui long sur la grille)
  Server.prototype.on_update_show_info = function (data) {
    var info = this.show;
    ['band_name', 'venue', 'show_date', 'end_time'].forEach(function (key) { if (typeof data[key] === 'string') { info[key] = data[key].slice(0, 80); } });
    this.emit('show_info', { band_name: info.band_name, venue: info.venue, show_date: info.show_date });
    this.emit('end_time', { end_time: info.end_time || null });
    this.emit('show_info_update_result', { success: true });
  };
  Server.prototype.on_save_loop_plan = function (data) {
    var song = songByName(data.song_name);
    if (!song || !Array.isArray(data.entries)) { return; }
    var valid = [];
    data.entries.forEach(function (entry) {
      if (!entry || typeof entry.section_name !== 'string' || typeof entry.position_beats !== 'number' || ['x1', 'x2', 'infinite'].indexOf(entry.mode) < 0) { return; }
      var match = findSection(song, entry.section_name, entry.position_beats);
      if (match) { valid.push({ section_name: match.name, position_beats: match.position_beats, mode: entry.mode }); }
    });
    if (valid.length) { this.plans[song.name] = valid; } else { delete this.plans[song.name]; }
    this.emit('state', this.stateEvent());
    this.emit('loop_plan_song_changed', { song_name: song.name, entries: valid });
  };
  Server.prototype.on_check_pdf_export_allowed = function () { this.emit('pdf_export_allowed', { allowed: false }); };
  Server.prototype.on_list_presets = function () { this.emit('presets_info', { names: [] }); };

  // ------------------------------------------------------------------ prévision du transport (pour le son)
  /* Où ira la tête de lecture pendant les `horizon` prochaines secondes SI PERSONNE N'AGIT : la suite des tronçons continus que le simulateur va parcourir, avec les mêmes règles que _advanceTransport
     (fin de boucle, cue, morceau chaîné, arrêt). Le son (demo-audio.js) programme ses notes à l'avance d'après cette prévision : le retour au début d'une boucle ou un saut de cue tombent pile, sans à-coup.
     Une action du visiteur change la prévision au pas suivant : le son compare alors la nouvelle prévision à celle qu'il suivait et reprend là où elles divergent.
     Retour : {now, runs: [{t0, b0, t1, b1, song, loop, contiguous}]}. t0 / t1 : secondes de simulation (t1 === null : le tronçon se poursuit au-delà de l'horizon) ; b0 : position (en temps) à t0 ; b1 : position à t1 ;
     song : morceau actif au départ du tronçon ; loop : boucle armée à ce moment-là (copie) ; contiguous : le tronçon prolonge le précédent sans saut (changement d'état seulement : boucle relâchée, morceau chaîné).
     Pendant le pré-roll la prévision commence au VRAI démarrage de la musique : START_LATENCY_S avant la reprise que la tablette affiche (la première position vue est déjà ~1 temps après le début du morceau).
     Un PLAY annulé (STOP ou autre morceau choisi avant son engagement, voir _cancelPending) ne laisse rien à prévoir. Un morceau choisi APRÈS l'engagement saute à la fin du PLAY : la musique du morceau d'origine joue
     jusque-là, puis un nouveau tronçon part au début du morceau choisi. */
  Server.prototype.forecast = function (horizon) {
    var now = this.simNow, end = now + horizon, runs = [], t, pos;
    var active = this.active, loop = this.loop ? clone(this.loop) : null, cues = clone(this.cues[active] || []), stopAt = null, jumpAt = null, jumpTo = null;
    if (this.pending) {
      t = this.pending.at - START_LATENCY_S; pos = this.activeSong().start;
      if (this.pending.stopAfter) { stopAt = this.pending.at; }
      if (this.pending.jumpTo) { jumpAt = this.pending.at; jumpTo = this.pending.jumpTo; }       // un morceau choisi trop tard pour annuler le PLAY : la lecture y saute quand le PLAY est fini (voir _step)
    } else if (this.playing) {
      t = now; pos = this.position();
    } else {
      return { now: now, runs: runs };
    }
    var run = { t0: t, b0: pos, t1: null, b1: null, song: active, loop: clone(loop), contiguous: false };
    runs.push(run);
    var handled = {}, tie = false, armed = clone(this.autoArmed);
    function close(at, beat) { run.t1 = at; run.b1 = beat; }
    function open(at, beat, contiguous) { run = { t0: at, b0: beat, t1: null, b1: null, song: active, loop: clone(loop), contiguous: contiguous }; runs.push(run); }
    for (var guard = 0; guard < 24; guard++) {
      var song = songByName(active) || SONGS[0], candidates = [], i;
      /* même règle que le simulateur : un repère n'est franchi que s'il est encore DEVANT la position (prev < repère), même de 1e-13 -- sauf, juste après un franchissement sans saut, un autre repère au même endroit */
      function eligible(key, beat) { return beat > pos || (tie && Math.abs(beat - pos) <= 1e-9 && !handled[key]); }
      if (loop && eligible('L', loop.end)) { candidates.push({ kind: 0, key: 'L', beat: loop.end }); }
      for (i = 0; i < cues.length; i++) {
        var source = findSection(song, cues[i].source_name, cues[i].source_start_beats);
        if (source && eligible('C' + i, source.end_beats)) { candidates.push({ kind: 1, key: 'C' + i, beat: source.end_beats, cue: cues[i] }); }
      }
      var last = Math.min(END_BEAT, songEnd(song));
      if (!handled.S) { candidates.push({ kind: 2, key: 'S', beat: last }); }
      candidates.sort(function (a, b) { return a.beat - b.beat || a.kind - b.kind; });
      var c = candidates[0], tEv = t + (c.beat > pos ? secondsBetween(pos, c.beat) : 0);
      if (jumpAt !== null && jumpAt <= Math.min(end, tEv)) {            // comme _goToSong(jumpTo, true) : la boucle n'est oubliée que si le morceau change, les cues sont ceux du morceau choisi
        close(jumpAt, advance(pos, jumpAt - t));
        if (jumpTo !== active) { loop = null; }
        active = jumpTo; cues = clone(this.cues[active] || []); armed = {};
        t = jumpAt; pos = songByName(active).start; open(t, pos, false); handled = {}; tie = false; jumpAt = null; continue;
      }
      if (stopAt !== null && stopAt <= Math.min(end, tEv)) { close(stopAt, advance(pos, stopAt - t)); break; }
      if (tEv >= end) { break; }
      t = tEv; pos = c.beat;
      if (c.kind === 0) {                                                // fin de la boucle armée
        /* dans un pas du simulateur l'armement AUTOMATIQUE passe avant la fin de boucle : si la section qui suit a une boucle préparée, elle REMPLACE celle-ci et la lecture ne revient pas en arrière */
        var following = sectionAt(song, c.beat + 1e-6), akey = following ? song.name + '|' + following.position_beats : null;
        if (following && !armed[akey]) {
          var entry = this._planEntry(song, following);
          if (!entry || (loop.section_name === following.name && Math.abs(loop.start_beats - following.position_beats) <= 0.1)) { armed[akey] = true; }
          else {
            var forever = entry.mode === 'infinite';
            loop = { section_name: following.name, start_beats: following.position_beats, end: following.end_beats, mode: forever ? 'infinite' : 'fixed', remaining: forever ? null : (entry.mode === 'x2' ? 2 : 1), releasing: false };
            armed[akey] = true;
            close(t, pos); open(t, pos, true); handled = {}; tie = false; continue;
          }
        }
        if (loop.releasing) { loop = null; handled.L = true; tie = true; close(t, pos); open(t, pos, true); continue; }
        var back = loop.start_beats;
        if (loop.mode === 'fixed') { loop.remaining -= 1; if (loop.remaining <= 0) { loop = null; } }
        close(t, pos); pos = back; open(t, pos, false); handled = {}; tie = false; continue;
      }
      if (c.kind === 1) {                                                // cue de section : saut au début de la cible, le cue est consommé
        cues.splice(cues.indexOf(c.cue), 1);
        close(t, pos); pos = c.cue.target_start_beats; open(t, pos, false); handled = {}; tie = false; continue;
      }
      if (c.beat >= END_BEAT - 1e-9) { close(t, pos); break; }           // fin du set
      var next = this.nextVisible(song.name);
      if (next && this.chain.indexOf(song.name) >= 0) {                  // morceau chaîné : la lecture continue sur le suivant de la setlist visible
        var target = songByName(next);
        loop = null; active = next; cues = clone(this.cues[next] || []);
        close(t, pos);
        if (target.start !== pos) { pos = target.start; open(t, pos, false); } else { open(t, pos, true); }
        handled = {}; tie = false; continue;
      }
      close(t, pos); break;                                              // pas chaîné (ou dernier de la setlist) : le transport s'arrête à la frontière
    }
    return { now: now, runs: runs.filter(function (r) { return r.t1 === null || r.t1 - r.t0 > 1e-9; }) };       // un tronçon de durée nulle (deux franchissements au même instant) n'apporte rien
  };

  // ------------------------------------------------------------------ export
  var server = new Server();
  global.MarkerListDemoServer = Server;
  global.MarkerListDemo = server;
  /* ce que le son (demo-music.js, demo-audio.js) a besoin de connaître du jeu de démonstration : mêmes morceaux, mêmes tempos, mêmes conversions temps <-> secondes que le simulateur */
  global.MarkerListDemoCore = { SONGS: SONGS, TRACKS: TRACKS, SIGNATURE: SIGNATURE, SONG_BEATS: SONG_BEATS, END_BEAT: END_BEAT, START_LATENCY_S: START_LATENCY_S, PREROLL_ANNOUNCE_S: PREROLL_ANNOUNCE_S, VOICE_LEAD_BARS: VOICE_LEAD_BARS, advance: advance, secondsBetween: secondsBetween, songAt: songAt, sectionsOf: sectionsOf };
})(window);
