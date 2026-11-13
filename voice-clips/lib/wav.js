// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Clip post-processing and WAV writing (no dependency).

/** Mono clip, silence at both ends cut (60 ms margin below -45 dB of the peak), peak set to 0.95.
 *  The app normalises the level again when it loads a clip, so this is for tidiness, not for loudness. */
export function finalizeClip(x, sampleRate, { floorDb = -45, padSeconds = 0.06, peak = 0.95 } = {}) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  if (!(p > 0)) throw new Error("silent clip");
  const threshold = p * 10 ** (floorDb / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const pad = Math.floor(padSeconds * sampleRate);
  const y = x.slice(Math.max(0, first - pad), Math.min(x.length, last + pad));
  let m = 0;
  for (let i = 0; i < y.length; i++) {
    const a = Math.abs(y[i]);
    if (a > m) m = a;
  }
  const g = peak / m;
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}

/** 16-bit mono PCM WAV (RIFF) of a Float32Array in [-1, 1]. */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}
