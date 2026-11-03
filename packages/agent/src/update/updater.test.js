import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managedMetaPath,
  readManagedMeta,
  writeManagedMeta,
  needsUpdate,
  sha256Hex,
  normalizeServerUrl,
} from './updater.js';

test('normalizeServerUrl requires a scheme (installers may record a bare host)', () => {
  assert.equal(normalizeServerUrl('mvc.example.com'), 'https://mvc.example.com');
  assert.equal(normalizeServerUrl('https://mvc.example.com'), 'https://mvc.example.com');
  assert.equal(normalizeServerUrl('http://mvc.example.com'), 'http://mvc.example.com');
});

test('needsUpdate is false when current matches the server sha', () => {
  assert.equal(needsUpdate('abc', 'abc'), false);
});

test('needsUpdate is true when they differ, false when server sha empty', () => {
  assert.equal(needsUpdate('abc', 'def'), true);
  assert.equal(needsUpdate('abc', ''), false);
  assert.equal(needsUpdate(null, 'def'), true);
});

test('sha256Hex matches node crypto for the same bytes', () => {
  const bytes = new TextEncoder().encode('hello mvc');
  assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
});

test('managed meta round-trips through MVC_MANAGED_DIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mvc-upd-'));
  process.env.MVC_MANAGED_DIR = dir;
  try {
    assert.equal(await readManagedMeta(), null);
    await writeManagedMeta({ sourceSha256: 'deadbeef', builtAt: 't0', installedAt: 't1', serverUrl: 'https://x' });
    assert.equal(managedMetaPath(), join(dir, 'meta.json'));
    const meta = await readManagedMeta();
    assert.equal(meta?.sourceSha256, 'deadbeef');
    assert.equal(meta?.serverUrl, 'https://x');
  } finally {
    delete process.env.MVC_MANAGED_DIR;
  }
});