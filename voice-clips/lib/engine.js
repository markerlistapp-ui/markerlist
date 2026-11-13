// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Main-thread side of the voice engine: a small promise API over the worker.

export class VoiceEngine {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.onProgress = null;
    this._ready = null;
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        if (this.onProgress) this.onProgress(m.loaded, m.total);
      } else if (m.type === "ready") {
        this._ready.resolve(m);
      } else if (m.type === "clip") {
        this.pending.get(m.id)?.resolve(m);
        this.pending.delete(m.id);
      } else if (m.type === "error") {
        const err = new Error(m.message);
        if (m.id !== undefined && this.pending.has(m.id)) {
          this.pending.get(m.id).reject(err);
          this.pending.delete(m.id);
        } else if (this._ready) {
          this._ready.reject(err);
        }
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "The voice engine could not start (worker error).");
      if (this._ready) this._ready.reject(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  /** Loads the model (92 MB the first time, then from the browser's cache). Resolves with timings. */
  load(options) {
    if (!this._ready) {
      this._ready = {};
      this._ready.promise = new Promise((resolve, reject) => {
        this._ready.resolve = resolve;
        this._ready.reject = reject;
      });
      this.worker.postMessage({ type: "load", ...options });
    }
    return this._ready.promise;
  }

  speak(text, voice, speed = 1) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "speak", id, text, voice, speed });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
