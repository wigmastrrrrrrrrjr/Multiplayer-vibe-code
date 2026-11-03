/** @typedef {import('@mvc/shared').DeviceInfo} DeviceInfo */
import { EventEmitter } from 'node:events';
import { constants as fsConstants, promises as fs, readFileSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chokidar from 'chokidar';
import {
  applyTextUpdate,
  createTextDoc,
  DEFAULTS,
  fromBase64,
  fullStateOf,
  isIgnored,
  replaceText,
  sha256Hex,
  textOf,
  toBase64,
} from '@mvc/shared';

/**
 * Sync engine shared by the Electron tray app and the headless CLI.
 *
 * M1 capabilities:
 *  - createLobby / join    (REST against the Worker)
 *  - syncLobby             (WebSocket: hello → snapshot)
 *  - materialize           (write the snapshot into ~/Lobbies/<project>)
 *  - pushDir               (one-shot upload of a local folder via REST PUT)
 *
 * M3 (live sync, CRDT merge + persistence):
 *  - watch(dir, { ws })    chokidar watcher → diff-based Yjs updates pushed to
 *                          the lobby DO; remote updates applied to disk.
 *  - applyRemote           files/deletes/renames/binaries/chat from the wire.
 *  - applySnapshotBaselines  build mirrors from the snapshot's `docs` full-state
 *                          blobs so every device shares item structure.
 *  - chat(ws, body)        send a lobby chat message.
 */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const __dirname = dirname(fileURLToPath(import.meta.url));

export class SyncEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.serverUrl]  base URL of the Worker, e.g. https://…workers.dev
   * @param {string} [opts.lobbyHome]  parent dir for lobby folders (default: ~/Lobbies)
   * @param {object} [opts.log]
   */
  constructor({ serverUrl, lobbyHome = join(homedir(), 'Lobbies'), log = console } = {}) {
    super();
    this.serverUrl = serverUrl ?? process.env.MVC_SERVER_URL ?? '';
    this.lobbyHome = lobbyHome;
    this.log = log;
    /** @type {import('node:events').EventEmitter} */
    this.sessions = new EventEmitter();
    this.activeWss = new Set();
    /** Live-sync state (per local mirror, keyed by lobby-relative POSIX path). */
    this.live = {
      /** @type {Map<string, import('yjs').Doc>} text-file mirrors */
      docs: new Map(),
      /** @type {Map<string, string>} binary content hashes (echo guard) */
      hashes: new Map(),
      /** paths whose full lineage is known to the server (see applySnapshotBaselines) */
      baselineEstablished: new Set(),
      /** paths we just wrote ourselves — skip the watcher's re-read */
      suppressWrite: new Set(),
      /** @type {Map<string, ReturnType<typeof setTimeout>>} per-path debounce timers */
      timers: new Map(),
    };
    /** @type {Map<string, string[]>} cached .lobbyignore patterns per lobby dir */
    this.ignorePatterns = new Map();
  }

  /** Extra ignore patterns from `<dir>/.lobbyignore` (cached per directory). */
  _patterns(dir) {
    const cached = this.ignorePatterns.get(dir);
    if (cached) return cached;
    const patterns = loadLobbyIgnoreSync(dir);
    this.ignorePatterns.set(dir, patterns);
    return patterns;
  }

  /* REST ------------------------------------------------------------------- */

  /** @returns {Promise<import('@mvc/shared').CreateLobbyResponse>} */
  async createLobby(name) {
    if (!this.serverUrl) throw new Error('SyncEngine: serverUrl not configured');
    const res = await fetch(`${this.serverUrl}/lobbies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`createLobby ${res.status}: ${body.error ?? 'failed'}`);
    return body;
  }

  /** @returns {Promise<import('@mvc/shared').JoinLobbyResponse>} */
  async join(inviteToken, { name, device } = {}) {
    if (!this.serverUrl) throw new Error('SyncEngine: serverUrl not configured');
    const res = await fetch(`${this.serverUrl}/lobbies/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken,
        name: (name ?? hostname()).slice(0, 60),
        device: device ?? defaultDevice(),
      }),
    });
    const body = await res.json();
    if (res.status === 409 && typeof body.hostUrl === 'string') {
      // The lobby is self-hosted: the directory told us where the owner's
      // device is. Retry the join (and later file/ws traffic) against it.
      const host = body.hostUrl.replace(/\/+$/, '');
      if (host && host !== this.serverUrl) {
        this.serverUrl = host;
        return this.join(inviteToken, { name, device });
      }
    }
    if (!res.ok) throw new Error(`join ${res.status}: ${body.error ?? 'failed'}`);
    return body;
  }

  /** One-shot upload of every non-ignored file under `localDir`.
   *  @returns {Promise<{uploaded: number, skipped: string[]}>} */
  async pushDir(localDir, { memberToken, lobbyId, name }) {
    const patterns = loadLobbyIgnoreSync(localDir);
    const files = await walkDir(localDir, '', patterns);
    let uploaded = 0;
    /** @type {string[]} */
    const skipped = [];
    for (const rel of files) {
      if (isIgnored(rel, patterns)) continue;
      const abs = join(localDir, rel);
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch {
        skipped.push(`${rel} (unreadable)`);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        skipped.push(`${rel} (not a regular file)`);
        continue;
      }
      if (stat.size > DEFAULTS.maxBinaryBytes) {
        skipped.push(`${rel} (too large)`);
        continue;
      }
      const buf = await readFileNoFollow(abs);
      const kind = sniffBufferKind(buf.subarray(0, 8192));
      const put =
        kind === 'text'
          ? { content: buf.toString('utf8') }
          : { content_base64: toBase64(new Uint8Array(buf)) };
      const res = await fetch(`${this.serverUrl}/lobbies/${lobbyId}/files`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${memberToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ path: rel, ...put }),
      });
      const body = await res.json();
      if (!res.ok) {
        skipped.push(`${rel} (${res.status}: ${body.error ?? 'failed'})`);
        continue;
      }
      uploaded += 1;
      if (uploaded % 50 === 0) {
        this.log.info?.(`[push] ${uploaded} files… (${name ?? ''})`);
      }
    }
    this.log.info?.(`[push] done: ${uploaded} uploaded, ${skipped.length} skipped`);
    return { uploaded, skipped };
  }

  /* WebSocket session ------------------------------------------------------- */

  /**
   * Connect to a lobby, say hello, wait for the snapshot.
   * Keeps the socket open; emits 'msg' (parsed), 'hello.ok', 'snapshot', 'event'.
   * @returns {Promise<{ws: WebSocket, snapshot: import('@mvc/shared').LobbySnapshot}>}
   */
  async syncLobby({ wsUrl, memberToken, device, name }) {
    const url = new URL(wsUrl);
    url.searchParams.set('token', memberToken);
    const ws = new WebSocket(url.href);
    this.activeWss.add(ws);
    let settled = false;

    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', () => resolveOpen());
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          rejectOpen(new Error('ws connect failed'));
        }
      });
    });

    const snapshotPromise = this.waitFor('snapshot', 15_000);

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.emit('msg', { ws, msg });
      this.sessions.emit(msg.t, msg);
    });
    ws.addEventListener('close', (event) => {
      this.activeWss.delete(ws);
      this.emit('close', { ws, code: event.code, reason: event.reason });
    });

    ws.send(
      JSON.stringify({
        t: 'hello',
        device: device ?? defaultDevice(),
        name: (name ?? hostname()).slice(0, 60),
      }),
    );
    this.log.info?.('[sync] connected, waiting for snapshot…');

    const snapshot = await snapshotPromise;
    return { ws, snapshot };
  }

  /** First message with t === type arriving in `timeoutMs`. */
  waitFor(type, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessions.off(type, onMsg);
        reject(new Error(`timeout waiting for "${type}"`));
      }, timeoutMs);
      const onMsg = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.sessions.once(type, onMsg);
    });
  }

  closeAll() {
    for (const ws of this.activeWss) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    this.activeWss.clear();
  }

  /* Folder materialization -------------------------------------------------- */

  /**
   * Write a snapshot into `lobbyHome/<lobbyName>`. Creates directories, writes
   * text + binary files. M1 never deletes local files it didn't manage (no
   * reconciliation yet — that's M2).
   * @returns {Promise<{dir: string, wrote: string[]}>}
   */
  async materialize(snapshot, { lobbyName, deviceName }) {
    const dir = join(this.lobbyHome, sanitizeDirName(lobbyName ?? deviceName ?? 'lobby'));
    await fs.mkdir(dir, { recursive: true });
    const wrote = [];
    const patterns = this._patterns(dir);
    for (const entry of snapshot.entries ?? []) {
      if (isIgnored(entry.path, patterns)) continue;
      const content = snapshot.files?.[entry.path];
      if (content !== undefined) {
        if (await safeWriteFile(dir, entry.path, content)) wrote.push(entry.path);
        continue;
      }
      const b64 = snapshot.binaries?.[entry.path];
      if (b64 !== undefined) {
        if (await safeWriteFile(dir, entry.path, Buffer.from(b64, 'base64'))) {
          wrote.push(entry.path);
        }
      }
    }
    if (wrote.includes('.lobbyignore')) {
      this.ignorePatterns.set(dir, loadLobbyIgnoreSync(dir));
    }
    this.log.info?.(`[sync] materialized ${wrote.length} files into ${dir}`);
    return { dir, wrote };
  }

  /* Live sync (M3: CRDT merge + persistence) ----------------------------------- */

  /**
   * Establish text-file mirrors from a snapshot's `docs` blobs (the DO persists
   * the merged Yjs full state per path; applying the same blob on every device
   * makes all mirrors share item structure, so later deltas resolve cleanly).
   * Paths without a blob stay plain-text baselines — their first local edit
   * publishes full state (see _flushText).
   */
  applySnapshotBaselines(snapshot) {
    for (const [path, b64] of Object.entries(snapshot?.docs ?? {})) {
      try {
        const doc = createTextDoc('');
        applyTextUpdate(doc, fromBase64(b64));
        this.live.docs.set(path, doc);
        this.live.baselineEstablished.add(path);
      } catch {
        // Malformed blob — leave the plain-text baseline path in charge.
      }
    }
  }

  /**
   * Watch a lobby folder and push local changes to the connected WebSocket.
   * Returns `{ close }`. Remote messages arrive via applyRemote().
   */
  watch(dir, { ws }) {
    const rel = (abs) => relative(dir, abs).split(sep).join('/');
    const patterns = this._patterns(dir);
    const updater = chokidar.watch(dir, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p) => {
        if (p === dir) return false;
        return isIgnored(rel(p), patterns);
      },
    });
    updater
      .on('add', (p) => this._scheduleFlush(dir, rel(p), ws))
      .on('change', (p) => this._scheduleFlush(dir, rel(p), ws))
      .on('unlink', (p) => this._flushDelete(dir, rel(p), ws))
      .on('error', (e) => this.log.warn?.(`[live] watcher: ${e.message}`));
    const pinger = setInterval(() => {
      this._send(ws, { t: 'ping' });
    }, 30_000);
    this.log.info?.(`[live] watching ${dir}`);
    return {
      close: async () => {
        clearInterval(pinger);
        for (const t of this.live.timers.values()) clearTimeout(t);
        this.live.timers.clear();
        await updater.close();
      },
    };
  }

  _scheduleFlush(dir, rel, ws) {
    const prev = this.live.timers.get(rel);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.live.timers.delete(rel);
      this.flushOne(dir, rel, ws).catch((e) => {
        this.log.warn?.(`[live] ${rel}: ${e.message}`);
      });
    }, DEFAULTS.syncDebounceMs);
    this.live.timers.set(rel, timer);
  }

  /**
   * Read one locally-changed path and publish it: text files become Yjs
   * transaction updates (diff-based), binaries become whole-file puts with
   * hash dedupe. Echo guard: if the disk content already matches the mirror
   * (e.g. a file we just applied from a remote update), nothing is sent.
   */
  async flushOne(dir, rel, ws) {
    if (this.live.suppressWrite.has(rel)) {
      this.live.suppressWrite.delete(rel);
      return;
    }
    if (isIgnored(rel, this._patterns(dir))) return;
    const abs = safeJoin(dir, rel);
    if (!abs) return;
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) return;
    const kind = await sniffFileKind(abs);
    if (kind === 'text') await this._flushText(abs, rel, ws);
    else await this._flushBinary(abs, rel, ws);
  }

  async _flushText(abs, rel, ws) {
    const next = (await readFileNoFollow(abs)).toString('utf8');
    const doc = this._ensureMirror(rel, next);
    if (!this.live.baselineEstablished.has(rel)) {
      // First touch of a path the server doesn't know our lineage for: publish
      // a self-contained full state so the DO + other devices share it.
      replaceText(doc, next);
      this.live.baselineEstablished.add(rel);
      this._send(ws, { t: 'doc.sync', path: rel, update: toBase64(fullStateOf(doc)) });
      return;
    }
    for (const update of replaceText(doc, next)) {
      this._send(ws, { t: 'doc.sync', path: rel, update: toBase64(update) });
    }
  }

  async _flushBinary(abs, rel, ws) {
    const buf = new Uint8Array(await readFileNoFollow(abs));
    if (buf.byteLength > DEFAULTS.maxBinaryBytes) return;
    const hash = await sha256Hex(toBase64(buf));
    if (this.live.hashes.get(rel) === hash) return; // echo guard
    this.live.hashes.set(rel, hash);
    this._send(ws, {
      t: 'binary.put',
      path: rel,
      hash,
      size: buf.byteLength,
      data: toBase64(buf),
    });
  }

  async _flushDelete(dir, rel, ws) {
    this.live.docs.delete(rel);
    this.live.hashes.delete(rel);
    this.live.baselineEstablished.delete(rel);
    this._send(ws, { t: 'file.delete', path: rel });
  }

  _ensureMirror(rel, initialText) {
    let doc = this.live.docs.get(rel);
    if (!doc) {
      doc = createTextDoc(initialText);
      this.live.docs.set(rel, doc);
    }
    return doc;
  }

  /**
   * Apply a message received from the lobby DO to the local folder.
   * `dir` is the materialized lobby path. Emits 'chat' for chat messages.
   */
  async applyRemote(dir, msg) {
    const patterns = this._patterns(dir);
    switch (msg.t) {
      case 'doc.update': {
        const rel = msg.path;
        if (isIgnored(rel, patterns)) return;
        const abs = safeJoin(dir, rel);
        if (!abs) return;
        const existingDoc = this.live.docs.get(rel);
        if (existingDoc && this.live.baselineEstablished.has(rel)) {
          // Established mirror shares the server lineage → plain merge.
          applyTextUpdate(existingDoc, fromBase64(msg.update));
        } else {
          // No usable mirror: ADOPT the server's lineage for this path wholesale.
          // Never fabricate a plain-text baseline here — merging a full state
          // (or a delta) into a fabricated doc would duplicate content.
          const adopted = createTextDoc('');
          applyTextUpdate(adopted, fromBase64(msg.update));
          this.live.docs.set(rel, adopted);
          this.live.baselineEstablished.add(rel);
        }
        const doc = this.live.docs.get(rel);
        if (await safeWriteFile(dir, rel, textOf(doc))) {
          this.live.suppressWrite.add(rel);
          this.live.hashes.delete(rel);
        }
        break;
      }
      case 'file.deleted': {
        if (isIgnored(msg.path, patterns)) return;
        if (await safeRemove(dir, msg.path)) {
          this.live.suppressWrite.add(msg.path);
        }
        this.live.docs.delete(msg.path);
        this.live.hashes.delete(msg.path);
        this.live.baselineEstablished.delete(msg.path);
        break;
      }
      case 'file.renamed': {
        if (isIgnored(msg.from, patterns) || isIgnored(msg.to, patterns)) return;
        if (await safeRename(dir, msg.from, msg.to)) {
          this.live.suppressWrite.add(msg.from);
          this.live.suppressWrite.add(msg.to);
        }
        const doc = this.live.docs.get(msg.from);
        if (doc) {
          this.live.docs.set(msg.to, doc);
          this.live.docs.delete(msg.from);
        }
        const hash = this.live.hashes.get(msg.from);
        if (hash !== undefined) {
          this.live.hashes.set(msg.to, hash);
          this.live.hashes.delete(msg.from);
        }
        if (this.live.baselineEstablished.has(msg.from)) {
          this.live.baselineEstablished.delete(msg.from);
          this.live.baselineEstablished.add(msg.to);
        }
        break;
      }
      case 'binary.update': {
        if (isIgnored(msg.path, patterns)) return;
        if (await safeWriteFile(dir, msg.path, Buffer.from(msg.data, 'base64'))) {
          this.live.suppressWrite.add(msg.path);
          this.live.hashes.set(msg.path, msg.hash);
        }
        break;
      }
      case 'binary.put.ok': {
        this.live.hashes.set(msg.path, msg.hash);
        break;
      }
      case 'chat.message': {
        this.emit('chat', msg.message);
        break;
      }
      default:
        break;
    }
  }

  /** Send a chat message to the lobby. */
  chat(ws, body) {
    this._send(ws, {
      t: 'chat.send',
      body: String(body ?? '').slice(0, DEFAULTS.maxChatLength),
      mentions: [],
    });
  }

  _send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }
}

