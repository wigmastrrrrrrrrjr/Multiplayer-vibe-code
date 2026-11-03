import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createApp } from './app.js';

const log = { info() {}, warn() {}, error() {} };
let app;
let base;

describe('node self-host server', () => {
  before(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mvc-node-'));
    app = await createApp({ dataDir, registryUrl: '', log });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });

  after(async () => {
    await app.close();
    await rm(app.dataDir, { recursive: true, force: true });
  });

  it('creates, joins, pushes and snapshots a lobby', async () => {
    const created = await post('/lobbies', { name: 'demo' });
    assert.equal(created.status, 200);
    assert.match(created.body.lobbyId, /^[0-9a-f]{64}$/);
    assert.ok(created.body.inviteToken.includes(':'));
    assert.ok(created.body.wsUrl.startsWith('ws://'));

    const joined = await post('/lobbies/join', {
      inviteToken: created.body.inviteToken,
      name: 'alice',
      device: { id: 'a', name: 'a', platform: 'linux', arch: 'arm64' },
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.serverUrl, base);

    const put = await fetch(`${base}/lobbies/${created.body.lobbyId}/files`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${joined.body.memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'src/main.ts', content: 'console.log(1)' }),
    });
    assert.equal(put.status, 200);

    const snapshot = await fetch(
      `${base}/lobbies/${created.body.lobbyId}/snapshot`,
      { headers: { authorization: `Bearer ${joined.body.memberToken}` } },
    );
    const snap = await snapshot.json();
    assert.equal(snapshot.status, 200);
    assert.equal(snap.files['src/main.ts'], 'console.log(1)');
  });

  it('relays live CRDT updates between two members', async () => {
    const created = await post('/lobbies', { name: 'live' });
    const a = await joinLobby(created.body.inviteToken, "a");
    const b = await joinLobby(created.body.inviteToken, "b");
    const wa = await openWs(a.wsUrl, a.memberToken);
    const wb = await openWs(b.wsUrl, b.memberToken);
    try {
      await hello(wa, 'a');
      await hello(wb, 'b');
      const update = waitFor(wa, 'doc.update');
      const doc = new Y.Doc();
      doc.getText('t').insert(0, 'hello node');
      wb.send(
        JSON.stringify({
          t: 'doc.sync',
          path: 'live.txt',
          update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
        }),
      );
      const msg = await update;
      assert.equal(msg.path, 'live.txt');
      assert.ok(msg.update.length > 0);
    } finally {
      wa.close();
      wb.close();
    }
  });
});

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function joinLobby(inviteToken, name) {
  const res = await post('/lobbies/join', {
    inviteToken,
    name,
    device: { id: name, name, platform: 'linux', arch: 'arm64' },
  });
  assert.equal(res.status, 200);
  return res.body;
}

function openWs(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${type}`)), 5000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t !== type) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(msg);
    };
    ws.on('message', handler);
  });
}

async function hello(ws, name) {
  const ok = waitFor(ws, 'hello.ok');
  const snapshot = waitFor(ws, 'snapshot');
  ws.send(
    JSON.stringify({
      t: 'hello',
      name,
      device: { id: name, name, platform: 'linux', arch: 'arm64' },
    }),
  );
  await ok;
  await snapshot;
}
