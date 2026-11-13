// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 MarkerList. Free software, with no warranty: see licenses/GPL-3.0.txt and credits.html.
// Reads an Ableton Live set (.als = gzip-compressed XML) entirely in the browser: nothing is uploaded anywhere.
//
// It reproduces what MarkerList itself sees through AbletonOSC (marker_engine.py), so that the names found here are the names the app will look for:
//   - SONGS   = the locators (cue points) of the arrangement, except the one named exactly END_LIVE (the last one, if there are several, is the end of the show), sorted by position;
//   - SECTIONS = the clips of the ARRANGEMENT of the FIRST track named exactly SECTION (a return track never counts). Clips of the session view and clips of take lanes are not seen
//     by the app (it asks for the arrangement clips), so they are ignored here as well. Each clip belongs to the last song whose locator is at or before it; a clip before the
//     first song, or at/after END_LIVE, belongs to nobody and is ignored, exactly as in marker_engine.resolve_section_track_sections.

export const MAX_XML_BYTES = 300e6; // beyond ~300 MB of XML a page can not hold the document comfortably (a JavaScript string tops out near 500 MB)

export class AlsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AlsError";
    this.code = code; // empty | too_big | unsupported | unreadable | not_a_set
  }
}

/** Decompresses a gzip buffer to text with the browser's own DecompressionStream. */
export async function gunzipToText(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function child(el, tag) {
  for (const c of el.children) if (c.tagName === tag) return c;
  return null;
}

function valueOf(el, tag) {
  const c = child(el, tag);
  return c ? c.getAttribute("Value") : null;
}

function locatorElements(liveSet) {
  const outer = child(liveSet, "Locators");
  const inner = outer ? child(outer, "Locators") : null;
  if (inner) return Array.from(inner.children).filter((c) => c.tagName === "Locator");
  if (outer) return Array.from(outer.getElementsByTagName("Locator"));
  return Array.from(liveSet.getElementsByTagName("Locator")); // an unusual layout: take them wherever they are
}

/** The clips of a track that sit in the main ARRANGEMENT (under ArrangerAutomation), and how many others it holds (session view, take lanes). */
function arrangementClips(track) {
  const kept = [];
  let outside = 0;
  for (const tag of ["MidiClip", "AudioClip"]) {
    for (const clip of Array.from(track.getElementsByTagName(tag))) {
      if (clip.closest("ArrangerAutomation")) kept.push(clip);
      else outside++;
    }
  }
  return { kept, outside };
}

/** Parses the XML text of a set. Throws an AlsError when it is not a Live set. Returns { songs, meta, warnings }. */
export function structureFromXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new AlsError("not_a_set", "This file is not a readable Ableton Live set (its content is not valid XML).");
  const root = doc.documentElement;
  const liveSet = root ? child(root, "LiveSet") : null;
  if (!liveSet) throw new AlsError("not_a_set", "This file does not look like an Ableton Live set (no LiveSet inside).");

  // ---- songs
  const locators = locatorElements(liveSet)
    .map((el, order) => ({ time: parseFloat(valueOf(el, "Time")), name: valueOf(el, "Name") ?? "", order }))
    .filter((l) => Number.isFinite(l.time))
    .sort((a, b) => a.time - b.time || a.order - b.order);
  const endTimes = locators.filter((l) => l.name === "END_LIVE").map((l) => l.time);
  const endTime = endTimes.length ? Math.max(...endTimes) : null;
  const songs = locators.filter((l) => l.name !== "END_LIVE").map((l) => ({ time: l.time, title: l.name, sections: [] }));

  // ---- sections
  const tracksEl = child(liveSet, "Tracks");
  const tracks = tracksEl ? Array.from(tracksEl.children).filter((t) => t.tagName !== "ReturnTrack") : [];
  const sectionTrack = tracks.find((t) => {
    const nameEl = child(t, "Name");
    const eff = nameEl ? child(nameEl, "EffectiveName") : null;
    return eff && eff.getAttribute("Value") === "SECTION";
  });
  let outside = 0;
  let before = 0;
  let after = 0;
  let blank = 0;
  let clipCount = 0;
  let attached = 0;
  if (sectionTrack) {
    const { kept, outside: out } = arrangementClips(sectionTrack);
    outside = out;
    const blocks = kept
      .map((clip, order) => ({ start: parseFloat(valueOf(clip, "CurrentStart")), name: (valueOf(clip, "Name") ?? "").trim(), order }))
      .filter((b) => Number.isFinite(b.start))
      .sort((a, b) => a.start - b.start || a.order - b.order);
    clipCount = blocks.length;
    for (const block of blocks) {
      if (endTime !== null && block.start >= endTime) {
        after++;
        continue;
      }
      let owner = null;
      for (const song of songs) {
        if (song.time <= block.start) owner = song;
        else break;
      }
      if (!owner) {
        before++;
        continue;
      }
      if (!block.name) {
        blank++;
        continue;
      }
      owner.sections.push(block.name);
      attached++;
    }
  }

  const warnings = [];
  if (!songs.length) warnings.push({ code: "no_locators" });
  if (songs.length && endTime === null) warnings.push({ code: "no_end_marker" });
  if (!sectionTrack) warnings.push({ code: "no_section_track" });
  if (outside) warnings.push({ code: "clips_outside_arrangement", count: outside });
  if (before || after) warnings.push({ code: "blocks_outside_range", before, after });
  if (blank) warnings.push({ code: "blank_section_names", count: blank });

  return {
    format: "markerlist-voix",
    version: 1,
    songs: songs.map(({ title, sections }) => ({ title, sections })),
    meta: {
      creator: root.getAttribute("Creator") || "",
      minorVersion: root.getAttribute("MinorVersion") || "",
      locators: locators.length,
      songs: songs.length,
      hasEndMarker: endTime !== null,
      sectionTrack: sectionTrack ? { kind: sectionTrack.tagName, clips: clipCount, attached, outsideArrangement: outside } : null,
      ignoredBeforeFirstSong: before,
      ignoredAfterEnd: after,
    },
    warnings,
  };
}

