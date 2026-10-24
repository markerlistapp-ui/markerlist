(function () {
  'use strict';
  var d = document, w = window;
  d.documentElement.classList.add('js');
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };
  var T = {};
  try { T = JSON.parse(($('#i18n') || {}).textContent || '{}'); } catch (e) { T = {}; }
  var lang = (d.documentElement.lang || 'en').slice(0, 2).toLowerCase();

  /* 1. Consentement (même logique que l'ancien site : tout refusé par défaut, choix mémorisé sur l'appareil) */
  (function () {
    var KEY = 'ml_consent', stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) {}
    var updateConsent = function (granted) {
      if (typeof w.gtag !== 'function') { return; }
      w.gtag('consent', 'update', { 'analytics_storage': granted ? 'granted' : 'denied' });
    };
    var banner = $('#consentBanner');
    if (stored === 'accepted') { updateConsent(true); }
    else if (stored !== 'declined' && banner) { banner.hidden = false; }
    var accept = $('#consentAccept'), decline = $('#consentDecline');
    if (accept) { accept.addEventListener('click', function () { try { localStorage.setItem(KEY, 'accepted'); } catch (e) {} updateConsent(true); if (banner) { banner.hidden = true; } }); }
    if (decline) { decline.addEventListener('click', function () { try { localStorage.setItem(KEY, 'declined'); } catch (e) {} if (banner) { banner.hidden = true; } }); }
  })();

  /* 2. Téléphone et tablette : le .dmg ne s'installe pas. Les boutons de téléchargement mènent à l'essai (#discovery) et le bouton de l'essai
        propose d'envoyer à soi-même le lien de la page par e-mail (simple lien mailto : le site ne collecte rien). Reprise fidèle de l'ancien site. */
  (function () {
    var mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!mobile) { return; }
    ['try-free-hero-win', 'try-free-final-win', 'trial-download-win'].forEach(function (id) { var a = d.getElementById(id); if (a) { a.hidden = true; } });   /* un seul bouton « lien » sur téléphone */
    ['try-free-nav', 'try-free-hero', 'try-free-final'].forEach(function (id) {
      var a = d.getElementById(id);
      if (a) { a.setAttribute('href', '#discovery'); a.textContent = id === 'try-free-nav' ? T.mobile_nav : T.mobile_hero; }
    });
    var dl = d.getElementById('trial-download');
    if (dl) {
      var link = location.origin + location.pathname + '?utm_source=mobile_reminder&utm_medium=email_self&utm_campaign=send_link';
      dl.setAttribute('href', 'mailto:?subject=' + encodeURIComponent(T.mobile_subject) + '&body=' + encodeURIComponent(T.mobile_body + '\r\n\r\n' + link));
      dl.textContent = T.mobile_btn;
      var note = d.createElement('p');
      note.className = 'trial-note'; note.textContent = T.mobile_note;
      dl.parentNode.insertBefore(note, dl);
      dl.addEventListener('click', function () {
        w.dataLayer = w.dataLayer || [];
        w.dataLayer.push({ event: 'send_link_click', download_location: 'trial-download', page_language: d.documentElement.lang || '' });
      });
    }
  })();

  /* 3. Suivi des téléchargements (GTM) : chaque clic sur le .dmg ou sur l'installeur Windows envoie l'événement « download_click » (platform : mac ou windows) */
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$=".dmg"], a[href$=".exe"]');
    if (!a) { return; }
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ event: 'download_click', download_location: a.id || 'other', platform: /\.exe$/.test(a.getAttribute('href') || '') ? 'windows' : 'mac', page_language: d.documentElement.lang || '' });
  });

  /* 4. Vidéo : une façade, YouTube (youtube-nocookie) ne se charge qu'au clic */
  $$('.facade').forEach(function (f) {
    f.addEventListener('click', function (e) {
      if (f.hasAttribute('data-static')) { return; }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) { return; }
      e.preventDefault();
      var id = f.getAttribute('data-video'); if (!id) { return; }
      var fr = d.createElement('iframe');
      fr.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0';
      fr.title = f.getAttribute('data-title') || ''; fr.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; fr.allowFullscreen = true;
      fr.referrerPolicy = 'strict-origin-when-cross-origin'; fr.className = 'video-frame';
      f.parentNode.replaceChild(fr, f); fr.focus();
    });
  });

  /* 1b. Session vivante : UNE horloge pilote la tête de lecture d'Ableton et les deux interfaces (tablette, téléphone) */
  (function () {
  var stage = $('.stage');
  if (stage && $('.ui', stage)) {
    var abl = $('.abl', stage), head = $('.head', abl), brace = $('.live-brace', abl), tint = $('.live-tint', abl);
    var ablW = abl.clientWidth;                                    /* la tête de lecture se déplace par transformation (pas de mise en page à chaque image) */
    head.style.left = '0';
    w.addEventListener('resize', function () { ablW = abl.clientWidth; });
    var devices = $$('.ui', stage).map(function (el) {
      return { el: el, phone: el.classList.contains('phone'), rows: $$('.r', el), bars: $$('.bar i', el), rowsIn: $('.rows-in', el), beats: $$('.beats i', el),
        clock: $('[data-clock]', el), date: $('[data-date]', el), setrem: $('[data-setrem]', el), left: $('[data-left]', el) };
    });
    /* phases : section jouée, trajet de la tête de lecture dans l'image (fractions de la largeur), durée d'animation, état de la boucle de SOLO
       plan = armée d'avance (contour bleu), act = en cours (fond bleu, boucle Ableton), done = consommée */
    var PH = [
      { i: 0, x0: 0.2433, x1: 0.3505, s: 3.36, loop: '' }, { i: 1, x0: 0.3505, x1: 0.4591, s: 3.42, loop: '' }, { i: 2, x0: 0.4591, x1: 0.5677, s: 3.42, loop: '' },
      { i: 3, x0: 0.5677, x1: 0.6401, s: 2.26, loop: 'plan' }, { i: 4, x0: 0.6401, x1: 0.7878, s: 4.64, loop: 'plan' },
      { i: 5, x0: 0.7878, x1: 0.8588, s: 2.23, loop: 'act' }, { i: 5, x0: 0.7878, x1: 0.8588, s: 2.23, loop: 'done' }, { i: 6, x0: 0.8588, x1: 1.0, s: 4.43, loop: '' }
    ];
    var HOLD = 1.4, FADE = 0.28, ROW_H = 49, SOLO = 5, BPM_S = 60 / 98;
    var TOTAL = PH.reduce(function (a, p) { return a + p.s; }, 0) + HOLD;
    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var fmt = function (sec, hours) { var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return hours ? h + ':' + pad2(m) + ':' + pad2(s) : Math.floor(sec / 60) + ':' + pad2(s); };
    var lastSec = -1, lastKey = '';

    var apply = function (ph, u, t) {
      head.style.transform = 'translate3d(' + ((ph.x0 + (ph.x1 - ph.x0) * u) * ablW).toFixed(1) + 'px,0,0)';
      var solo = PH[5];
      brace.classList.toggle('on', ph.loop === 'act'); tint.classList.toggle('on', ph.loop === 'act');
      var key = ph.i + ph.loop;                                   /* classes des lignes : seulement quand la phase change */
      devices.forEach(function (d) {
        d.rows.forEach(function (r, k) {
          if (key !== lastKey) {
            r.classList.toggle('s-past', k < ph.i); r.classList.toggle('s-cur', k === ph.i);
            var armed = k === SOLO && (ph.loop === 'plan' || ph.loop === 'act');
            r.classList.toggle('s-plan', k === SOLO && ph.loop === 'plan'); r.classList.toggle('s-act', k === SOLO && ph.loop === 'act');
            $('.lp', r).innerHTML = armed ? '&times;1' : '&#x21BB;';
          }
          $('.fill', r).style.transform = 'scaleX(' + (k === ph.i ? u.toFixed(3) : 0) + ')';
        });
        d.bars.forEach(function (b, k) {
          if (key !== lastKey) { b.classList.toggle('s-past', k < ph.i); }
          $('b', b).style.transform = 'scaleX(' + (k === ph.i ? u.toFixed(3) : 0) + ')';
        });
        if (d.phone && key !== lastKey) { d.rowsIn.style.transform = 'translateY(calc(-' + Math.max(0, Math.min(ph.i - 1, 3)) * ROW_H + ' * var(--u)))'; }
        var beat = Math.floor(t / BPM_S) % 4;
        d.beats.forEach(function (b, k) { b.classList.toggle('on', k === beat); });
      });
      lastKey = key;
    };
    var clocks = function (t) {
      var sec = Math.floor(t);
      if (sec === lastSec) { return; }
      lastSec = sec;
      var now = new Date(), hms = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
      var iso = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
      devices.forEach(function (d) { d.clock.textContent = hms; d.date.textContent = iso; d.setrem.textContent = fmt(2468 - sec, false); d.left.textContent = fmt(35574 - sec, true); });
    };
    var render = function (t) {
      var acc = 0, ph = PH[PH.length - 1], u = 1;
      for (var k = 0; k < PH.length; k++) { if (t < acc + PH[k].s) { ph = PH[k]; u = (t - acc) / PH[k].s; break; } acc += PH[k].s; }
      apply(ph, u, t); clocks(t);
      var fade = t > TOTAL - FADE;
      abl.classList.toggle('rst', fade); devices.forEach(function (d) { d.el.classList.toggle('rst', fade); });
    };

    var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var t0 = 0, last = 0, raf = 0, visible = true;
    var frame = function (now) {
      raf = w.requestAnimationFrame(frame);
      var dt = Math.min(0.1, (now - last) / 1000); last = now; t0 += dt;
      if (t0 >= TOTAL) { t0 = 0; lastKey = ''; }
      render(t0);
    };
    var start = function () { if (!raf && visible && !d.hidden && !reduce) { last = w.performance.now(); raf = w.requestAnimationFrame(frame); } };
    var stop = function () { if (raf) { w.cancelAnimationFrame(raf); raf = 0; } };
    if (reduce) { lastKey = ''; render(PH[0].s + PH[1].s + PH[2].s + PH[3].s + PH[4].s + PH[5].s * 0.5); }   /* image fixe : SOLO, boucle en cours */
    else {
      render(0);
      if ('IntersectionObserver' in w) { new w.IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) { start(); } else { stop(); } }, { threshold: 0.05 }).observe(stage); }
      d.addEventListener('visibilitychange', function () { if (d.hidden) { stop(); } else { start(); } });
      start();
    }
  }
  })();


  /* 5. Section en cours : lien actif du menu + règle de repères sous la barre */
  var secs = $$('[data-loc]');
  var menuLinks = $$('.menu a');
  var maxScroll = function () { return Math.max(1, d.documentElement.scrollHeight - w.innerHeight); };
  var current = function () {
    var cur = -1;
    secs.forEach(function (s, i) { if (s.getBoundingClientRect().top <= w.innerHeight * 0.4) { cur = i; } });
    return cur;
  };
  var ruler = $('.ruler'), now = null, flags = [];
  if (ruler) {
    now = d.createElement('span'); now.className = 'now'; ruler.appendChild(now);
    flags = secs.map(function () { var f = d.createElement('i'); f.className = 'loc'; ruler.appendChild(f); return f; });
  }
  var layout = function () {
    if (!ruler) { return; }
    var max = maxScroll();
    flags.forEach(function (f, i) { f.style.left = Math.min(0.97, (secs[i].getBoundingClientRect().top + w.scrollY) / max) * ruler.clientWidth + 'px'; });
  };
  var tick = function () {
    var cur = current(), id = cur >= 0 ? '#' + secs[cur].id : '';
    menuLinks.forEach(function (a) { if (id && a.getAttribute('href') === id) { a.setAttribute('aria-current', 'location'); } else { a.removeAttribute('aria-current'); } });
    if (!ruler) { return; }
    var p = Math.min(1, Math.max(0, w.scrollY / maxScroll()));
    ruler.style.setProperty('--p', p.toFixed(4));
    now.textContent = cur >= 0 ? secs[cur].getAttribute('data-loc') : '';
    now.classList.toggle('flip', p > 0.7);
    flags.forEach(function (f, k) { f.classList.toggle('on', k === cur); });
  };
  var raf = 0;
  w.addEventListener('scroll', function () { if (!raf) { raf = w.requestAnimationFrame(function () { raf = 0; tick(); }); } }, { passive: true });
  w.addEventListener('resize', function () { layout(); tick(); });
  w.addEventListener('load', function () { layout(); tick(); });
  d.addEventListener('toggle', function () { layout(); tick(); }, true);
  layout(); tick();

  /* 6. Explorateur de fonctions : accordéon et capture synchronisée */
  var ex = $('.ex');
  if (ex) {
    var items = $$('.ex-item', ex), figs = $$('.ex-stack figure', ex);
    var open = function (i) {
      items.forEach(function (it, k) {
        var on = k === i, b = $('.ex-head', it);
        if (on) { it.setAttribute('data-active', ''); } else { it.removeAttribute('data-active'); }
        if (b) { b.setAttribute('aria-expanded', on ? 'true' : 'false'); }
      });
      figs.forEach(function (f, k) { if (k === i) { f.setAttribute('data-active', ''); } else { f.removeAttribute('data-active'); } });
      layout(); tick();
    };
    items.forEach(function (it, i) { var b = $('.ex-head', it); if (b) { b.addEventListener('click', function () { open(i); }); } });
    open(0);
  }

  /* 7. Pads : démonstration cliquable des 10 actions (mêmes règles de voyants que l'application) */
  var pads = $('.pads');
  if (pads) {
    var songs = ['Neon Skyline', 'Gravity', 'Paper Hearts', 'Wildfire', 'Golden Hour'];
    var LOOPS = ['', '×1', '×2', '∞'];
    var NEXT_PRE = { 1: 2, 2: 4, 4: 0, 0: 1 };
    var st = { playing: false, song: 1, songLoop: false, loop: 0, click: true, chain: false, pre: 1 };
    var pad = function (k) { return $('.pad[data-act="' + k + '"]', pads); };
    var lamp = function (k, on, sub) {
      var el = pad(k); if (!el) { return; }
      if (on) { el.setAttribute('data-on', ''); } else { el.removeAttribute('data-on'); }
      var s = $('.sub', el); if (s) { s.textContent = sub || ''; }
    };
    var bars = function (n) { return n ? n + ' ' + (n > 1 ? T.bars : T.bar) : T.off; };
    var out = $('#readout');
    var item = function (html) { var s = d.createElement('span'); s.innerHTML = html; return s; };
    var render = function () {
      lamp('play', st.playing); lamp('stop', !st.playing);
      lamp('previous', st.song > 0); lamp('next', st.song < songs.length - 1);
      lamp('loop_song', st.songLoop); lamp('loop_section', st.loop > 0, LOOPS[st.loop]);
      lamp('release', st.loop > 0 || st.songLoop);
      lamp('click', st.click); lamp('chain', st.chain);
      lamp('preroll', st.pre > 0, st.pre ? bars(st.pre) : '');
      if (out) {
        var loopText = st.loop ? T.loop_section + ' ' + LOOPS[st.loop] : (st.songLoop ? T.loop_song : T.loop_off);
        out.textContent = '';
        [['<b>' + (st.playing ? '▶ ' + T.playing : '■ ' + T.stopped) + '</b>'],
         [T.song + ' <b>' + songs[st.song] + '</b> ' + (st.song + 1) + '/' + songs.length],
         [T.loop + ' <b class="hot">' + loopText + '</b>'],
         [T.click + ' <b>' + (st.click ? T.on : T.off) + '</b>'],
         [T.preroll + ' <b>' + bars(st.pre) + '</b>']].forEach(function (p) { out.appendChild(item(p[0])); });
      }
    };
    var act = function (k) {
      if (k === 'play') { st.playing = true; }
      else if (k === 'stop') { st.playing = false; }
      else if (k === 'previous') { if (st.song > 0) { st.song--; st.loop = 0; st.songLoop = false; } }
      else if (k === 'next') { if (st.song < songs.length - 1) { st.song++; st.loop = 0; st.songLoop = false; } }
      else if (k === 'loop_song') { st.songLoop = !st.songLoop; }
      else if (k === 'loop_section') { st.loop = (st.loop + 1) % 4; }
      else if (k === 'release') { st.loop = 0; st.songLoop = false; }
      else if (k === 'click') { st.click = !st.click; }
      else if (k === 'chain') { st.chain = !st.chain; }
      else if (k === 'preroll') { st.pre = NEXT_PRE[st.pre]; }
    };
    pads.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.pad') : null; if (!b) { return; }
      act(b.getAttribute('data-act')); render();
    });
    render();
  }

  /* 8. Secours : « le Mac principal tombe » */
  var bk = $('.bk');
  if (bk) {
    var btn = $('#bk-btn'), main = $('.bk-main', bk), back = $('.bk-back', bk), msg = $('.bk-msg', bk), failed = false;
    var D = bk.dataset;
    var show = function () {
      main.setAttribute('data-s', failed ? 'down' : 'active'); back.setAttribute('data-s', failed ? 'active' : 'idle');
      $('.st b', main).textContent = failed ? D.stOffline : D.stActive;
      $('.st b', back).textContent = failed ? D.stTook : D.stStandby;
      msg.innerHTML = failed ? $('#bk-msg-failed').innerHTML : $('#bk-msg-normal').innerHTML;
      btn.textContent = failed ? D.btnReset : D.btn;
      bk.setAttribute('data-state', failed ? 'failed' : 'normal');
    };
    btn.addEventListener('click', function () { failed = !failed; show(); });
    show();
  }

  /* 9. Tableau comparatif : replié sur téléphone (ouvert par défaut sans JavaScript et sur ordinateur) */
  var cmp = $('.cmp-wrap');
  if (cmp && w.innerWidth < 700) { cmp.removeAttribute('open'); }

  /* 10. Le menu des langues se ferme au clic extérieur */
  d.addEventListener('click', function (e) {
    $$('.lang-menu[open]').forEach(function (m) { if (!m.contains(e.target)) { m.removeAttribute('open'); } });
  });
})();