/* Helpers ------------------------------------------------------------------- */

/** @returns {DeviceInfo} */
export function defaultDevice(name) {
  return {
    id: `${hostname()}-${platform()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux',
    name: name ?? hostname(),
    os: `${platform()} ${release()}`,
  };
}

/** Directory name safe on Windows + POSIX; NO slash/colon/star/etc. */
export function sanitizeDirName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .trim();
  return cleaned || 'lobby';
}

/** Join a relative lobby path under root, refusing traversal. Returns null if unsafe. */
export function safeJoin(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null;
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('\0')) return null;
  const target = resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** Load `.lobbyignore` (one pattern per line, `#` comments) from a lobby dir. */
export function loadLobbyIgnoreSync(dir) {
  try {
    return readFileSync(join(dir, '.lobbyignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

async function lstatOrNull(abs) {
  try {
    return await fs.lstat(abs);
  } catch {
    return null;
  }
}

/**
 * Walk every parent component below `root`, refusing symlinks and non-directory
 * entries, creating missing directories one level at a time. Returns the parent
 * directory path, or null when the path is unsafe.
 */
async function ensureSafeParent(root, rel) {
  const parts = rel.replaceAll('\\', '/').split('/');
  parts.pop();
  let cur = resolve(root);
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    cur = join(cur, part);
    let st = await lstatOrNull(cur);
    if (!st) {
      try {
        await fs.mkdir(cur);
      } catch {
        return null;
      }
      st = await lstatOrNull(cur);
      if (!st) return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return cur;
}

/** Write a lobby file without ever following a symlink. Returns false if unsafe. */
export async function safeWriteFile(root, rel, data) {
  const abs = safeJoin(root, rel);
  if (!abs) return false;
  if (!(await ensureSafeParent(root, rel))) return false;
  const st = await lstatOrNull(abs);
  if (st && (st.isSymbolicLink() || !st.isFile())) return false;
  let fh;
  try {
    fh = await fs.open(
      abs,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return false;
  }
  try {
    if (typeof data === 'string') await fh.writeFile(data, 'utf8');
    else await fh.writeFile(data);
    return true;
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Delete a lobby file without following symlinked parent components. */
export async function safeRemove(root, rel) {
  const abs = safeJoin(root, rel);
  if (!abs) return false;
  if (!(await ensureSafeParent(root, rel))) return false;
  try {
    await fs.rm(abs, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Rename within a lobby, refusing symlinked sources/targets/parents. */
export async function safeRename(root, fromRel, toRel) {
  const from = safeJoin(root, fromRel);
  const to = safeJoin(root, toRel);
  if (!from || !to) return false;
  if (!(await ensureSafeParent(root, fromRel))) return false;
  if (!(await ensureSafeParent(root, toRel))) return false;
  const fromStat = await lstatOrNull(from);
  if (!fromStat || fromStat.isSymbolicLink() || !fromStat.isFile()) return false;
  const toStat = await lstatOrNull(to);
  if (toStat && (toStat.isSymbolicLink() || !toStat.isFile())) return false;
  try {
    await fs.rename(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Read a regular file, refusing to follow a final-component symlink. */
export async function readFileNoFollow(abs) {
  const fh = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    return await fh.readFile();
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Recursively list non-ignored relative POSIX paths under a directory. */
export async function walkDir(dir, rel = '', extraPatterns = []) {
  /** @type {string[]} */
  const out = [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    if (isIgnored(childRel, extraPatterns)) continue;
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push(...(await walkDir(abs, childRel, extraPatterns)));
    } else if (stat.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

/** Text vs binary heuristic over a byte view (NUL bytes or invalid UTF-8 = binary). */
export function sniffBufferKind(view) {
  if (view.includes(0)) return 'binary';
  try {
    UTF8_DECODER.decode(view);
    return 'text';
  } catch {
    return 'binary';
  }
}

/**
 * Text vs binary heuristic for M1 uploads: read the head, treat as text only
 * when it decodes as strict UTF-8 without NUL bytes.
 */
export async function sniffFileKind(abs) {
  const fh = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return 'binary';
    const head = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return sniffBufferKind(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export { __dirname as AGENT_DIR };