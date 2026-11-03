import { Lobby } from '@mvc/server-do';
import { memberTokenLobbyId, randomHex, sha256Hex, WS_PATH } from '@mvc/shared';
import { SOURCE_TARBALL_B64, SOURCE_SHA256, SOURCE_BUILT_AT } from './generated/source-tarball.ts';
import type {
  CreateLobbyRequest,
  CreateLobbyResponse,
  JoinLobbyRequest,
  JoinLobbyResponse,
  LobbyInfoResponse,
} from '@mvc/shared';

export { Lobby };
export type { Lobby as LobbyObject };
export { SOURCE_SHA256, SOURCE_BUILT_AT } from './generated/source-tarball.ts';

export interface Env {
  /** HMAC secret used to sign member tokens (secret binding, never in code). */
  MCP_SIGNING_SECRET: string;
  LOBBY_OBJECT: DurableObjectNamespace;
  /** Optional D1 directory of self-hosted lobbies (host URL + liveness). */
  DB?: D1Database;
}

/**
 * Public surface:
 *  - `/`  and `/install` → 301 redirect to `/installation`
 *  - `/installation`     public install instructions (all devices)
 *  - `/source.tar.gz`    the complete source, self-hosted (gzipped tarball)
 *  - `/install.sh`       one-command POSIX installer (Ubuntu/Linux/macOS)
 *  - `/install.ps1`      one-command Windows PowerShell installer
 *  - `/license`          the MIT license text
 *  - `/version`          version + source sha256 (drives the agent's auto-update)
 *  - `/health`           JSON health for the sync agents + E2E
 *  - `POST /lobbies`          create a lobby → { lobbyId, inviteToken, wsUrl }
 *  - `POST /lobbies/join`     join with an invite token → member token
 *  - `GET  /lobbies/:id`      lobby info
 *  - `GET|PUT /lobbies/:id/files`     index / upsert a file
 *  - `GET  /lobbies/:id/snapshot`     full content snapshot
 *  - `/ws?token=…`            WebSocket sync endpoint
 *  - `/mcp`     MCP endpoint for models (lands in M4)
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    addCors(request);
    try {
      return await route(request, env);
    } catch (err) {
      console.error('worker error:', err);
      return json({ error: 'internal error' }, 500);
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (env.DB) ctx.waitUntil(pruneExpiredLobbies(env.DB));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  switch (pathname) {
    case '/':
    case '/install':
      return redirect('/installation');
    case '/installation':
      return installationPage(request);
    case '/source.tar.gz':
      return sourceTarball();
    case '/license':
      return licensePage();
    case '/install.sh':
      return installScript(new URL(request.url).host, 'sh');
    case '/install.ps1':
      return installScript(new URL(request.url).host, 'ps1');
    case '/version':
      return json({
        name: 'multiplayer-vibe-code',
        version: '0.0.0',
        sourceSha256: SOURCE_SHA256,
        builtAt: SOURCE_BUILT_AT,
        sourceUrl: '/source.tar.gz',
      });
    case '/health':
      return json({ ok: true, service: 'mvc-server', at: Date.now() });
    case '/mcp':
      return new Response('MCP endpoint lands in M4', { status: 501 });
    case '/registry/lobbies':
      if (method === 'POST') return registerLobby(request, env);
      if (method === 'GET') return listLobbies(env);
      return json({ error: 'method not allowed' }, 405);
    case '/registry/heartbeat':
      if (method === 'POST') return heartbeatLobby(request, env);
      return json({ error: 'method not allowed' }, 405);
    case '/lobbies':
      if (method === 'POST') return createLobby(request, env);
      return json({ error: 'method not allowed' }, 405);
    case '/lobbies/join':
      if (method === 'POST') return joinLobby(request, env);
      return json({ error: 'method not allowed' }, 405);
    case WS_PATH:
      return routeWs(request, url, env);
    default:
      break;
  }

  // /registry/:id — public directory entry for a self-hosted lobby.
  const registryMatch = pathname.match(/^\/registry\/([^/]+)$/);
  if (registryMatch) {
    const lobbyId = decodeURIComponent(registryMatch[1]!);
    if (method === 'GET') return getRegisteredLobby(env, lobbyId);
    if (method === 'DELETE') return unregisterLobby(request, env, lobbyId);
    return json({ error: 'method not allowed' }, 405);
  }

  // /lobbies/:id[/subresource]
  const match = pathname.match(/^\/lobbies\/([^/]+)(\/[^/]*)?$/);
  if (match) {
    const lobbyId = decodeURIComponent(match[1]!);
    if (!isLobbyId(lobbyId)) return json({ error: 'lobby not found' }, 404);
    const stub = lobbyStub(env, lobbyId);
    if (!stub) return json({ error: 'lobby not found' }, 404);
    const sub = match[2] ?? '';
    if (sub === '') {
      if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const res = await stub.fetch(doUrl('/info'));
      return json((await res.json()) as LobbyInfoResponse, res.status);
    }
    const whitelist: Record<string, string[]> = {
      '/files': ['GET', 'PUT'],
      '/snapshot': ['GET'],
    };
    const allowed = whitelist[sub];
    if (!allowed || !allowed.includes(method)) {
      return json({ error: 'method not allowed' }, 405);
    }
    // Forward the ORIGINAL request (Authorization header + body) to the DO;
    // only the destination URL is rewritten.
    const forwarded = new Request(doUrl(sub), request);
    return stub.fetch(forwarded);
  }

  return new Response('not found', { status: 404 });
}

/* Handlers ------------------------------------------------------------------ */

