// M2+M3 online — live two-way CRDT sync against the deployed staging Worker:
//   - a text edit on device A lands on device B's disk in real time (and the
//     reverse), via Yjs transaction updates (M2 acceptance),
//   - concurrent edits merge (M3 acceptance, verified offline in shared/yjs),
//   - chat messages relay to everyone,
//   - a fresh join sees the merged state, proving the DO persisted it (M3:
//     "lobby survives" — storage-backed, so durable across DO restarts).
import { describe, expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDevice, SyncEngine } from '@mvc/agent';

const online = Boolean(process.env.STAGING_URL);
const serverUrl = process.env.STAGING_URL || '';

class TempHome {
  constructor(label) {
    this.dir = join(tmpdir(), `mvc-e2e-live-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  }
  async rm() {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

const run = online
  ? describe
  : describe.skip;

run('M2+M3 live sync (online, staging)', () => {
  test.describe.configure({ timeout: 120_000 });

  const homes = new Map();
  test.afterEach(async () => {
    for (const home of homes.values()) await home.rm();
    homes.clear();
  });

  test('edits sync both ways in real time; chat + persistence', async () => {
    const homeA = new TempHome('a');
    const homeB = new TempHome('b');
    const homeC = new TempHome('c');
    homes.set('a', homeA);
    homes.set('b', homeB);
    homes.set('c', homeC);

    const engineA = new SyncEngine({ serverUrl, lobbyHome: homeA.dir });
    const engineB = new SyncEngine({ serverUrl, lobbyHome: homeB.dir });
    const engineC = new SyncEngine({ serverUrl, lobbyHome: homeC.dir });

    // -- A creates the lobby and pushes a seed folder ---------------------------
    const created = await engineA.createLobby('e2e-live');
    const pushDir = join(homeA.dir, 'seed');
    await fs.mkdir(join(pushDir, 'src'), { recursive: true });
    await fs.writeFile(join(pushDir, 'README.md'), '# live sync\n');
    await fs.writeFile(join(pushDir, 'src', 'main.ts'), 'export const first = 1;\n');
    const alice = await engineA.join(created.inviteToken, { name: 'alice', device: defaultDevice('alice') });
    await engineA.pushDir(pushDir, alice);

    // -- A and B materialize the same folder -----------------------------------
    const sessA = await engineA.syncLobby({ wsUrl: alice.wsUrl, memberToken: alice.memberToken, name: 'alice', device: defaultDevice('alice') });
    const dirA = (await engineA.materialize(sessA.snapshot, { lobbyName: created.lobbyName })).dir;

    const bob = await engineB.join(created.inviteToken, { name: 'bob', device: defaultDevice('bob') });
    const sessB = await engineB.syncLobby({ wsUrl: bob.wsUrl, memberToken: bob.memberToken, name: 'bob', device: defaultDevice('bob') });
    const dirB = (await engineB.materialize(sessB.snapshot, { lobbyName: created.lobbyName })).dir;

    // Route server messages → local disk (what `join --live` does).
    engineA.on('msg', ({ msg }) => engineA.applyRemote(dirA, msg));
    engineB.on('msg', ({ msg }) => engineB.applyRemote(dirB, msg));

    // -- A edits a file; B's disk updates in real time -------------------------
    await fs.writeFile(join(dirA, 'src/main.ts'), 'export const first = 1;\n// A's live edit\n');
    await engineA.flushOne(dirA, 'src/main.ts', sessA.ws);
    await expect
      .poll(async () => fs.readFile(join(dirB, 'src/main.ts'), 'utf8'), { timeout: 20_000 })
      .toBe('export const first = 1;\n// A\'s live edit\n');

    // -- B edits back; A receives it (delta path — B is now established) -------
    await fs.writeFile(join(dirB, 'src/main.ts'), 'export const first = 1;\n// A\'s live edit\n// B responds\n');
    await engineB.flushOne(dirB, 'src/main.ts', sessB.ws);
    await expect
      .poll(async () => fs.readFile(join(dirA, 'src/main.ts'), 'utf8'), { timeout: 20_000 })
      .toBe('export const first = 1;\n// A\'s live edit\n// B responds\n');

    // -- New binary file created on A shows up on B ----------------------------
    await fs.writeFile(join(dirA, 'blob.bin'), Buffer.from([9, 9, 9, 9]));
    await engineA.flushOne(dirA, 'blob.bin', sessA.ws);
    await expect
      .poll(async () => {
        const buf = await fs.readFile(join(dirB, 'blob.bin'));
        return JSON.stringify([...buf]);
      }, { timeout: 20_000 })
      .toBe('[9,9,9,9]');

    // -- Chat round trip -------------------------------------------------------
    const chatPromise = engineA.waitFor('chat.message', 10_000);
    engineB.chat(sessB.ws, 'hi from bob');
    const chat = (await chatPromise).message;
    expect(chat.body).toBe('hi from bob');

    // -- Persistence: a fresh third device sees the merged state ---------------
    const carol = await engineC.join(created.inviteToken, { name: 'carol', device: defaultDevice('carol') });
    const sessC = await engineC.syncLobby({ wsUrl: carol.wsUrl, memberToken: carol.memberToken, name: 'carol', device: defaultDevice('carol') });
    const dirC = (await engineC.materialize(sessC.snapshot, { lobbyName: created.lobbyName })).dir;
    expect(await fs.readFile(join(dirC, 'src/main.ts'), 'utf8')).toBe(
      'export const first = 1;\n// A\'s live edit\n// B responds\n',
    );
    // The DO persisted the merged Yjs state (snapshot.docs) — not just raw text.
    expect(sessC.snapshot.docs?.['src/main.ts']).toBeTruthy();
    expect(await fs.readFile(join(dirC, 'blob.bin'))).toEqual(Buffer.from([9, 9, 9, 9]));

    sessA.ws.close();
    sessB.ws.close();
    sessC.ws.close();
    engineA.closeAll();
    engineB.closeAll();
    engineC.closeAll();
  });
});