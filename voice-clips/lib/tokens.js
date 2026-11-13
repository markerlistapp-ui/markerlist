// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Kokoro's tokenizer is a plain character lookup (115 symbols, tokenizer.json -> model.vocab). Characters that are not in it are dropped,
// exactly as the "Replace" normaliser of tokenizer.json does. The sequence is wrapped in the pad token (id 0) on both sides.

export const MAX_PHONEME_TOKENS = 510; // the model accepts 512 ids including the two pads

export function makeTokenizer(vocab) {
  return {
    /** -> { ids: number[] (with both pads), dropped: number, truncated: boolean } */
    encode(phonemes) {
      const ids = [];
      let dropped = 0;
      for (const ch of phonemes) {
        const id = vocab[ch];
        if (id === undefined) dropped++;
        else ids.push(id);
      }
      const truncated = ids.length > MAX_PHONEME_TOKENS;
      if (truncated) ids.length = MAX_PHONEME_TOKENS;
      return { ids: [0, ...ids, 0], dropped, truncated };
    },
  };
}

/** Which of the 510 style vectors of a voice goes with a sequence: the number of phoneme tokens, pads excluded. */
export function styleIndex(idsWithPads) {
  return Math.min(Math.max(idsWithPads.length - 2, 0), 509);
}

/** A voice file (.bin) is 510 x 256 float32 values; this returns the 256 values for one sequence length. */
export function styleVector(voiceFloats, idsWithPads) {
  const offset = 256 * styleIndex(idsWithPads);
  return voiceFloats.slice(offset, offset + 256);
}
