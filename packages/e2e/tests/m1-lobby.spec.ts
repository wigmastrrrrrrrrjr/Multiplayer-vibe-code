// M1 online — the "wow": device B joins a lobby created by device A and gets a
// working copy of A's folder (files, subdirs, small binaries). Runs against the
// deployed staging Worker (STAGING_URL); skips cleanly when not set.
import { describe, expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDevice, SyncEngine } from '@mvc/agent';

const online = Boolean(process.env.STAGING_URL);
const serverUrl = process.env.STAGING_URL || '';

class TempHome {
  constructor(label) {
    this.dir = join(tmpdir(), `mvc-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  }
  async rm() {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

const run = online
  ? describe
  : describe.skip;

run('M1 folder join (online, staging)', () => {
  test.describe.configure({ timeout: 60_000 });

  const homes = new Map();
  test.afterEach(async () => {
    for (const home of homes.values()) await home.rm();
    homes.clear();
  });

  test('device B materializes device A\'s pushed folder over the wire', async () => {
    const homeA = new TempHome('a');
    const homeB = new TempHome('b');
    homes.set('a', homeA);
    homes.set('b', homeB);

    const engineA = new SyncEngine({ serverUrl, lobbyHome: homeA.dir });
    const engineB = new SyncEngine({ serverUrl, lobbyHome: homeB.dir });

    // -- Device A: create the lobby, push a folder ----------------------------
    const created = await engineA.createLobby('e2e-project');
    expect(created.inviteToken).toContain(`${created.lobbyId}:`);
    expect(created.wsUrl).toMatch(/^wss?:\/\//);

    const pushDir = join(homeA.dir, 'seed');
    await fs.mkdir(join(pushDir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(join(pushDir, 'README.md'), '# e2e project\n');
    await fs.writeFile(join(pushDir, 'src', 'main.ts'), 'export const ok = true;\n');
    await fs.writeFile(
      join(pushDir, 'src', 'deep', 'nested.txt'),
      'deep folder survives\n',
    );
    await fs.writeFile(join(pushDir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 254, 255]));
    await fs.mkdir(join(pushDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(join(pushDir, 'node_modules', 'pkg', 'ignored.js'), 'nope');

    const alice = await engineA.join(created.inviteToken, {
      name: 'alice',
      device: defaultDevice('alice'),
    });
    expect(alice.memberToken).toBeTruthy();
    const pushed = await engineA.pushDir(pushDir, alice);
    expect(pushed.uploaded).toBe(4); // node_modules ignored
    expect(pushed.skipped.length).toBe(0);

    // -- Device B: join + sync + materialize -----------------------------------
    const bob = await engineB.join(created.inviteToken, {
      name: 'bob',
      device: defaultDevice('bob'),
    });
    expect(bob.lobbyId).toBe(created.lobbyId);

    const { ws, snapshot } = await engineB.syncLobby({
      wsUrl: bob.wsUrl,
      memberToken: bob.memberToken,
      name: 'bob',
      device: defaultDevice('bob'),
    });
    expect(snapshot.entries.map((e) => e.path).sort()).toEqual([
      'README.md',
      'blob.bin',
      'src/deep/nested.txt',
      'src/main.ts',
    ]);

    const { dir, wrote } = await engineB.materialize(snapshot, {
      lobbyName: bob.lobbyName,
    });
    expect(wrote.sort()).toEqual(['README.md', 'blob.bin', 'src/deep/nested.txt', 'src/main.ts']);

    // Device B's folder is a working copy of A's.
    expect(await fs.readFile(join(dir, 'README.md'), 'utf8')).toBe('# e2e project\n');
    expect(await fs.readFile(join(dir, 'src', 'main.ts'), 'utf8')).toBe('export const ok = true;\n');
    expect(await fs.readFile(join(dir, 'src', 'deep', 'nested.txt'), 'utf8')).toBe(
      'deep folder survives\n',
    );
    expect(await fs.readFile(join(dir, 'blob.bin'))).toEqual(Buffer.from([0, 1, 2, 3, 254, 255]));
    // Ignored folders never left A's device.
    expect(
      await fs.readdir(join(dir, 'node_modules')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    ws.close();
    engineA.closeAll();
    engineB.closeAll();
  });

  test('joining with a forged/expired token is rejected (401)', async () => {
    const home = new TempHome('auth');
    homes.set('auth', home);
    const engine = new SyncEngine({ serverUrl, lobbyHome: home.dir });
    await expect(
      engine.join(`not-a-real-lobby:${'0'.repeat(32)}`, { name: 'mallory', device: defaultDevice('m') }),
    ).rejects.toThrow(/401|invalid invite/);
    engine.closeAll();
  });
});