// Offline unit tests for the SyncEngine — REST flows against an in-process HTTP
// mock, file handling against real temp dirs. The online WS flow is covered by
// the E2E suite against staging.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, after, before } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultDevice,
  safeJoin,
  sanitizeDirName,
  sniffFileKind,
  SyncEngine,
  walkDir,
} from './engine.js';

/** In-process stand-in for the Worker's REST surface. */
function mockServer(handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const out = await handler({ method: req.method, url: req.url, body, headers: req.headers });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.json));
  });
  return server;
}

const hasValidJson = (s) => JSON.parse(s);

describe('helpers', () => {
  it('sanitizeDirName is safe on every OS', () => {
    assert.equal(sanitizeDirName('my project'), 'my-project');
    assert.equal(sanitizeDirName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
    assert.equal(sanitizeDirName('...'), 'lobby');
    assert.equal(sanitizeDirName('  '), 'lobby');
  });

  it('safeJoin refuses traversal', () => {
    const root = join(tmpdir(), 'mvc-root');
    assert.equal(safeJoin(root, '../etc/passwd'), null);
    assert.equal(safeJoin(root, 'a/../../b'), null);
    assert.equal(safeJoin(root, '/abs'), null);
    assert.equal(safeJoin(root, '..\\b'), null);
    assert.ok(safeJoin(root, 'src/a.ts')?.startsWith(root));
  });

  it('defaultDevice looks like a device', () => {
    const d = defaultDevice('dan-pc');
    assert.equal(d.name, 'dan-pc');
    assert.ok(['windows', 'linux', 'macos'].includes(d.kind));
    assert.ok(typeof d.id === 'string' && d.id.length > 4);
  });
});

describe('filesystem', () => {
  let root;
  before(async () => {
    root = join(tmpdir(), `mvc-engine-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await fs.mkdir(join(root, 'src', 'deep'), { recursive: true });
    await fs.writeFile(join(root, 'src', 'b.ts'), 'b');
    await fs.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(join(root, 'node_modules', 'pkg', 'x.js'), 'x');
    await fs.mkdir(join(root, '.git'), { recursive: true });
    await fs.writeFile(join(root, '.git', 'config'), 'x');
    await fs.writeFile(join(root, 'notes.md'), 'hello');
    await fs.writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 255, 10]));
  });

  it('walkDir lists files, skipping ignores', async () => {
    const files = await walkDir(root);
    files.sort();
    assert.deepEqual(files, ['a.ts', 'blob.bin', 'notes.md', 'src/b.ts']);
  });

  it('walkDir skips symlinks and symlink loops', async () => {
    const outside = join(tmpdir(), `mvc-outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, join(root, 'leak.txt'));
    await fs.symlink('.', join(root, 'loop'));
    const files = await walkDir(root);
    files.sort();
    assert.deepEqual(files, ['a.ts', 'blob.bin', 'notes.md', 'src/b.ts']);
    await fs.unlink(join(root, 'leak.txt'));
    await fs.unlink(join(root, 'loop'));
    await fs.rm(outside, { force: true });
  });

  it('walkDir skips secret-shaped files by default', async () => {
    await fs.writeFile(join(root, '.env'), 'SECRET=1');
    const files = await walkDir(root);
    assert.equal(files.includes('.env'), false);
    await fs.rm(join(root, '.env'), { force: true });
  });

  it('materialize refuses to write through a symlink', async () => {
    const home = join(tmpdir(), `mvc-home-sym-${Date.now()}`);
    const dir = join(home, 'demo');
    const outside = join(tmpdir(), `mvc-outside-sym-${Date.now()}.txt`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outside, 'ORIGINAL');
    await fs.symlink(outside, join(dir, 'evil.txt'));
    const engine = new SyncEngine({ lobbyHome: home, log: { info() {} } });
    const snapshot = {
      entries: [{ path: 'evil.txt', kind: 'text', updatedAt: 0, updatedBy: 'm1' }],
      files: { 'evil.txt': 'PWNED' },
      binaries: {},
    };
    const { wrote } = await engine.materialize(snapshot, { lobbyName: 'demo' });
    assert.deepEqual(wrote, []);
    assert.equal(await fs.readFile(outside, 'utf8'), 'ORIGINAL');
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  });

  it('sniffFileKind detects text vs binary', async () => {
    assert.equal(await sniffFileKind(join(root, 'a.ts')), 'text');
    assert.equal(await sniffFileKind(join(root, 'blob.bin')), 'binary');
  });

  it('materialize writes snapshot content under ~/Lobbies-like home', async () => {
    const home = join(tmpdir(), `mvc-home-${Date.now()}`);
    const engine = new SyncEngine({ lobbyHome: home, log: { info() {} } });
    const snapshot = {
      entries: [
        { path: 'README.md', kind: 'text', updatedAt: 0, updatedBy: 'm1' },
        { path: 'img/logo.png', kind: 'binary', updatedAt: 0, updatedBy: 'm1' },
      ],
      files: { 'README.md': '# hi' },
      binaries: { 'img/logo.png': 'iVBORw0KGgo=' },
    };
    const { dir, wrote } = await engine.materialize(snapshot, { lobbyName: 'demo project' });
    assert.ok(dir.endsWith(join('demo-project')));
    assert.equal(await fs.readFile(join(dir, 'README.md'), 'utf8'), '# hi');
    assert.deepEqual(await fs.readFile(join(dir, 'img', 'logo.png')), Buffer.from('iVBORw0KGgo=', 'base64'));
    wrote.sort();
    assert.deepEqual(wrote, ['README.md', 'img/logo.png']);
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('REST flows against a mock worker', () => {
  let server;
  let base;
  /** @type {Map<string, unknown>} */
  const lobbies = new Map();
  /** @type {Map<string, number>} */
  const putCounts = new Map();

  before(async () => {
    server = mockServer(async ({ method, url, body }) => {
      const u = new URL(url, 'http://mock');
      if (method === 'POST' && u.pathname === '/lobbies') {
        const { name } = hasValidJson(body);
        const lobbyId = `mock-${Math.random().toString(36).slice(2, 8)}`;
        const token = `${lobbyId}:secret-token`;
        lobbies.set(lobbyId, { name, files: [] });
        return {
          status: 200,
          json: { lobbyId, lobbyName: name, inviteToken: token, wsUrl: `ws://mock/ws` },
        };
      }
      if (method === 'POST' && u.pathname === '/lobbies/join') {
        const { inviteToken, name } = hasValidJson(body);
        const lobbyId = inviteToken.split(':')[0];
        if (!lobbies.has(lobbyId)) return { status: 401, json: { error: 'invalid invite token' } };
        return {
          status: 200,
          json: {
            lobbyId,
            lobbyName: lobbies.get(lobbyId).name,
            memberId: `member-${name}`,
            memberToken: `tok-${lobbyId}-${name}`,
            wsUrl: `ws://mock/ws`,
          },
        };
      }
      const m = u.pathname.match(/^\/lobbies\/([^/]+)\/files$/);
      if (m && method === 'PUT') {
        const lobbyId = m[1];
        const { path } = hasValidJson(body);
        putCounts.set(path, (putCounts.get(path) ?? 0) + 1);
        lobbies.get(lobbyId).files.push(path);
        return { status: 200, json: { entry: { path } } };
      }
      return { status: 404, json: { error: 'not found' } };
    });
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  it('create → join → pushDir round trip', async () => {
    const engine = new SyncEngine({ serverUrl: base, lobbyHome: tmpdir() });
    const created = await engine.createLobby('demo');
    assert.ok(created.inviteToken.startsWith(created.lobbyId + ':'));

    const joined = await engine.join(created.inviteToken, { name: 'bob', device: defaultDevice('bob') });
    assert.equal(joined.lobbyId, created.lobbyId);
    assert.equal(joined.memberToken, `tok-${created.lobbyId}-bob`);

    const dir = join(tmpdir(), `mvc-push-${Date.now()}`);
    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.mkdir(join(dir, 'node_modules'), { recursive: true });
    await fs.writeFile(join(dir, 'README.md'), '# hi');
    await fs.writeFile(join(dir, 'src', 'main.ts'), 'console.log(1)');
    await fs.writeFile(join(dir, 'node_modules', 'x.js'), 'skip me');
    const { uploaded } = await engine.pushDir(dir, joined);
    assert.equal(uploaded, 2);
    assert.equal(putCounts.get('README.md'), 1);
    assert.equal(putCounts.get('src/main.ts'), 1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('join rejects a bad invite token', async () => {
    const engine = new SyncEngine({ serverUrl: base, lobbyHome: tmpdir() });
    await assert.rejects(() => engine.join('nope:bad'), /401/);
  });

  it('join follows a self-hosted lobby redirect and switches serverUrl', async () => {
    const host = mockServer(async () => ({
      status: 200,
      json: {
        lobbyId: 'c'.repeat(64),
        lobbyName: 'self',
        memberId: 'member-remote',
        memberToken: 'host-token',
        wsUrl: 'ws://host/ws',
      },
    }));
    await new Promise((r) => host.listen(0, r));
    const hostBase = `http://127.0.0.1:${host.address().port}`;
    const directory = mockServer(async () => ({
      status: 409,
      json: { error: 'self-hosted lobby', hostUrl: hostBase },
    }));
    await new Promise((r) => directory.listen(0, r));
    const directoryBase = `http://127.0.0.1:${directory.address().port}`;
    try {
      const engine = new SyncEngine({ serverUrl: directoryBase, lobbyHome: tmpdir() });
      const joined = await engine.join(`${'c'.repeat(64)}:secret`, {
        name: 'remote',
        device: defaultDevice('remote'),
      });
      assert.equal(joined.memberToken, 'host-token');
      assert.equal(engine.serverUrl, hostBase);
    } finally {
      await new Promise((r) => host.close(r));
      await new Promise((r) => directory.close(r));
    }
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });
});

// Live sync (M3) — offline: flushOne/applyRemote against temp dirs with a fake
// ws that captures JSON. Proves: baseline publishing, tx deltas, echo guard
// (no ping-pong), binary hash dedupe, and chat.
import {
  applyTextUpdate,
  createTextDoc,
  fromBase64,
  fullStateOf,
  replaceText,
  sha256Hex,
  textOf,
  toBase64,
} from '@mvc/shared';

const silent = { info() {}, warn() {} };
const fakeWs = () => ({ sent: [], send(m) { this.sent.push(JSON.parse(m)); } });

describe('live sync', () => {
  it('publishes full state on first touch of a text file (baseline)', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'a.txt'), 'hello live\n');

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    await engine.flushOne(dir, 'a.txt', ws);

    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].t, 'doc.sync');
    assert.equal(ws.sent[0].path, 'a.txt');
    // Decoding the full state reproduces the file content.
    const decoded = createTextDoc('');
    applyTextUpdate(decoded, fromBase64(ws.sent[0].update));
    assert.equal(textOf(decoded), 'hello live\n');
  });

  it('subsequent edits are tx deltas that merge for a shared-baseline receiver', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'a.txt'), 'one\ntwo\n');

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    await engine.flushOne(dir, 'a.txt', ws);
    const baseline = ws.sent[0].update;
    ws.sent.length = 0;

    await fs.writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    await engine.flushOne(dir, 'a.txt', ws);
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].t, 'doc.sync');
    assert.ok(ws.sent[0].update.length > 0 && ws.sent[0].update.length < baseline.length);

    // A receiver sharing the baseline applies the delta cleanly.
    const receiver = createTextDoc('');
    applyTextUpdate(receiver, fromBase64(baseline));
    applyTextUpdate(receiver, fromBase64(ws.sent[0].update));
    assert.equal(textOf(receiver), 'one\ntwo\nthree\n');
  });

  it('echo guard: applying a remote update never re-publishes the file', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'a.txt'), 'one\n');

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    await engine.flushOne(dir, 'a.txt', ws);
    const baseline = ws.sent[0].update;
    ws.sent.length = 0;

    // Another device (sharing the baseline) edits the same file.
    const other = createTextDoc('');
    applyTextUpdate(other, fromBase64(baseline));
    const txs = replaceText(other, 'one\nEDITED remotely\n');
    await engine.applyRemote(dir, { t: 'doc.update', path: 'a.txt', update: toBase64(txs[txs.length - 1]) });

    assert.equal(await fs.readFile(join(dir, 'a.txt'), 'utf8'), 'one\nEDITED remotely\n');

    // The change event re-reads a file that already matches the mirror: nothing sent.
    await engine.flushOne(dir, 'a.txt', ws);
    assert.equal(ws.sent.length, 0);
  });

  it('binary files dedupe by hash (local + remote)', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'bin.dat'), Buffer.from([0, 0, 1, 2, 255]));

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    await engine.flushOne(dir, 'bin.dat', ws);
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].t, 'binary.put');
    ws.sent.length = 0;

    // Same content → no re-push.
    await engine.flushOne(dir, 'bin.dat', ws);
    assert.equal(ws.sent.length, 0);

    // A remote binary.update (same bytes) also marks the hash as known.
    const payload = new Uint8Array([9, 9, 9]);
    const hash = await sha256Hex(toBase64(payload));
    await engine.applyRemote(dir, { t: 'binary.update', path: 'bin.dat', hash, data: toBase64(payload) });
    await engine.flushOne(dir, 'bin.dat', ws);
    assert.equal(ws.sent.length, 0);
    assert.deepEqual([...await fs.readFile(join(dir, 'bin.dat'))], [9, 9, 9]);
  });

  it('remote deletes remove the local file and reset live state', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'a.txt'), 'x');

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    await engine.flushOne(dir, 'a.txt', ws);
    await engine.applyRemote(dir, { t: 'file.deleted', path: 'a.txt' });

    await assert.rejects(() => fs.stat(join(dir, 'a.txt')), /ENOENT/);
    await engine.flushOne(dir, 'a.txt', ws); // gone locally → no message
    assert.equal(ws.sent.length, 1); // only the original publish
  });

  it('chat: applyRemote emits chat, chat() sends a message', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const ws = fakeWs();
    let got = null;
    engine.on('chat', (m) => { got = m; });
    await engine.applyRemote(root, {
      t: 'chat.message',
      message: { id: 'c1', lobbyId: 'l1', authorId: 'm1', body: 'hi team', mentions: [], ts: 1 },
    });
    assert.equal(got.body, 'hi team');

    engine.chat(ws, 'hello lobby');
    assert.equal(ws.sent[0].t, 'chat.send');
    assert.equal(ws.sent[0].body, 'hello lobby');
  });

  it('applySnapshotBaselines builds mirrors with established baselines', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mvc-live-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const engine = new SyncEngine({ lobbyHome: join(root, 'home'), log: silent });
    const doc = createTextDoc('baseline content here');
    const snapshot = { t: 'snapshot', entries: [], files: {}, binaries: {}, docs: { 'a.txt': toBase64(Uint8Array.from(fullStateOf(doc))) } };
    engine.applySnapshotBaselines(snapshot);

    const ws = fakeWs();
    const dir = join(root, 'lobby');
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, 'a.txt'), 'baseline content here');
    await engine.flushOne(dir, 'a.txt', ws);
    // Baseline established via snapshot → an unchanged file publishes nothing.
    assert.equal(ws.sent.length, 0);
  });
});