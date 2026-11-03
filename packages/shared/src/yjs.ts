// Pure Yjs helpers for live sync (M3: CRDT merge + persistence).
//
// Every text file in a lobby is mirrored as a Y.Doc with a single Y.Text field
// named TEXT_FIELD. Sync works like a production Yjs relay (y-websocket):
//
//  1. BASELINE — the server persists the merged full state per path
//     (`fullStateOf(doc)`); every device builds its mirror for a path by
//     applying that SAME blob, so all devices share identical item structure
//     and client IDs. That is what makes later deltas resolve their anchors.
//     (A device that only has plain text — legacy files — sends full state
//     instead of a delta on its first edit, establishing the shared lineage.)
//  2. DELTAS — local edits are expressed with replaceText(): a line-anchored
//     diff (common prefix/suffix preserved) emitted as granular transactions —
//     a delete transaction, then an insert transaction. Granular ops relay
//     correctly (a single delete-all+insert-all transaction does NOT: the new
//     items re-anchor to the deleted lineage and land at the end on remote
//     receivers — see yjs.test.ts). Each returned Uint8Array is a transaction
//     update sent to the lobby DO, which merges it into the path's doc and
//     relays it to the other devices.
//  3. ECHO GUARD — after a remote update is applied, the file on disk equals
//     the mirror's text, so a local change event re-reading the file finds no
//     difference and replaceText() returns no updates. No ping-pong.
//
// mergeTextEdits() is the M3 acceptance proof: N writers edit the same starting
// text simultaneously; every chunk survives.

import * as Y from 'yjs';

/** The single Y.Text field name every file doc uses. */
export const TEXT_FIELD = 'content';

/** Create a doc carrying `initial` text (used for plain-text baselines). */
export function createTextDoc(initial: string = ''): Y.Doc {
  const doc = new Y.Doc();
  if (initial) doc.getText(TEXT_FIELD).insert(0, initial);
  return doc;
}

/** The doc's current text. */
export function textOf(doc: Y.Doc): string {
  return doc.getText(TEXT_FIELD).toString();
}

/**
 * Overwrite the doc's text with `next`, expressed as granular transactions:
 * first a delete transaction for the replaced region, then an insert
 * transaction. Returns the transaction updates (0, 1, or 2 Uint8Arrays) —
 * each is a self-contained Yjs update to relay to the server.
 *
 * The replaced region is the text between the common prefix and the common
 * suffix (compared line-by-line), so a one-line edit produces a tiny delta
 * while a whole-file rewrite still relays correctly.
 */
export function replaceText(doc: Y.Doc, next: string): Uint8Array[] {
  const cur = textOf(doc);
  if (cur === next) return [];
  const { delFrom, delLen, insText } = diffRegions(cur, next);
  const updates: Uint8Array[] = [];
  const t = doc.getText(TEXT_FIELD);
  const onUpdate = (u: Uint8Array) => updates.push(u);
  doc.on('update', onUpdate);
  try {
    if (delLen > 0) t.delete(delFrom, delLen);
    if (insText) t.insert(delFrom, insText);
  } finally {
    doc.off('update', onUpdate);
  }
  return updates;
}

/**
 * The region of `cur` to delete and text to insert at that offset, such that
 * `cur` becomes `next`. Common prefix/suffix lines are preserved, so a small
 * edit produces a small operation. Offsets are true character indices computed
 * from line starts, so newline placement stays exact.
 */
export function diffRegions(
  cur: string,
  next: string,
): { delFrom: number; delLen: number; insText: string } {
  if (cur === next) return { delFrom: 0, delLen: 0, insText: '' };
  const oldLines = cur.split('\n');
  const newLines = next.split('\n');
  const oldIdx = lineStarts(oldLines, cur.length);
  const newIdx = lineStarts(newLines, next.length);

  let p = 0;
  while (
    p < oldLines.length &&
    p < newLines.length &&
    oldLines[p] === newLines[p]
  ) {
    p += 1;
  }
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  ) {
    s += 1;
  }

  // The line-count loops above guarantee p ≤ oldLines.length (and ≤ newLines
  // length) and s ≤ oldLines.length - p, so every index below is in range.
  const delFrom = oldIdx[p]!;
  const delEnd = oldIdx[oldLines.length - s]!;
  const insStart = newIdx[p]!;
  const insEnd = newIdx[newLines.length - s]!;
  return {
    delFrom,
    delLen: delEnd - delFrom,
    insText: next.substring(insStart, insEnd),
  };
}

/** Char index where each line starts (index for `i` up to lines.length). */
function lineStarts(lines: string[], textLength: number): number[] {
  const idx: number[] = [];
  let at = 0;
  for (let i = 0; i < lines.length; i += 1) {
    idx.push(at);
    at += lines[i]!.length + 1; // +1 separator, possibly beyond a trailing '\n'
  }
  idx.push(textLength); // position just past the last line
  return idx;
}

/** Apply a remote Yjs update; returns the resulting text. */
export function applyTextUpdate(doc: Y.Doc, update: Uint8Array): string {
  Y.applyUpdate(doc, update);
  return textOf(doc);
}

/** Full-state snapshot of a doc — the baseline blob the server persists. */
export function fullStateOf(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * M3 acceptance proof: N writers each edit the same starting text
 * concurrently; every chunk must survive the merge — exactly what happens when
 * three devices send updates to the lobby DO at once.
 *
 * Faithful to the real flow: every writer (and the hub) first applies the SAME
 * baseline full-state blob, so origin anchors resolve; then each writer's
 * transaction updates (from replaceText) are applied to the hub.
 *
 * @param initial  e.g. "A B C"
 * @param edits    each writer's *full* resulting text, e.g. ["A X B C", "A B Y C", "A B C Z"]
 */
export function mergeTextEdits(args: {
  initial: string;
  edits: string[];
}): { merged: string; updateCount: number } {
  const { initial, edits } = args;
  // Shared baseline lineage (the server's persisted full state).
  const baseline = new Y.Doc();
  baseline.getText(TEXT_FIELD).insert(0, initial);
  const baselineState = Y.encodeStateAsUpdate(baseline);

  const hub = new Y.Doc();
  Y.applyUpdate(hub, baselineState);
  let updateCount = 0;
  for (const text of edits) {
    if (text === initial) continue;
    const writer = new Y.Doc();
    Y.applyUpdate(writer, baselineState);
    for (const update of replaceText(writer, text)) {
      Y.applyUpdate(hub, update);
      updateCount += 1;
    }
  }
  return { merged: textOf(hub), updateCount };
}