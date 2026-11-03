// M3: CRDT merge + echo-guard tests for the pure Yjs helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  applyTextUpdate,
  createTextDoc,
  diffRegions,
  fullStateOf,
  mergeTextEdits,
  replaceText,
  textOf,
} from './yjs.ts';

test('mergeTextEdits: three concurrent writers, every chunk survives', () => {
  const initial = 'console.log("hello world");';
  // Three writers edit the same line simultaneously (M3 acceptance: A + B + C
  // edit the same file at once).
  const edits = [
    '// A: add a comment\nconsole.log("hello world");',
    'console.log("hello brave new world");',
    'console.log("hello world");\n// C: footer note',
  ];
  const { merged, updateCount } = mergeTextEdits({ initial, edits });
  assert.ok(updateCount >= edits.length, `expected ≥1 update per writer, got ${updateCount}`);
  // Every writer's contribution survives the merge.
  assert.ok(merged.includes('A: add a comment'), 'A chunk lost');
  assert.ok(merged.includes('brave new'), 'B chunk lost');
  assert.ok(merged.includes('C: footer note'), 'C chunk lost');
  // The shared base is not duplicated by the merge.
  assert.equal(merged.split('console.log').length - 1, 1, 'base line duplicated');
});

test('shared baseline: relayed deltas apply cleanly on a remote device', () => {
  // The orphan-drop scenario: a delete-all + insert-all in ONE transaction
  // re-anchors the insert to the deleted lineage and lands at the end on remote
  // receivers. replaceText() splits into delete + insert transactions, which
  // relay correctly — this is the everyday A→B edit path.
  const baseline = createTextDoc('one\ntwo\n');
  const baselineState = fullStateOf(baseline);

  const writer = new Y.Doc();
  Y.applyUpdate(writer, baselineState);
  const tx = replaceText(writer, 'one\ntwo\nthree\n');
  assert.ok(tx.length >= 1, 'expected ≥1 transaction update');
  assert.equal(textOf(writer), 'one\ntwo\nthree\n');

  const receiver = new Y.Doc();
  Y.applyUpdate(receiver, baselineState);
  for (const update of tx) applyTextUpdate(receiver, update);
  // Exactly the new text — no duplicated old content.
  assert.equal(textOf(receiver), 'one\ntwo\nthree\n');
});

test('whole-file rewrite relays cleanly too', () => {
  const baseline = createTextDoc('old file contents\n');
  const baselineState = fullStateOf(baseline);

  const writer = new Y.Doc();
  Y.applyUpdate(writer, baselineState);
  const tx = replaceText(writer, 'brand new file');
  const receiver = new Y.Doc();
  Y.applyUpdate(receiver, baselineState);
  for (const update of tx) applyTextUpdate(receiver, update);
  assert.equal(textOf(receiver), 'brand new file');
});

test('replaceText: unchanged content returns no updates (echo guard)', () => {
  const doc = createTextDoc('hello');
  assert.deepEqual(replaceText(doc, 'hello'), []);
  assert.equal(textOf(doc), 'hello');
});

test('diffRegions: one-line edit yields a small region', () => {
  const cur = 'line1\nline2\nline3\n';
  const next = 'line1\nline2 EDITED\nline3\n';
  const d = diffRegions(cur, next);
  // The replaced region is the changed line including its newline.
  assert.equal(d.delFrom, 'line1\n'.length);
  assert.equal(d.delLen, 'line2\n'.length);
  assert.equal(d.insText, 'line2 EDITED\n');
  // Applying the diff to `cur` reproduces `next` exactly.
  assert.equal(cur.slice(0, d.delFrom) + d.insText + cur.slice(d.delFrom + d.delLen), next);
});

test('applyTextUpdate round-trips remote content', () => {
  const baseline = createTextDoc('remote content');
  const state = fullStateOf(baseline);
  const doc = new Y.Doc();
  applyTextUpdate(doc, state);
  assert.equal(textOf(doc), 'remote content');
});

test('Yjs tx updates are idempotent when re-applied (server dedupes naturally)', () => {
  const baseline = createTextDoc('a');
  const baselineState = fullStateOf(baseline);
  const writer = new Y.Doc();
  const rx = new Y.Doc();
  Y.applyUpdate(writer, baselineState);
  Y.applyUpdate(rx, baselineState);
  const tx = replaceText(writer, 'b');
  for (const u of tx) applyTextUpdate(rx, u);
  // Same update applied twice must not change the result (Yjs clock dedupe).
  for (const u of tx) applyTextUpdate(rx, u);
  assert.equal(textOf(rx), 'b');
});