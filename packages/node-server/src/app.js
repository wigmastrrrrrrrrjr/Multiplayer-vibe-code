import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lobby } from '@mvc/server-do';
import { memberTokenLobbyId } from '@mvc/shared';
import { WebSocketServer } from 'ws';
import { FileStorage, lobbyState, storagePath } from './storage.js';
import {
  RegistryClient,
  defaultDataDir,
  defaultRegistryUrl,
  isDisabled,
} from './registry.js';

const LOBBY_ID_RE = /^[0-9a-f]{64}$/i;
const MAX_BODY_BYTES = 100 * 1024 * 1024;

/**
 * Build a self-hosted lobby server on plain Node.js (no Cloudflare/workerd).
 * The caller listens on the returned HTTP server.
 */
export async function createApp(options = {}) {
  const log = options.log ?? console;
  const dataDir = options.dataDir ?? process.env.MVC_DATA_DIR ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const signingSecret = options.signingSecret ?? loadSigningSecret(dataDir);
  const registryUrl = options.registryUrl ?? registryUrlFromEnv();
  const publicUrl = (options.publicUrl ?? process.env.MVC_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const registry = new RegistryClient({ baseUrl: registryUrl, publicUrl, log, dataDir });
  const lobbies = new Map();

  function lobbyFor(id) {
    if (!LOBBY_ID_RE.test(id)) return null;
    const cached = lobbies.get(id);
    if (cached) return cached;
    const storage = new FileStorage(storagePath(dataDir, id));
    const lobby = new Lobby(lobbyState(id, storage), { MCP_SIGNING_SECRET: signingSecret });
    lobbies.set(id, lobby);
    return lobby;
  }

  function hostUrlFor(req) {
    if (publicUrl) return publicUrl;
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() ||
      (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const body = await readBody(req);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, {
        ok: true,
        service: 'mvc-node-server',
        lobbies: lobbies.size,
        registry: registry.enabled,
      });
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      return sendJson(res, {
        name: 'multiplayer-vibe-code',
        version: '0.0.0',
        selfHosted: true,
        registryUrl: registry.enabled ? registry.baseUrl : null,
      });
    }
    if (req.method === 'POST' && url.pathname === '/lobbies') {
      return createLobby(req, res, body, hostUrlFor(req));
    }
    if (req.method === 'POST' && url.pathname === '/lobbies/join') {
      return joinLobby(req, res, body, hostUrlFor(req));
    }

    const match = url.pathname.match(/^\/lobbies\/([^/]+)(\/[^/]*)?$/);
    if (!match) return sendJson(res, { error: 'not found' }, 404);
    const lobbyId = decodeURIComponent(match[1]);
    const lobby = lobbyFor(lobbyId);
    if (!lobby) return sendJson(res, { error: 'lobby not found' }, 404);
    const sub = match[2] ?? '';
    if (sub === '') {
      if (req.method !== 'GET') return sendJson(res, { error: 'method not allowed' }, 405);
      return forward(req, res, lobby, '/info', body);
    }
    if (!['/files', '/snapshot'].includes(sub)) {
      return sendJson(res, { error: 'not found' }, 404);
    }
    const allowed = sub === '/files' ? ['GET', 'PUT'] : ['GET'];
    if (!allowed.includes(req.method ?? 'GET')) {
      return sendJson(res, { error: 'method not allowed' }, 405);
    }
    return forward(req, res, lobby, sub, body);
  }

  async function createLobby(req, res, body, hostUrl) {
    const parsed = parseJson(body);
    const name = String(parsed?.name ?? '').trim().slice(0, 80);
    if (!name) return sendJson(res, { error: 'name required' }, 400);

    const lobbyId = randomBytes(32).toString('hex');
    const lobby = lobbyFor(lobbyId);
    const init = await lobby.fetch(
      new Request('https://lobby.local/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
    const created = await init.json();
    if (!init.ok) return sendJson(res, created, init.status);

    if (registry.enabled) {
      try {
        await registry.register({ lobbyId, name, hostUrl });
        log.info?.(`[registry] registered ${lobbyId.slice(0, 12)}… at ${hostUrl}`);
      } catch (err) {
        log.warn?.(`[registry] register failed (local-only lobby): ${err.message}`);
      }
    }

    return sendJson(res, {
      ...created,
      wsUrl: `${hostUrl.replace(/^http/, 'ws')}/ws`,
      serverUrl: hostUrl,
    });
  }

  async function joinLobby(req, res, body, hostUrl) {
    const parsed = parseJson(body);
    const invite = String(parsed?.inviteToken ?? '');
    const colon = invite.indexOf(':');
    const lobbyId = colon > 0 ? invite.slice(0, colon) : '';
    const lobby = lobbyFor(lobbyId);
    if (!lobby) return sendJson(res, { error: 'invalid invite token' }, 401);

    const response = await forwardRaw(req, lobby, '/join', body);
    if (!response.ok) return sendResponse(res, response);
    const joined = await response.json();
    return sendJson(res, {
      ...joined,
      wsUrl: `${hostUrl.replace(/^http/, 'ws')}/ws`,
      serverUrl: hostUrl,
    });
  }

  function forward(req, res, lobby, path, body) {
    return forwardRaw(req, lobby, path, body).then((response) => sendResponse(res, response));
  }

  function forwardRaw(req, lobby, path, body) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) init.body = body;
    return lobby.fetch(new Request(`https://lobby.local${path}`, init));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error?.('node-server error:', err);
      if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500);
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      const lobbyId = memberTokenLobbyId(token) ?? '';
      const lobby = lobbyFor(lobbyId);
      const member = lobby ? await lobby.memberFromToken(token) : null;
      if (!lobby || !member) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        lobby.attachSocket(new SocketAdapter(ws), member.id);
      });
    } catch (err) {
      log.warn?.(`[ws] upgrade failed: ${err.message}`);
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const id of registry.ids()) registry.heartbeat(id).catch(() => {});
  }, 30_000);
  heartbeat.unref?.();

  const close = async () => {
    clearInterval(heartbeat);
    for (const id of registry.ids()) await registry.unregister(id);
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, wss, close, registry, dataDir, signingSecret };
}

class SocketAdapter {
  constructor(ws) {
    this.ws = ws;
  }

  send(data) {
    this.ws.send(data);
  }

  close(code, reason) {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  addEventListener(type, handler) {
    if (type === 'message') {
      this.ws.on('message', (data, isBinary) => {
        handler({ data: isBinary ? data : data.toString() });
      });
    } else if (type === 'close') {
      this.ws.on('close', () => handler({}));
    } else if (type === 'error') {
      this.ws.on('error', () => handler({}));
    }
  }
}

function loadSigningSecret(dataDir) {
  if (process.env.MCP_SIGNING_SECRET) return process.env.MCP_SIGNING_SECRET;
  const file = join(dataDir, 'signing-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

function registryUrlFromEnv() {
  const value = process.env.MVC_REGISTRY_URL;
  if (value === undefined) return defaultRegistryUrl();
  return isDisabled(value) ? '' : value;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(body) {
  if (!body.length) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, body, status = 200) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
  });
  res.end(data);
}

async function sendResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) headers[key] = value;
  const data = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(data);
}
