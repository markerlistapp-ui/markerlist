/* try.js : page « essai en ligne ». Chargée par les pages try*.html après site.js (consentement, suivi des téléchargements, langues : voir app.js).
   La démo est la VRAIE page tablette de l'application, servie par ce site (demo/tablet.html) et pilotée par un simulateur JavaScript qui tourne dans l'iframe : aucune requête réseau,
   rien n'est envoyé ni enregistré. Le son (les trois morceaux et les annonces vocales, joués par le navigateur du visiteur : demo-music.js, demo-audio.js, demo-voice.js dans le paquet de la démo) est activé par défaut -- il ne démarre de toute façon qu'au PLAY du visiteur --
   et se coupe avec le bouton « Son ». Cette page ne fait que charger la démo au clic (comme la façade YouTube de la page d'accueil), la mettre à l'échelle ou en plein écran, régler le son et compter l'usage. */
(function () {
  'use strict';
  var d = document, w = window;
  var stage = d.getElementById('try-stage');
  if (!stage) { return; }
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var T = {};
  try { T = JSON.parse(($('#i18n') || {}).textContent || '{}'); } catch (e) { T = {}; }

  var SRC = stage.getAttribute('data-src') + '?lang=' + stage.getAttribute('data-lang') + '&v=' + stage.getAttribute('data-v');
  var VW = 1024, VH = 768;                       /* taille « tablette paysage » dans laquelle la page est affichée, puis mise à l'échelle du cadre */
  var screen = $('.try-screen', stage), poster = $('#try-start', stage), bar = $('.try-bar', stage), tools = $('.try-tools', stage);
  var wide = w.matchMedia('(min-width: 901px)');
  var iframe = null;
  var inertRoots = [];
  var themeMeta = d.querySelector('meta[name="theme-color"]'), themeBefore = themeMeta ? themeMeta.getAttribute('content') : null;
  var soundBtns = [d.getElementById('try-sound'), d.getElementById('try-sound-full')].filter(Boolean);
  var soundWanted = true;                                         /* le choix du visiteur ; il survit à « Recommencer » (une nouvelle page tablette = un nouveau contexte audio) */
  var setBarColor = function (full) { if (themeMeta && themeBefore !== null) { themeMeta.setAttribute('content', full ? '#0B0B0D' : themeBefore); } };   /* barre d'état et barre d'adresse des téléphones */

  var track = function (name, extra) {
    w.dataLayer = w.dataLayer || [];
    var o = { event: name, page_language: d.documentElement.lang || '' };
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { o[k] = extra[k]; } }
    w.dataLayer.push(o);
  };

  var isFull = function () { return stage.classList.contains('is-full'); };

  /* l'iframe garde la taille d'une tablette et se met à l'échelle de l'écran du cadre ; en plein écran elle prend toute la place, sans échelle */
  var scale = function () {
    if (!iframe || isFull()) { iframe && (iframe.style.transform = ''); return; }
    iframe.style.transform = 'scale(' + (screen.clientWidth / VW) + ')';
  };

  /* le son vit dans la page tablette (même origine) : on lui parle directement, DEPUIS le geste du visiteur (règle des navigateurs : un son ne démarre qu'après un geste) */
  var soundApi = function () {
    try {
      var api = iframe && iframe.contentWindow && iframe.contentWindow.MarkerListDemoAudio;
      return api && api.supported() ? api : null;
    } catch (e) { return null; }
  };
  var showSound = function (on) { soundBtns.forEach(function (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); };
  var applySound = function () {
    var api = soundApi();
    soundBtns.forEach(function (b) { b.hidden = !api; });         /* navigateur sans Web Audio : pas de bouton */
    if (!api) { return; }
    if (soundWanted) { api.enable(); } else { api.disable(); }
    showSound(soundWanted);
  };
  var freeSound = function () { var api = soundApi(); if (api && api.dispose) { api.dispose(); } };      /* ferme le contexte audio avant de retirer l'iframe (iPhone : 4 contextes au plus) */
  var toggleSound = function () {
    soundWanted = !soundWanted;
    var api = soundApi();
    if (api) { if (soundWanted) { api.enable(); } else { api.disable(); } }
    showSound(soundWanted);
    track('demo_sound', { on: soundWanted });
  };

  var build = function () {
    iframe = d.createElement('iframe');
    iframe.className = 'try-iframe';
    iframe.src = SRC;
    iframe.title = stage.getAttribute('data-title') || '';
    /* pas d'attribut sandbox : la page tablette est notre propre fichier, servi par ce site, et elle a besoin de son stockage local ; « allow-scripts allow-same-origin » ne protège de rien (Chrome le signale en avertissement) */
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.width = VW; iframe.height = VH;
    iframe.addEventListener('load', applySound);
    screen.appendChild(iframe);
    poster.hidden = true;
    scale();
  };

  /* pendant le plein écran, le reste de la page ne reçoit ni focus ni lecteur d'écran */
  var setInert = function (on) {
    if (on) {
      inertRoots = [];
      Array.prototype.slice.call(d.body.children).forEach(function (el) {
        if (el.tagName === 'SCRIPT' || el.contains(stage)) { return; }
        el.setAttribute('inert', ''); inertRoots.push(el);
      });
      Array.prototype.slice.call($('main').children).forEach(function (el) {
        if (el.contains(stage)) { return; }
        el.setAttribute('inert', ''); inertRoots.push(el);
      });
      Array.prototype.slice.call(stage.parentNode.children).forEach(function (el) {       /* ce qui entoure la scène dans sa section (la légende) */
        if (el === stage) { return; }
        el.setAttribute('inert', ''); inertRoots.push(el);
      });
    } else {
      inertRoots.forEach(function (el) { el.removeAttribute('inert'); });
      inertRoots = [];
    }
  };

  var enterFull = function (how) {
    if (isFull()) { return; }
    stage.classList.add('is-full');
    stage.setAttribute('role', 'dialog'); stage.setAttribute('aria-modal', 'true'); stage.setAttribute('aria-label', stage.getAttribute('data-title') || '');
    d.documentElement.classList.add('try-lock');
    setBarColor(true);
    bar.hidden = false; tools.hidden = true;
    setInert(true);
    scale();
    var back = $('#try-back', stage); if (back) { back.focus(); }
    track('demo_full', { how: how || 'button' });
  };

  var exitFull = function () {
    if (!isFull()) { return; }
    stage.classList.remove('is-full');
    stage.removeAttribute('role'); stage.removeAttribute('aria-modal'); stage.removeAttribute('aria-label');
    d.documentElement.classList.remove('try-lock');
    setBarColor(false);
    bar.hidden = true;
    setInert(false);
    if (wide.matches) { tools.hidden = false; scale(); }
    else { close(); }                                           /* petit écran : fermer le plein écran ferme la démo (retour à l'affiche) */
    track('demo_close');
  };

  var close = function () {
    freeSound();
    if (iframe) { iframe.parentNode.removeChild(iframe); iframe = null; }
    poster.hidden = false; tools.hidden = true;
    poster.focus();
  };

  var restart = function () {
    if (!iframe) { return; }
    freeSound();
    iframe.parentNode.removeChild(iframe); iframe = null;
    build();
    iframe.focus();
    track('demo_restart');
  };

  var start = function () {
    track('demo_start', { mode: wide.matches ? 'inline' : 'full' });
    build();
    if (wide.matches) { tools.hidden = false; iframe.focus(); }
    else { enterFull('small-screen'); }
  };

  poster.addEventListener('click', start);
  var el;
  if ((el = $('#try-start-top'))) { el.addEventListener('click', function () { if (!iframe) { stage.scrollIntoView({ behavior: 'smooth', block: 'start' }); start(); } else if (!isFull()) { stage.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }); }
  if ((el = $('#try-full'))) { el.addEventListener('click', function () { enterFull('button'); }); }
  if ((el = $('#try-back'))) { el.addEventListener('click', exitFull); }
  if ((el = $('#try-restart'))) { el.addEventListener('click', restart); }
  if ((el = $('#try-restart-full'))) { el.addEventListener('click', restart); }
  soundBtns.forEach(function (b) { b.addEventListener('click', toggleSound); });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isFull()) { exitFull(); } });
  w.addEventListener('resize', function () {
    if (iframe && !isFull() && !wide.matches) { enterFull('rotation'); }       /* tablette qu'on tourne en portrait : la démo passe en plein écran */
    scale();
  });
  if (w.ResizeObserver) { new w.ResizeObserver(scale).observe(screen); }

  /* mesure d'usage : l'iframe est de la même origine et prévient la page à la première utilisation de chaque fonction (voir demo-engine.js, notify) ; rien ne quitte le navigateur d'ici */
  w.addEventListener('message', function (e) {
    var m = e.data;
    if (e.origin !== w.location.origin || !m || m.source !== 'markerlist-demo') { return; }
    if (['open', 'play', 'jump', 'loop', 'cue', 'tracks'].indexOf(m.event) >= 0) { track('demo_' + m.event); }
    if (m.event === 'sound') { showSound(!!m.on); }                                   /* l'état réel du son (le contexte audio a pu refuser de démarrer) */
  });

  /* appel à l'essai : sur téléphone ou tablette le .dmg et l'installeur ne servent à rien, les boutons mènent à la page d'accueil (même logique que app.js) */
  (function () {
    var mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!mobile) { return; }
    var home = stage.getAttribute('data-home') || 'index.html';
    var win = d.getElementById('try-dl-win'); if (win) { win.hidden = true; }
    var mac = d.getElementById('try-dl-mac');
    if (mac) { mac.setAttribute('href', home + '#discovery'); if (T.mobile_hero) { mac.textContent = T.mobile_hero; } }
    var nav = d.getElementById('try-nav-dl');
    if (nav) { nav.setAttribute('href', home + '#discovery'); if (T.mobile_nav) { nav.textContent = T.mobile_nav; } }
  })();
})();
