import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Client for the central lobby directory (the Cloudflare Worker's /registry
 * endpoints). Registration is best-effort: a self-hosted server still works on
 * its LAN without the directory, it just cannot be discovered by invite token.
 */
export class RegistryClient {
  constructor({ baseUrl, publicUrl, log = console, dataDir }) {
    this.baseUrl = (baseUrl ?? '').replace(/\/+$/, '');
    this.publicUrl = (publicUrl ?? '').replace(/\/+$/, '');
    this.log = log;
    const dir = dataDir ?? process.env.MVC_DATA_DIR ?? defaultDataDir();
    this.secrets = new SecretStore(join(dir, 'registry.json'));
  }

  get enabled() {
    return this.baseUrl.length > 0;
  }

  async register({ lobbyId, name, hostUrl }) {
    if (!this.enabled) return null;
    const res = await fetch(`${this.baseUrl}/registry/lobbies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lobbyId, name, hostUrl }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`registry register ${res.status}: ${body.error ?? 'failed'}`);
    this.secrets.set(lobbyId, { secret: body.registrationSecret, hostUrl });
    return body;
  }

  async heartbeat(lobbyId) {
    if (!this.enabled) return false;
    const saved = this.secrets.get(lobbyId);
    if (!saved) return false;
    try {
      const res = await fetch(`${this.baseUrl}/registry/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lobbyId, registrationSecret: saved.secret }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404 || res.status === 403) {
        this.secrets.delete(lobbyId);
        return false;
      }
      return res.ok;
    } catch (err) {
      this.log.warn?.(`[registry] heartbeat ${lobbyId.slice(0, 8)}: ${err.message}`);
      return false;
    }
  }

  async unregister(lobbyId) {
    if (!this.enabled) return;
    const saved = this.secrets.get(lobbyId);
    if (!saved) return;
    try {
      await fetch(`${this.baseUrl}/registry/${lobbyId}`, {
        method: 'DELETE',
        headers: { 'x-mvc-registration-secret': saved.secret },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* best effort */
    }
    this.secrets.delete(lobbyId);
  }

  savedHost(lobbyId) {
    return this.secrets.get(lobbyId)?.hostUrl;
  }

  ids() {
    return this.secrets.ids();
  }
}

export class SecretStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(id) {
    return this.data[id];
  }

  set(id, value) {
    this.data[id] = value;
    this.flush();
  }

  delete(id) {
    if (!(id in this.data)) return;
    delete this.data[id];
    this.flush();
  }

  ids() {
    return Object.keys(this.data);
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

export function defaultDataDir() {
  return join(homedir(), '.local', 'share', 'mvc', 'server');
}

export function defaultRegistryUrl() {
  return process.env.MVC_REGISTRY_URL ?? 'https://mvc-server.csomeone301.workers.dev';
}

export function isDisabled(value) {
  return value === '' || value === '0' || value === 'off' || value === 'false';
}