/** From a File / Blob / ArrayBuffer of a .als (an uncompressed XML file is accepted too). Throws an AlsError with a message fit for the user. */
export async function readAls(source) {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  if (!buffer.byteLength) throw new AlsError("empty", "This file is empty.");
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  const isGzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
  let text;
  if (isGzip) {
    // The last four bytes of a gzip file hold the size of what is inside (modulo 4 GB): enough to refuse a huge set before decompressing anything. Deflate can not shrink data by more than
    // 1032 to 1, so a "size" beyond that is not a size at all: the end of the file is damaged (a truncated download), and the attempt to decompress it will say so.
    const declared = buffer.byteLength >= 4 ? new DataView(buffer, buffer.byteLength - 4, 4).getUint32(0, true) : 0;
    if (declared > MAX_XML_BYTES && declared <= buffer.byteLength * 1032) throw new AlsError("too_big", `This set is too large to be read in a page (${Math.round(declared / 1e6)} MB of data). Type the names you need instead, or ask MarkerList for a list.`);
    if (typeof DecompressionStream === "undefined") throw new AlsError("unsupported", "This browser cannot open .als files. Use a recent Chrome, Edge, Firefox or Safari.");
    try {
      text = await gunzipToText(buffer);
    } catch (e) {
      throw new AlsError("unreadable", "This file is not a readable Ableton Live set (it could not be decompressed).");
    }
  } else {
    if (buffer.byteLength > MAX_XML_BYTES) throw new AlsError("too_big", `This set is too large to be read in a page (${Math.round(buffer.byteLength / 1e6)} MB).`);
    text = new TextDecoder().decode(buffer);
  }
  const struct = structureFromXml(text);
  struct.xmlBytes = text.length;
  return struct;
}
