/* demo-socket.js -- remplace socket.io dans la DÉMO WEB de MarkerList.
 *
 * La page est la VRAIE page tablette de l'application (exportée par tools/export_web_demo.py) : elle appelle `io(...)` puis `socket.on(...)` / `socket.emit(...)`. Ici, `io()` ne
 * touche aucun réseau : il renvoie un objet « socket » relié au simulateur qui tourne dans le même onglet (demo-engine.js, window.MarkerListDemo). Rien n'est envoyé nulle part.
 *
 * Contrat repris de socket.io (client) pour la partie utilisée par la page : on, once, off, emit, volatile.emit, connected, id, connect, disconnect. Les messages sont COPIÉS (JSON) et
 * livrés de façon asynchrone ET DANS L'ORDRE où ils ont été envoyés, comme sur un vrai réseau : le simulateur et la page ne partagent jamais d'objet.
 */
(function () {
  'use strict';

  /* Garde-fou « rien ne sort du navigateur » : cette page n'a aucune raison d'émettre une requête (son seul fetch() sert à l'export PDF, absent de la démo, et le simulateur tourne
   * dans le même onglet). Si un jour un chemin de code en tentait une, elle échouerait ici au lieu de partir. */
  function refuse() { throw new Error('démo MarkerList : aucun accès réseau'); }
  try { window.fetch = function () { return Promise.reject(new Error('démo MarkerList : aucun accès réseau')); }; } catch (error) { /* tant pis */ }
  try { window.XMLHttpRequest = refuse; } catch (error) { /* tant pis */ }
  try { window.WebSocket = refuse; } catch (error) { /* tant pis */ }
  try { window.EventSource = refuse; } catch (error) { /* tant pis */ }
  try { if (navigator.sendBeacon) { navigator.sendBeacon = function () { return false; }; } } catch (error) { /* tant pis */ }

  /* Une file d'attente par sens : chaque minuterie défile la TÊTE de la file, quelle que soit la minuterie qui sonne la première, donc les messages arrivent dans l'ordre où ils sont partis.
   * Un setTimeout(…, 0) par message ne le garantit pas : Chrome ralentit à 4 ms les minuteries créées depuis une minuterie imbriquée (le pas de 20 ms du simulateur, qui émet les messages
   * périodiques) mais pas celles créées depuis un évènement de la page. La réponse à un appui sur CLICK doublait ainsi le message « clic actif » émis un instant avant elle, et celui-ci, périmé,
   * avait le dernier mot : le clic était coupé, le bouton restait allumé jusqu'au message suivant (une seconde plus tard). */
  function ordered() {
    var queue = [];
    return function (task) {
      queue.push(task);
      setTimeout(function () { queue.shift()(); }, 0);
    };
  }

  function Socket(options) {
    var self = this;
    this._handlers = {};
    this._toPage = ordered();
    this._toServer = ordered();
    this.connected = false;
    this.disconnected = true;
    this.id = 'demo-' + Math.random().toString(36).slice(2, 10);
    this.io = { opts: options || {}, on: function () { return self.io; }, off: function () { return self.io; } };
    this.volatile = { emit: function (name, data) { self.emit(name, data); return self; } };
  }

  Socket.prototype.on = function (name, handler) {
    (this._handlers[name] = this._handlers[name] || []).push(handler);
    return this;
  };

  Socket.prototype.once = function (name, handler) {
    var self = this;
    function wrapper(data) { self.off(name, wrapper); handler(data); }
    wrapper._original = handler;
    return this.on(name, wrapper);
  };

  Socket.prototype.off = function (name, handler) {
    if (!name) { this._handlers = {}; return this; }
    if (!handler) { delete this._handlers[name]; return this; }
    this._handlers[name] = (this._handlers[name] || []).filter(function (h) { return h !== handler && h._original !== handler; });
    return this;
  };

  /* livraison d'un message du « serveur » vers la page */
  Socket.prototype._deliver = function (name, payload) {
    var self = this;
    var copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
    this._toPage(function () {
      (self._handlers[name] || []).slice().forEach(function (handler) {
        try { handler(copy); } catch (error) { if (window.console) { console.error('[démo] gestionnaire de « ' + name + ' » :', error); } }
      });
    });
  };

  /* envoi de la page vers le « serveur » (le dernier argument fonction, un accusé de réception, est ignoré comme le fait la page) */
  Socket.prototype.emit = function (name, data) {
    var server = window.MarkerListDemo;
    if (!this.connected || !server) { return this; }
    var copy = (data === undefined || typeof data === 'function') ? undefined : JSON.parse(JSON.stringify(data));
    this._toServer(function () { server.fromClient(name, copy); });
    return this;
  };

  Socket.prototype.connect = function () {
    var self = this;
    if (this.connected) { return this; }
    setTimeout(function () {
      self.connected = true;
      self.disconnected = false;
      var server = window.MarkerListDemo;
      if (server) { server.attach(self); }
      (self._handlers.connect || []).slice().forEach(function (handler) { try { handler(); } catch (error) { if (window.console) { console.error('[démo] connect :', error); } } });
      if (server) { server.greet(self); }
    }, 30);
    return this;
  };

  Socket.prototype.disconnect = function () {
    if (!this.connected) { return this; }
    this.connected = false;
    this.disconnected = true;
    var server = window.MarkerListDemo;
    if (server) { server.detach(this); }
    (this._handlers.disconnect || []).slice().forEach(function (handler) { try { handler('io client disconnect'); } catch (error) { if (window.console) { console.error('[démo] disconnect :', error); } } });
    return this;
  };

  window.io = function (options) {
    var socket = new Socket(options);
    socket.connect();
    return socket;
  };
})();
