import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectMcpTargets,
  installMcp,
  mergeMcpServers,
  mergeZedMcp,
} from './install.js';

test('mergeMcpServers adds/updates the mvc entry, keeping other servers', () => {
  const out = mergeMcpServers({ mcpServers: { other: { command: 'x' } } }, 'https://h/mcp', null);
  assert.deepEqual(out.mcpServers.other, { command: 'x' });
  assert.deepEqual(out.mcpServers.mvc, { type: 'http', url: 'https://h/mcp' });
});

test('mergeMcpServers attaches an Authorization header when a token is given', () => {
  const out = mergeMcpServers({}, 'https://h/mcp', { Authorization: 'Bearer t' });
  assert.deepEqual(out.mcpServers.mvc, {
    type: 'http',
    url: 'https://h/mcp',
    headers: { Authorization: 'Bearer t' },
  });
});

test('mergeZedMcp pushes/replaces a named entry in the mcp array', () => {
  const a = mergeZedMcp({ mcp: [{ name: 'z', url: 'u' }] }, 'https://h/mcp', null);
  assert.equal(a.mcp.length, 2);
  assert.ok(a.mcp.some((e) => e.name === 'mvc' && e.url === 'https://h/mcp'));
  const b = mergeZedMcp(a, 'https://h/mcp', { Authorization: 'Bearer t' });
  assert.equal(b.mcp.length, 2);
  assert.deepEqual(b.mcp.find((e) => e.name === 'mvc'), {
    name: 'mvc',
    url: 'https://h/mcp',
    headers: { Authorization: 'Bearer t' },
  });
});

test('detection finds only tools whose config dirs exist in the given home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mvc-mcp-'));
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), '{}');
  const found = await detectMcpTargets(home);
  const ids = found.map((f) => f.id).sort();
  assert.deepEqual(ids, ['claude-code', 'cursor']);
});

test('installMcp writes mvc entries into detected configs with backups', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mvc-mcp-'));
  const claude = join(home, '.claude.json');
  const cursorDir = join(home, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(claude, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

  const report = await installMcp({ home, mcpUrl: 'https://h/mcp', token: 'tok' });
  const actions = report.map((r) => `${r.id}:${r.action}`).sort();
  assert.deepEqual(actions, ['claude-code:updated', 'cursor:updated']);

  const claudeNow = JSON.parse(readFileSync(claude, 'utf8'));
  assert.deepEqual(claudeNow.mcpServers.mvc, {
    type: 'http',
    url: 'https://h/mcp',
    headers: { Authorization: 'Bearer tok' },
  });
  assert.deepEqual(claudeNow.mcpServers.other, { command: 'x' });
  assert.ok(existsSync(`${claude}.mvc.bak`));
  assert.ok(existsSync(join(cursorDir, 'mcp.json')));
});

test('installMcp dry-run + remove are non-destructive and idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mvc-mcp-'));
  const claude = join(home, '.claude.json');
  writeFileSync(claude, JSON.stringify({}));

  const dry = await installMcp({ home, mcpUrl: 'https://h/mcp', dryRun: true });
  assert.deepEqual(dry.map((r) => r.action), ['would-update']);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), {});

  await installMcp({ home, mcpUrl: 'https://h/mcp' });
  const again = await installMcp({ home, mcpUrl: 'https://h/mcp' });
  assert.deepEqual(again.map((r) => r.action), ['unchanged']);

  const removed = await installMcp({ home, mcpUrl: 'https://h/mcp', remove: true });
  assert.deepEqual(removed.map((r) => r.action), ['removed']);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), {});
});