async function createLobby(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as CreateLobbyRequest | null;
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return json({ error: 'name required' }, 400);
  }
  const stub = env.LOBBY_OBJECT.get(env.LOBBY_OBJECT.newUniqueId());
  const res = await doFetch(stub, '/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: body.name }),
  });
  const created = (await res.json()) as Omit<CreateLobbyResponse, 'wsUrl'> & { error?: string };
  if (!res.ok) return json({ error: created.error ?? 'create failed' }, res.status);
  return json({ ...created, wsUrl: wsUrlFor(request) } satisfies CreateLobbyResponse);
}

async function joinLobby(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as JoinLobbyRequest | null;
  if (!body || typeof body.inviteToken !== 'string') {
    return json({ error: 'inviteToken required' }, 400);
  }
  const colon = body.inviteToken.indexOf(':');
  const lobbyId = colon > 0 ? body.inviteToken.slice(0, colon) : '';
  if (isLobbyId(lobbyId)) {
    const registered = await findRegisteredLobby(env, lobbyId);
    if (registered) {
      // The lobby is hosted by a member's own device. Tell the agent where to
      // go; it retries the join directly against that host (no proxy/SSRF).
      return json(
        { error: 'self-hosted lobby', hostUrl: registered.host_url },
        409,
      );
    }
  }
  const stub = lobbyStub(env, lobbyId);
  if (!stub) return json({ error: 'invalid invite token' }, 401);
  const res = await doFetch(stub, '/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const joined = (await res.json()) as Omit<JoinLobbyResponse, 'wsUrl'> & { error?: string };
  if (!res.ok) return json({ error: joined.error ?? 'join failed' }, res.status);
  return json({ ...joined, wsUrl: wsUrlFor(request) } satisfies JoinLobbyResponse);
}

/* Self-hosted lobby directory (D1) ------------------------------------------ */

/** A host must heartbeat at least this often; stale entries are pruned. */
const REGISTRY_TTL_MS = 90_000;

interface RegistryRow {
  id: string;
  name: string;
  host_url: string;
  secret_hash: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function registryDb(env: Env): D1Database | null {
  return env.DB ?? null;
}

async function registerLobby(request: Request, env: Env): Promise<Response> {
  const db = registryDb(env);
  if (!db) return json({ error: 'registry not configured' }, 501);

  const body = (await request.json().catch(() => null)) as
    | { lobbyId?: string; name?: string; hostUrl?: string }
    | null;
  const lobbyId = body?.lobbyId ?? '';
  if (!isLobbyId(lobbyId)) return json({ error: 'invalid lobbyId' }, 400);
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!name) return json({ error: 'name required' }, 400);
  const hostUrl = validHostUrl(body?.hostUrl);
  if (!hostUrl) return json({ error: 'invalid hostUrl' }, 400);

  const secret = randomHex(32);
  const secretHash = await sha256Hex(secret);
  const now = Date.now();
  const expiresAt = now + REGISTRY_TTL_MS;
  try {
    await db
      .prepare(
        `INSERT INTO lobbies
           (id, name, host_url, secret_hash, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(lobbyId, name, hostUrl, secretHash, now, now, expiresAt)
      .run();
  } catch (err) {
    if (String(err).toLowerCase().includes('unique')) {
      return json({ error: 'lobby already registered' }, 409);
    }
    throw err;
  }
  return json({ lobbyId, registrationSecret: secret, expiresAt });
}

async function heartbeatLobby(request: Request, env: Env): Promise<Response> {
  const db = registryDb(env);
  if (!db) return json({ error: 'registry not configured' }, 501);
  const body = (await request.json().catch(() => null)) as
    | { lobbyId?: string; registrationSecret?: string }
    | null;
  const lobbyId = body?.lobbyId ?? '';
  const secret = body?.registrationSecret ?? '';
  if (!isLobbyId(lobbyId) || !secret) return json({ error: 'invalid heartbeat' }, 400);

  const now = Date.now();
  const expiresAt = now + REGISTRY_TTL_MS;
  const result = await db
    .prepare(
      'UPDATE lobbies SET updated_at = ?, expires_at = ? WHERE id = ? AND secret_hash = ?',
    )
    .bind(now, expiresAt, lobbyId, await sha256Hex(secret))
    .run();
  if (!result.meta.changes) return json({ error: 'not registered' }, 404);
  return json({ ok: true, expiresAt });
}

async function unregisterLobby(
  request: Request,
  env: Env,
  lobbyId: string,
): Promise<Response> {
  const db = registryDb(env);
  if (!db) return json({ error: 'registry not configured' }, 501);
  if (!isLobbyId(lobbyId)) return json({ error: 'lobby not found' }, 404);
  const secret = request.headers.get('x-mvc-registration-secret') ?? '';
  if (!secret) return json({ error: 'registration secret required' }, 401);
  const result = await db
    .prepare('DELETE FROM lobbies WHERE id = ? AND secret_hash = ?')
    .bind(lobbyId, await sha256Hex(secret))
    .run();
  if (!result.meta.changes) return json({ error: 'not registered' }, 404);
  return new Response(null, { status: 204 });
}

async function getRegisteredLobby(env: Env, lobbyId: string): Promise<Response> {
  if (!isLobbyId(lobbyId)) return json({ error: 'lobby not found' }, 404);
  const row = await findRegisteredLobby(env, lobbyId);
  if (!row) return json({ error: 'lobby not found' }, 404);
  return json(publicRegistryEntry(row));
}

async function listLobbies(env: Env): Promise<Response> {
  const db = registryDb(env);
  if (!db) return json({ error: 'registry not configured' }, 501);
  await pruneExpiredLobbies(db);
  const result = await db
    .prepare(
      'SELECT id, name, host_url, created_at, updated_at, expires_at FROM lobbies ORDER BY updated_at DESC LIMIT 100',
    )
    .all<Omit<RegistryRow, 'secret_hash'>>();
  return json({ lobbies: (result.results ?? []).map(publicRegistryEntry) });
}

async function findRegisteredLobby(
  env: Env,
  lobbyId: string,
): Promise<RegistryRow | null> {
  const db = registryDb(env);
  if (!db) return null;
  const row = await db
    .prepare('SELECT * FROM lobbies WHERE id = ?')
    .bind(lobbyId)
    .first<RegistryRow>();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM lobbies WHERE id = ?').bind(lobbyId).run();
    return null;
  }
  return row;
}

async function pruneExpiredLobbies(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM lobbies WHERE expires_at <= ?').bind(Date.now()).run();
}

function publicRegistryEntry(row: Omit<RegistryRow, 'secret_hash'>) {
  return {
    lobbyId: row.id,
    name: row.name,
    hostUrl: row.host_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function validHostUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function routeWs(request: Request, url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get('token');
  const lobbyId = token ? memberTokenLobbyId(token) : null;
  if (!lobbyId || !isLobbyId(lobbyId)) return json({ error: 'unauthorized' }, 401);
  // The DO re-verifies the signature before accepting the upgrade.
  const stub = lobbyStub(env, lobbyId);
  if (!stub) return json({ error: 'unauthorized' }, 401);
  return stub.fetch(request);
}

/* Helpers ------------------------------------------------------------------- */

const DO_ID_RE = /^[0-9a-f]{64}$/i;

function isLobbyId(id: string): boolean {
  return DO_ID_RE.test(id);
}

function lobbyStub(env: Env, lobbyId: string): DurableObjectStub | null {
  try {
    return env.LOBBY_OBJECT.get(env.LOBBY_OBJECT.idFromString(lobbyId));
  } catch {
    // Not a structurally valid Durable Object id — treat as not found.
    return null;
  }
}

function doUrl(pathname: string): string {
  // Durable Objects accept any origin; the request init carries method/headers/body.
  return `https://lobby.local${pathname}`;
}

function doFetch(
  stub: DurableObjectStub,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return stub.fetch(doUrl(pathname), init);
}

function wsUrlFor(request: Request): string {
  const url = new URL(request.url);
  const proto = url.protocol === 'http:' ? 'ws' : 'wss';
  return `${proto}://${url.host}${WS_PATH}`;
}

/* M0-era helpers kept for tests/UI ------------------------------------------- */

export function addCors(_request?: Request): void {
  // Same-origin only for now; CORS headers land with the web viewer (M6).
  void _request;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/* Public install page --------------------------------------------------------- */

const MIT_LICENSE = `MIT License

Copyright (c) 2026 multiplayer vibe code contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The MIT license for the project, served as plain text. */
export function licensePage(): Response {
  return new Response(MIT_LICENSE, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * The complete source, self-hosted. The tarball is embedded at deploy time by
 * scripts/deploy-worker.mjs (base64 of `git archive`) — the committed
 * placeholder is empty, so deployments without it answer 404 instead of serving
 * a truncated/self-referential tree.
 */
export function sourceTarball(): Response {
  if (!SOURCE_TARBALL_B64) {
    return new Response('source tarball not bundled in this deployment', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const bytes = Uint8Array.from(atob(SOURCE_TARBALL_B64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': 'attachment; filename="multiplayer-vibe-code-source.tar.gz"',
      'cache-control': 'public, max-age=3600',
    },
  });
}

export function redirect(to: string): Response {
  return new Response(null, { status: 301, headers: { location: to } });
}

/** Served at /install.sh — POSIX sh one-command installer (no cd needed). */
const SH_INSTALLER = `#!/bin/sh
# multiplayer vibe code — one-command installer (POSIX sh, Ubuntu/Linux/macOS).
# Downloads the MIT-licensed source from the same server, verifies its sha256,
# npm-installs, links mvc-agent onto PATH and records ~/.local/share/mvc/meta.json.
set -e
BASE="\${MVC_SERVER_URL:-https://__HOST__}"
MANAGED="\${MVC_MANAGED_DIR:-\$HOME/.local/share/mvc}"
CURRENT="\$MANAGED/current/multiplayer-vibe-code"

say() { printf '%s\\n' "\$*"; }
die() { say "install failed: \$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v node >/dev/null 2>&1 || die "Node.js >= 22 is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"
command -v tar  >/dev/null 2>&1 || die "tar is required"

say "installing multiplayer vibe code from \$BASE ..."
VERSION_JSON=\$(curl -fsSL "\$BASE/version" 2>/dev/null || die "cannot reach \$BASE/version")
SHA=\$(printf '%s' "\$VERSION_JSON" | sed -n 's/.*"sourceSha256":"\\([a-f0-9]*\\)".*/\\1/p')
[ -n "\$SHA" ] || die "server did not advertise a source sha256 (no tarball bundled in that deployment)"

mkdir -p "\$MANAGED/current"
TMP="\$MANAGED/source-\$SHA.tar.gz"
curl -fsSL "\$BASE/source.tar.gz" -o "\$TMP" || die "download failed"

if command -v sha256sum >/dev/null 2>&1; then GOT=\$(sha256sum "\$TMP" | awk '{print \$1}')
elif command -v shasum >/dev/null 2>&1; then GOT=\$(shasum -a 256 "\$TMP" | awk '{print \$1}')
else say "warning: no sha256 tool found — skipping integrity check"; GOT="\$SHA"; fi
if [ "\$GOT" != "\$SHA" ]; then rm -f "\$TMP"; die "sha256 mismatch (\$GOT)"; fi

say "extracting to \$CURRENT ..."
rm -rf "\$CURRENT"
tar xzf "\$TMP" -C "\$MANAGED/current"
rm -f "\$TMP"

say "installing dependencies (may take a minute) ..."
(cd "\$CURRENT" && npm install --no-audit --no-fund)
(cd "\$CURRENT" && npm link --workspace @mvc/agent && npm link --workspace @mvc/node-server)

BUILT_AT=\$(printf '%s' "\$VERSION_JSON" | sed -n 's/.*"builtAt":"\\([^"]*\\)".*/\\1/p')
printf '{\\n  "sourceSha256": "%s",\\n  "builtAt": "%s",\\n  "installedAt": "%s",\\n  "serverUrl": "%s"\\n}\\n' \\
  "\$SHA" "\$BUILT_AT" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$BASE" > "\$MANAGED/meta.json"

say ""
say "✓ installed multiplayer vibe code. Next:"
say "    mvc-agent setup           # auto-register /mcp with your AI CLIs"
say "    mvc-agent create demo     # create a lobby, share the invite token"
say "    mvc-agent update --check  # stay current (auto-updates from this server)"
say "managed copy: \$CURRENT"
`;

/** Served at /install.ps1 — Windows PowerShell one-command installer. */
const PS_INSTALLER = `# multiplayer vibe code — one-command installer (Windows PowerShell).
# Downloads the MIT-licensed source, verifies its sha256, npm-installs, links
# mvc-agent onto PATH and records meta.json in the same layout the updater uses.
\$ErrorActionPreference = 'Stop'
\$Base = if (\$env:MVC_SERVER_URL) { \$env:MVC_SERVER_URL } else { 'https://__HOST__' }
\$Managed = if (\$env:MVC_MANAGED_DIR) { \$env:MVC_MANAGED_DIR } else { Join-Path \$HOME '.local\share\mvc' }
\$Current = Join-Path \$Managed 'current\multiplayer-vibe-code'

foreach (\$cmd in 'node','npm','tar.exe','curl.exe') {
  if (-not (Get-Command \$cmd -ErrorAction SilentlyContinue)) { throw "\$cmd is required — install Node.js >= 22 from https://nodejs.org first" }
}

Write-Host "installing multiplayer vibe code from \$Base ..."
\$Version = Invoke-RestMethod "\$Base/version"
if (-not \$Version.sourceSha256) { throw 'server did not advertise a source sha256 (no tarball bundled in that deployment)' }

New-Item -ItemType Directory -Force -Path (Join-Path \$Managed 'current') | Out-Null
\$Tmp = Join-Path \$Managed "source-\$(\$Version.sourceSha256).tar.gz"
Invoke-WebRequest "\$Base/source.tar.gz" -OutFile \$Tmp
\$Got = (Get-FileHash -Algorithm SHA256 \$Tmp).Hash.ToLowerInvariant()
if (\$Got -ne \$Version.sourceSha256) { Remove-Item \$Tmp -Force; throw "sha256 mismatch: \$Got" }

Write-Host "extracting to \$Current ..."
Remove-Item -Recurse -Force \$Current -ErrorAction SilentlyContinue
tar -xzf \$Tmp -C (Join-Path \$Managed 'current')
Remove-Item \$Tmp -Force

Write-Host 'installing dependencies (may take a minute) ...'
Push-Location \$Current
try {
  npm install --no-audit --no-fund
  npm link --workspace @mvc/agent
  npm link --workspace @mvc/node-server
} finally { Pop-Location }

@{ sourceSha256 = \$Version.sourceSha256; builtAt = \$Version.builtAt; installedAt = (Get-Date).ToUniversalTime().ToString('o'); serverUrl = \$Base } |
  ConvertTo-Json | Set-Content -Path (Join-Path \$Managed 'meta.json')

Write-Host ''
Write-Host '✓ installed multiplayer vibe code. Next:'
Write-Host '    mvc-agent setup           # auto-register /mcp with your AI CLIs'
Write-Host '    mvc-agent create demo     # create a lobby, share the invite token'
Write-Host '    mvc-agent update --check  # stay current (auto-updates from this server)'
Write-Host "managed copy: \$Current"
`;

/** The requested installer script with our host baked in. */
export function installScript(host: string, kind: 'sh' | 'ps1'): Response {
  const body = kind === 'sh' ? SH_INSTALLER.replace('__HOST__', host) : PS_INSTALLER.replace('__HOST__', host);
  return new Response(body, {
    headers: {
      'content-type': kind === 'sh' ? 'text/x-shellscript; charset=utf-8' : 'text/powershell; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * The public install page (auto-landed on via `/` and `/install`). Shows the
 * same commands for Windows / Ubuntu / Linux / macOS; examples use the
 * request's host so they stay correct on staging and prod.
 */
export function installationPage(request: Request): Response {
  const server = `https://${new URL(request.url).host}`;
  const body = `
    <header>
      <h1>multiplayer vibe code</h1>
      <p class="sub">A project folder owned by a lobby — synced to every device that joins,
      humans edit locally, AI models join via MCP.</p>
    </header>

    <section>
      <h2>Install the agent &mdash; one command</h2>
      <p>Requires <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js &ge; 22</a> + npm.
      Works identically on Windows, Ubuntu, Linux and macOS. No <code>cd</code>, no
      clone &mdash; the installer downloads the MIT-licensed source from this server,
      verifies its sha256, and puts <code>mvc-agent</code> on your PATH:</p>
      <pre><code>curl -fsSL ${server}/install.sh | sh          # Ubuntu / Linux / macOS
irm ${server}/install.ps1 | iex             # Windows (PowerShell)</code></pre>
      <p>Source-only alternative (manual install):</p>
      <pre><code>curl -fsSL ${server}/source.tar.gz | tar xz && cd multiplayer-vibe-code
npm install
npm link --workspace @mvc/agent
npm link --workspace @mvc/node-server</code></pre>
      <p>Verify by running it (no arguments print usage and exit):</p>
      <pre><code>mvc-agent</code></pre>
    </section>

    <section>
      <h2>Use it &mdash; the agent remembers this server</h2>
      <p>Installs don't need <code>--server</code>: the installer records where it
      came from, so every command just works:</p>
      <pre><code>mvc-agent create my-project</code></pre>
      <p><code>create</code> prints ready-to-run commands for the other devices
      (invite token already filled in) &mdash; copy-paste them:</p>
      <pre><code>mvc-agent push INVITE_TOKEN ./path/to/project
mvc-agent join INVITE_TOKEN</code></pre>
      <p>On the joining device, <code>~/Lobbies/my-project</code> appears with all
      files &mdash; subdirectories and small binaries included. Share the invite
      token (<code>lobbyId:secret</code>) with anyone; only its hash is stored.</p>
    </section>

    <section>
      <h2>Self-host a lobby on your own device</h2>
      <p>Any device with Node.js can host the lobby itself. Start the server, then
      create the lobby against it; the central directory records the public link
      so invite tokens still work, and removes it when you stop the server.</p>
      <pre><code>npm start --workspace @mvc/node-server
# optional: MVC_PUBLIC_URL=https://your-host.example MVC_REGISTRY_URL=https://mvc-server.csomeone301.workers.dev
mvc-agent create my-project --server http://localhost:8787</code></pre>
      <p>Use <code>MVC_REGISTRY_URL=off</code> for a LAN-only lobby with no central
      directory entry. Node.js &ge; 22.18 is required for built-in TypeScript support.</p>
    </section>

    <section>
      <h2>Desktop tray app</h2>
      <p>Prefer a tray icon? <code>npm start --workspace @mvc/agent</code> (Electron;
      Windows/Ubuntu/Linux). The approval UI for AI-requested commands arrives with
      models (<code>/mcp</code>, in progress).</p>
    </section>

    <section>
      <h2>Auto-update &amp; AI CLI setup</h2>
      <p><code>mvc-agent update</code> pulls the newest MIT-licensed source from this
      server (sha256-verified) and re-links the agent. <code>mvc-agent setup</code>
      auto-detects the AI CLIs you have installed (Claude Code, Cursor, Windsurf, Zed,
      Gemini) and registers the model server as an MCP server in each config:</p>
      <pre><code>mvc-agent update --check
mvc-agent setup --dry-run    # preview, touches nothing
mvc-agent setup              # register /mcp with every detected AI CLI
mvc-agent setup --remove     # unregister again</code></pre>
    </section>

    <section>
      <h2>License &amp; self-hosting</h2>
      <p><strong>MIT licensed</strong> (<a href="/license">full text</a>) and
      <strong>self-hosted</strong> &mdash; this software is distributed from this
      server, with no third-party registry or git host involved. The tarball above
      is the complete source (<a href="/source.tar.gz">download</a>), built from
      git-tracked files only, so untracked machine secrets like
      <code>.dev.vars</code> are never inside it.</p>
    </section>

    <footer class="status">
      <p>Server: <code>${server}</code> &middot; <a href="/health">/health</a> &middot;
      real-time sync: <code>/ws</code> (CRDT, both directions, shipped) &middot;
      models via <code>/mcp</code> (next milestone).</p>
    </footer>`;
  return html('multiplayer vibe code — install', body);
}

export function html(title: string, body: string): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body{font:16px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:720px;padding:0 1rem;color:#1c1e21}
      code{background:#f2f2f2;padding:2px 5px;border-radius:4px;font-size:.92em}
      pre{background:#0f172a;color:#e2e8f0;padding:1rem 1.25rem;border-radius:8px;overflow-x:auto}
      pre code{background:none;padding:0;color:inherit}
      h1{margin-bottom:.2rem}
      h2{margin-top:2.2rem;border-top:1px solid #e5e7eb;padding-top:1.4rem}
      .sub{color:#4b5563;margin-top:0}
      a{color:#2563eb}
      .status{border-top:1px solid #e5e7eb;margin-top:2.5rem;color:#4b5563;font-size:.92rem}
    </style>
    </head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}