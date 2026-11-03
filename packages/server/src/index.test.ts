import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker, { type Env } from '../src/index.ts';
import {
  html,
  installationPage,
  installScript,
  json,
  licensePage,
  redirect,
  sourceTarball,
  SOURCE_SHA256,
  SOURCE_BUILT_AT,
} from '../src/index.ts';

describe('server surface', () => {
  it('health returns json', () => {
    const res = json({ ok: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('redirect() 301s to the target', () => {
    const res = redirect('/installation');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/installation');
  });

  it('html() is a content-type html document', () => {
    const res = html('t', '<p>x</p>');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });

  it('installation page covers install + join for every OS', async () => {
    const res = installationPage(new Request('https://mvc.test/installation'));
    const text = await res.text();
    assert.ok(text.includes('mvc-agent'));
    assert.ok(text.includes('npm link --workspace @mvc/agent'));
    assert.ok(text.includes('Windows, Ubuntu, Linux and macOS'));
    assert.ok(text.includes('https://mvc.test'));
    assert.ok(text.includes('/mcp'));
    assert.ok(text.includes('remembers this server'));
    assert.ok(!text.includes('&lt;inviteToken&gt;'));
  });

  it('installation page is self-hosted + MIT licensed (no git clone)', async () => {
    const res = installationPage(new Request('https://mvc.test/installation'));
    const text = await res.text();
    assert.ok(text.includes('source.tar.gz'));
    assert.ok(text.includes('MIT licensed'));
    assert.ok(text.includes('self-hosted'));
    assert.ok(!text.includes('git clone'));
  });

  it('installation page documents auto-update + AI CLI setup', async () => {
    const res = installationPage(new Request('https://mvc.test/installation'));
    const text = await res.text();
    assert.ok(text.includes('mvc-agent update --check'));
    assert.ok(text.includes('mvc-agent setup --dry-run'));
    assert.ok(text.includes('Claude Code, Cursor, Windsurf, Zed'));
  });

  it('license page is the MIT text', async () => {
    const res = licensePage();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.ok(text.includes('MIT License'));
    assert.ok(text.includes('Permission is hereby granted'));
  });

  it('source tarball is 404 while the placeholder is empty', async () => {
    const res = sourceTarball();
    assert.equal(res.status, 404);
  });

  it('version payload carries the update source of truth', async () => {
    const res = json({ sourceSha256: SOURCE_SHA256, builtAt: SOURCE_BUILT_AT, sourceUrl: '/source.tar.gz' });
    const data = (await res.json()) as { sourceUrl: string; sourceSha256: string; builtAt: string };
    assert.equal(data.sourceUrl, '/source.tar.gz');
    assert.equal(typeof data.sourceSha256, 'string');
    assert.equal(typeof data.builtAt, 'string');
  });

  it('install.sh is a POSIX installer with the host baked in, no placeholders left', async () => {
    const res = installScript('mvc.test', 'sh');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /x-shellscript/);
    const body = await res.text();
    assert.ok(body.startsWith('#!/bin/sh'));
    assert.ok(body.includes('mvc-agent update --check'));
    assert.ok(!body.includes('__HOST__'));
    assert.ok(body.includes('sha256 mismatch'));
    assert.ok(body.includes('https://mvc.test'));
  });

  it('install.ps1 is a PowerShell installer with the host baked in', async () => {
    const res = installScript('mvc.test', 'ps1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /powershell/);
    const body = await res.text();
    assert.ok(body.includes('$ErrorActionPreference'));
    assert.ok(body.includes('Get-FileHash'));
    assert.ok(body.includes('mvc.test'));
    assert.ok(!body.includes('__HOST__'));
  });
});
describe('self-hosted lobby registry', () => {
  it('registers, heartbeats, lists and redirects join to the host', async () => {
    const DB = new FakeD1();
    const env = { MCP_SIGNING_SECRET: 'test', LOBBY_OBJECT: {}, DB } as unknown as Env;
    const lobbyId = 'a'.repeat(64);
    const hostUrl = 'http://127.0.0.1:8787';

    const registered = await worker.fetch(
      new Request('https://mvc.test/registry/lobbies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lobbyId, name: 'demo', hostUrl }),
      }),
      env,
    );
    assert.equal(registered.status, 200);
    const reg = (await registered.json()) as { registrationSecret: string; expiresAt: number };
    assert.equal(typeof reg.registrationSecret, 'string');
    assert.ok(reg.expiresAt > Date.now());

    const heartbeat = await worker.fetch(
      new Request('https://mvc.test/registry/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lobbyId, registrationSecret: reg.registrationSecret }),
      }),
      env,
    );
    assert.equal(heartbeat.status, 200);

    const listed = await worker.fetch(new Request('https://mvc.test/registry/lobbies'), env);
    assert.equal(listed.status, 200);
    const list = (await listed.json()) as { lobbies: Array<{ lobbyId: string; hostUrl: string }> };
    assert.deepEqual(list.lobbies.map((l) => l.lobbyId), [lobbyId]);
    assert.equal(list.lobbies[0]?.hostUrl, hostUrl);

    const joined = await worker.fetch(
      new Request('https://mvc.test/lobbies/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: `${lobbyId}:invite` }),
      }),
      env,
    );
    assert.equal(joined.status, 409);
    const redirect = (await joined.json()) as { hostUrl: string };
    assert.equal(redirect.hostUrl, hostUrl);
  });

  it('rejects unregister without the registration secret', async () => {
    const DB = new FakeD1();
    const env = { MCP_SIGNING_SECRET: 'test', LOBBY_OBJECT: {}, DB } as unknown as Env;
    const lobbyId = 'b'.repeat(64);
    await worker.fetch(
      new Request('https://mvc.test/registry/lobbies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lobbyId, name: 'demo', hostUrl: 'https://host.test' }),
      }),
      env,
    );
    const res = await worker.fetch(
      new Request(`https://mvc.test/registry/${lobbyId}`, { method: 'DELETE' }),
      env,
    );
    assert.equal(res.status, 401);
  });
});

interface Row {
  id: string;
  name: string;
  host_url: string;
  secret_hash: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

class FakeD1 {
  rows = new Map<string, Row>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  private db: FakeD1;
  private sql: string;

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async run() {
    const s = this.sql;
    let changes = 0;
    if (s.startsWith('INSERT INTO lobbies')) {
      const [id, name, hostUrl, secretHash, createdAt, updatedAt, expiresAt] = this.args as [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      if (this.db.rows.has(id)) throw new Error('UNIQUE constraint failed');
      this.db.rows.set(id, {
        id,
        name,
        host_url: hostUrl,
        secret_hash: secretHash,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
      });
      changes = 1;
    } else if (s.startsWith('UPDATE lobbies')) {
      const [updatedAt, expiresAt, id, secretHash] = this.args as [number, number, string, string];
      const row = this.db.rows.get(id);
      if (row && row.secret_hash === secretHash) {
        row.updated_at = updatedAt;
        row.expires_at = expiresAt;
        changes = 1;
      }
    } else if (s.startsWith('DELETE FROM lobbies WHERE id = ? AND secret_hash = ?')) {
      const [id, secretHash] = this.args as [string, string];
      const row = this.db.rows.get(id);
      if (row && row.secret_hash === secretHash) changes = this.db.rows.delete(id) ? 1 : 0;
    } else if (s.startsWith('DELETE FROM lobbies WHERE id = ?')) {
      changes = this.db.rows.delete(this.args[0] as string) ? 1 : 0;
    } else if (s.startsWith('DELETE FROM lobbies WHERE expires_at <= ?')) {
      const now = this.args[0] as number;
      for (const [id, row] of this.db.rows) {
        if (row.expires_at <= now) {
          this.db.rows.delete(id);
          changes++;
        }
      }
    }
    return { meta: { changes }, results: [] };
  }

  async first<T>() {
    return (this.db.rows.get(this.args[0] as string) as T | undefined) ?? null;
  }

  async all<T>() {
    const rows = [...this.db.rows.values()].sort((a, b) => b.updated_at - a.updated_at);
    return { results: rows as T[], meta: { changes: 0 } };
  }
}
