import {
  applyTextUpdate,
  fromBase64,
  fullStateOf,
  isIgnored,
  MEMBER_TOKEN_TTL_MS,
  newInviteToken,
  parseInviteToken,
  sha256Hex,
  signMemberToken,
  toBase64,
  verifyMemberToken,
} from '@mvc/shared';
import * as Y from 'yjs';
import type {
  ChatMessage,
  DeviceInfo,
  FileIndexEntry,
  FilePutRequest,
  JoinLobbyRequest,
  LobbySnapshot,
  Member,
  MemberKind,
} from '@mvc/shared';
import { DEFAULTS } from '@mvc/shared';
import type { Lobby as LobbyRecord } from '@mvc/shared';

/** Env the Lobby DO sees (subset of the Worker's binding surface). */
export interface LobbyEnv {
  MCP_SIGNING_SECRET: string;
}

/** DO storage keys (SQLite tables via the DO storage API's key-value surface). */
export const KEYS = {
  lobby: (id: string) => `lobby:${id}`,
  members: (lobbyId: string) => `members:${lobbyId}`, // Member[] (JSON)
  fileIndex: (lobbyId: string) => `fileindex:${lobbyId}`, // FileIndexEntry[]
  fileContent: (lobbyId: string, path: string) => `f:${lobbyId}:${path}`,
  /** Yjs update blobs accumulate per file; keyed for range reads (M2+). */
  yDoc: (lobbyId: string, path: string) => `y:${lobbyId}:${path}`,
  chat: (lobbyId: string, id: string) => `chat:${lobbyId}:${id}`,
  chatIndex: (lobbyId: string) => `chatindex:${lobbyId}`,
  lock: (lobbyId: string, path: string) => `lock:${lobbyId}:${path}`,
  command: (lobbyId: string, id: string) => `cmd:${lobbyId}:${id}`,
  totalBytes: (lobbyId: string) => `totalbytes:${lobbyId}`,
} as const;

const MAX_PATH_LENGTH = 1_000;
const WS_HELLO_TIMEOUT_MS = 10_000;

/** M1 interim content size cap for a single text file (until CRDT chunking). */
const MAX_TEXT_FILE_BYTES = DEFAULTS.maxUpdateBytes;

/**
 * One Durable Object per lobby. Owns the canonical state:
 *  - lobby record + invite-token hash, member registry (DO SQLite)
 *  - file index + raw content (M1), Yjs update blobs (M2+)
 *  - the event bus (broadcasts to connected sync agents)
 *  - agent file locks, pending commands, chat history (M4+)
 */
export class Lobby {
  readonly id: string;
  private readonly storage: DurableObjectStorage;
  private readonly env: LobbyEnv;
  /** server-side sockets → memberId (only authenticated, post-hello sessions). */
  private readonly sessions = new Map<WebSocket, string>();
  /** in-memory Y.Doc per path (lazy-loaded from persisted yDoc blobs, M3). */
  private readonly docs = new Map<string, Y.Doc>();
  /** cached total file bytes for quota enforcement (null = load from storage). */
  private totalBytes: number | null = null;

  constructor(state: DurableObjectState, env: LobbyEnv) {
    this.id = state.id.toString();
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case 'POST /init':
        return this.createLobby(request);
      case 'POST /join':
        return this.joinLobby(request);
      case 'GET /files':
        return this.listFiles(request);
      case 'PUT /files':
        return this.putFile(request);
      case 'GET /snapshot':
        return this.getSnapshot(request);
      case 'GET /info':
        return this.info();
      case 'GET /health':
        return this.health();
      default:
        break;
    }

    if (url.pathname === '/ws') return this.ws(request, url);
    return json({ error: 'lobby: not found', route }, 404);
  }

  /* Lobby lifecycle -------------------------------------------------------- */

  private async createLobby(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { name?: string } | null;
    const name = (body?.name ?? '').trim().slice(0, 80);
    if (!name) return json({ error: 'name is required' }, 400);

    if (await this.getRecord()) return json({ error: 'lobby already exists' }, 409);

    const inviteToken = newInviteToken(this.id);
    const record: LobbyRecord = {
      id: this.id,
      name,
      createdAt: Date.now(),
      inviteTokenHash: await sha256Hex(inviteToken),
    };
    await this.storage.put(KEYS.lobby(this.id), JSON.stringify(record));
    return json({ lobbyId: this.id, lobbyName: name, inviteToken });
  }

  private async joinLobby(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as JoinLobbyRequest | null;
    if (!body || typeof body.inviteToken !== 'string') {
      return json({ error: 'inviteToken required' }, 400);
    }
    const name = (body.name ?? '').trim().slice(0, 60);
    if (!name || !body.device) return json({ error: 'name and device required' }, 400);

    const record = await this.getRecord();
    if (!record) return json({ error: 'lobby not found' }, 404);

    const parsed = parseInviteToken(body.inviteToken);
    if (!parsed || parsed.lobbyId !== this.id) {
      return json({ error: 'invalid invite token' }, 401);
    }
    if ((await sha256Hex(body.inviteToken)) !== record.inviteTokenHash) {
      return json({ error: 'invalid invite token' }, 401);
    }

    const members = await this.getMembers();
    if (members.length >= DEFAULTS.maxMembersPerLobby) {
      return json({ error: 'lobby is full' }, 429);
    }
    const member: Member = {
      id: crypto.randomUUID(),
      lobbyId: this.id,
      name,
      kind: 'human',
      device: body.device,
      joinedAt: Date.now(),
    };
    members.push(member);
    await this.saveMembers(members);

    const memberToken = await signMemberToken(this.env.MCP_SIGNING_SECRET, {
      mid: member.id,
      lid: this.id,
      exp: Date.now() + MEMBER_TOKEN_TTL_MS,
    });

    return json({
      lobbyId: this.id,
      lobbyName: record.name,
      memberId: member.id,
      memberToken,
    });
  }

  /* Files -------------------------------------------------------------------- */

  private async listFiles(request: Request): Promise<Response> {
    const member = await this.requireMember(request);
    if (!member) return json({ error: 'unauthorized' }, 401);
    return json({ entries: await this.getFileIndex() });
  }

  private async putFile(request: Request): Promise<Response> {
    const member = await this.requireMember(request);
    if (!member) return json({ error: 'unauthorized' }, 401);

    const body = (await request.json().catch(() => null)) as FilePutRequest | null;
    const err = validateFilePut(body);
    if (err) return json({ error: err }, 400);

    const { path } = body!;
    const isBinary = body!.content_base64 !== undefined;
    const raw = isBinary ? body!.content_base64! : body!.content!;
    const bytes = isBinary ? fromBase64(body!.content_base64!) : null;
    const size = bytes ? bytes.byteLength : new TextEncoder().encode(raw).byteLength;

    if (size > (isBinary ? DEFAULTS.maxBinaryBytes : MAX_TEXT_FILE_BYTES)) {
      return json({ error: 'file too large' }, 413);
    }

    const index = await this.getFileIndex();
    const existing = index.find((e) => e.path === path);
    const quotaErr = await this.checkQuota(index, path, size);
    if (quotaErr) return json({ error: quotaErr }, 413);

    await this.storage.put(
      KEYS.fileContent(this.id, path),
      bytes ? bytes.buffer : raw,
    );

    const base: FileIndexEntry = {
      path,
      kind: isBinary ? 'binary' : 'text',
      size,
      updatedAt: Date.now(),
      updatedBy: member.id,
    };
    const entry: FileIndexEntry = isBinary
      ? { ...base, hash: await sha256Hex(raw) }
      : base;
    const i = index.findIndex((e) => e.path === path);
    if (i >= 0) index[i] = entry;
    else index.push(entry);
    await this.saveFileIndex(index);
    await this.addBytes(size - (existing?.size ?? 0));

    return json({ entry });
  }

  private async getSnapshot(request: Request): Promise<Response> {
    const member = await this.requireMember(request);
    if (!member) return json({ error: 'unauthorized' }, 401);
    return json(await this.buildSnapshot());
  }

  /* WebSocket ---------------------------------------------------------------- */

  private async ws(request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('token');
    const member = token ? await this.memberFromToken(token) : null;
    if (!member) {
      return json({ error: 'unauthorized' }, 401);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as unknown as [WebSocket, WebSocket];
    server.accept();
    this.attachSocket(server, member.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Resolve a member token to a member of this lobby. Shared by the Worker
   * WebSocket upgrade and the Node self-host adapter.
   */
  async memberFromToken(token: string): Promise<Member | null> {
    const payload = await verifyMemberToken(this.env.MCP_SIGNING_SECRET, token);
    if (!payload || payload.lid !== this.id) return null;
    return (await this.getMembers()).find((m) => m.id === payload.mid) ?? null;
  }

  /**
   * Bind an accepted server-side socket to a member. The Node self-host server
   * wraps a `ws` connection in this tiny WebSocket-compatible interface.
   */
  attachSocket(server: WebSocket, memberId: string): void {
    this.sessions.set(server, memberId);
    server.addEventListener('message', (event) => {
      const data = event.data;
      const text = typeof data === 'string' ? data : null;
      if (!text) return;
      this.onWsMessage(server, text).catch((e) => console.error('ws handler:', e));
    });
    server.addEventListener('close', () => this.sessions.delete(server));
    server.addEventListener('error', () => this.sessions.delete(server));
  }

  private async onWsMessage(socket: WebSocket, text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.close(socket, 4002, 'bad json');
    }
    const t = (msg as { t?: string } | null)?.t;

    if (t === 'hello') {
      this.handleHello(socket, msg as { t: 'hello'; device: DeviceInfo; name: string });
      return;
    }
    if (t === 'ping') {
      socket.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (t === 'snapshot.pull') {
      socket.send(JSON.stringify(await this.buildSnapshot()));
      return;
    }
    if (t === 'doc.sync') {
      await this.handleDocSync(socket, msg as { t: 'doc.sync'; path: string; update: string });
      return;
    }
    if (t === 'file.delete') {
      await this.handleFileDelete(socket, msg as { t: 'file.delete'; path: string });
      return;
    }
    if (t === 'file.rename') {
      await this.handleFileRename(socket, msg as { t: 'file.rename'; from: string; to: string });
      return;
    }
    if (t === 'binary.put') {
      await this.handleBinaryPut(
        socket,
        msg as { t: 'binary.put'; path: string; hash: string; size: number; data: string },
      );
      return;
    }
    if (t === 'chat.send') {
      await this.handleChatSend(socket, msg as { t: 'chat.send'; body: string; mentions: string[] });
      return;
    }
    // locks.* / command.* land in M4+.
  }

  /* Live sync (M3) ------------------------------------------------------------ */

  /** Load (or create) the Y.Doc for a path, restoring persisted state first. */
  private async docFor(path: string): Promise<Y.Doc> {
    const cached = this.docs.get(path);
    if (cached) return cached;
    const blob = await this.storage.get<ArrayBuffer>(KEYS.yDoc(this.id, path));
    const doc = new Y.Doc();
    if (blob) Y.applyUpdate(doc, new Uint8Array(blob));
    this.docs.set(path, doc);
    return doc;
  }

  /**
   * A device's transaction update for a text file. Merge it into the path's
   * doc, persist both the rendered text and the merged full state (so the
   * lobby survives a DO restart / eviction), then relay the same update to
   * every other connected device (echo guard: not back to the sender).
   */
  private async handleDocSync(
    socket: WebSocket,
    msg: { t: 'doc.sync'; path: string; update: string },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const err = validLobbyPath(msg.path);
    if (err) return this.close(socket, 4003, `bad path: ${err}`);
    if (typeof msg.update !== 'string') return this.close(socket, 4003, 'update required (base64)');
    const bytes = fromBase64(msg.update);
    if (bytes.byteLength > DEFAULTS.maxUpdateBytes) {
      return this.close(socket, 4003, 'update too large');
    }

    const doc = await this.docFor(msg.path);
    const text = applyTextUpdate(doc, bytes);
    const size = new TextEncoder().encode(text).byteLength;
    if (size > MAX_TEXT_FILE_BYTES) {
      this.docs.delete(msg.path);
      return this.close(socket, 4003, 'file too large');
    }

    const index = await this.getFileIndex();
    const existing = index.find((e) => e.path === msg.path);
    const quotaErr = await this.checkQuota(index, msg.path, size);
    if (quotaErr) {
      this.docs.delete(msg.path);
      return this.close(socket, 4003, quotaErr);
    }

    await this.storage.put(KEYS.fileContent(this.id, msg.path), text);
    await this.storage.put(KEYS.yDoc(this.id, msg.path), fullStateOf(doc).buffer);

    const entry: FileIndexEntry = {
      path: msg.path,
      kind: 'text',
      size,
      updatedAt: Date.now(),
      updatedBy: memberId,
    };
    const i = index.findIndex((e) => e.path === msg.path);
    if (i >= 0) index[i] = entry;
    else index.push(entry);
    await this.saveFileIndex(index);
    await this.addBytes(size - (existing?.size ?? 0));

    this.broadcastExcept(socket, { t: 'doc.update', path: msg.path, update: msg.update });
  }

  private async handleFileDelete(
    socket: WebSocket,
    msg: { t: 'file.delete'; path: string },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const err = validLobbyPath(msg.path);
    if (err) return this.close(socket, 4003, `bad path: ${err}`);

    await this.getTotalBytes();
    const index = await this.getFileIndex();
    const i = index.findIndex((e) => e.path === msg.path);
    if (i >= 0) {
      const removedSize = index[i]!.size ?? 0;
      index.splice(i, 1);
      await this.saveFileIndex(index);
      await this.addBytes(-removedSize);
    }
    await this.storage.delete([
      KEYS.fileContent(this.id, msg.path),
      KEYS.yDoc(this.id, msg.path),
    ]);
    this.docs.delete(msg.path);

    this.broadcastExcept(socket, { t: 'file.deleted', path: msg.path });
  }

  private async handleFileRename(
    socket: WebSocket,
    msg: { t: 'file.rename'; from: string; to: string },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const errFrom = validLobbyPath(msg.from);
    const errTo = validLobbyPath(msg.to);
    if (errFrom || errTo) return this.close(socket, 4003, 'bad path');
    if (msg.from === msg.to) {
      this.broadcastExcept(socket, { t: 'file.renamed', from: msg.from, to: msg.to });
      return;
    }

    await this.getTotalBytes();
    const [content, yBlob] = await Promise.all([
      this.storage.get<unknown>(KEYS.fileContent(this.id, msg.from)),
      this.storage.get<ArrayBuffer | null>(KEYS.yDoc(this.id, msg.from)),
    ]);
    if (content === undefined) {
      return this.close(socket, 4003, 'source not found');
    }
    await this.storage.put(KEYS.fileContent(this.id, msg.to), content);
    if (yBlob) {
      await this.storage.put(KEYS.yDoc(this.id, msg.to), yBlob);
      const doc = this.docs.get(msg.from);
      if (doc) this.docs.set(msg.to, doc);
    } else {
      await this.storage.delete(KEYS.yDoc(this.id, msg.to));
      this.docs.delete(msg.to);
    }
    this.docs.delete(msg.from);
    await this.storage.delete([
      KEYS.fileContent(this.id, msg.from),
      KEYS.yDoc(this.id, msg.from),
    ]);

    const index = await this.getFileIndex();
    let reclaimed = 0;
    const dest = index.findIndex((e) => e.path === msg.to);
    if (dest >= 0) {
      reclaimed += index[dest]!.size ?? 0;
      index.splice(dest, 1);
    }
    const i = index.findIndex((e) => e.path === msg.from);
    if (i >= 0) {
      index[i] = { ...index[i]!, path: msg.to, updatedBy: memberId, updatedAt: Date.now() };
      await this.saveFileIndex(index);
    }
    if (reclaimed) await this.addBytes(-reclaimed);

    this.broadcastExcept(socket, { t: 'file.renamed', from: msg.from, to: msg.to });
  }

  private async handleBinaryPut(
    socket: WebSocket,
    msg: { t: 'binary.put'; path: string; hash: string; size: number; data: string },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const err = validLobbyPath(msg.path);
    if (err) return this.close(socket, 4003, `bad path: ${err}`);
    if (typeof msg.data !== 'string') return this.close(socket, 4003, 'data required (base64)');
    const bytes = fromBase64(msg.data);
    if (bytes.byteLength > DEFAULTS.maxBinaryBytes) {
      return this.close(socket, 4003, 'file too large');
    }

    const index = await this.getFileIndex();
    const existing = index.find((e) => e.path === msg.path);
    const quotaErr = await this.checkQuota(index, msg.path, bytes.byteLength);
    if (quotaErr) return this.close(socket, 4003, quotaErr);

    const hash = await sha256Hex(toBase64(bytes));
    await this.storage.put(KEYS.fileContent(this.id, msg.path), bytes.buffer);

    const entry: FileIndexEntry = {
      path: msg.path,
      kind: 'binary',
      hash,
      size: bytes.byteLength,
      updatedAt: Date.now(),
      updatedBy: memberId,
    };
    const i = index.findIndex((e) => e.path === msg.path);
    if (i >= 0) index[i] = entry;
    else index.push(entry);
    await this.saveFileIndex(index);
    await this.addBytes(bytes.byteLength - (existing?.size ?? 0));

    try {
      socket.send(JSON.stringify({ t: 'binary.put.ok', path: msg.path, hash, url: '' }));
    } catch {
      this.sessions.delete(socket);
    }
    this.broadcastExcept(socket, {
      t: 'binary.update',
      path: msg.path,
      hash,
      data: msg.data,
    });
  }

  private async handleChatSend(
    socket: WebSocket,
    msg: { t: 'chat.send'; body: string; mentions: string[] },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const body = String(msg.body ?? '').trim().slice(0, DEFAULTS.maxChatLength);
    if (!body) return;

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      lobbyId: this.id,
      authorId: memberId,
      body,
      mentions: Array.isArray(msg.mentions) ? msg.mentions : [],
      ts: Date.now(),
    };
    await this.storage.put(KEYS.chat(this.id, message.id), JSON.stringify(message));

    const stored = await this.storage.get<string[]>(KEYS.chatIndex(this.id));
    const ids = Array.isArray(stored) ? stored : [];
    ids.push(message.id);
    while (ids.length > DEFAULTS.maxChatHistory) {
      const old = ids.shift();
      if (old) await this.storage.delete(KEYS.chat(this.id, old));
    }
    await this.storage.put(KEYS.chatIndex(this.id), ids);

    // Chat is echoed to everyone (sender included) so the UI shows own messages.
    this.broadcastAll({ t: 'chat.message', message });
  }

  private broadcastExcept(socket: WebSocket, msg: unknown): void {
    for (const [sock] of this.sessions) {
      if (sock === socket) continue;
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        this.sessions.delete(sock);
      }
    }
  }

  private broadcastAll(msg: unknown): void {
    for (const [sock] of this.sessions) {
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        this.sessions.delete(sock);
      }
    }
  }

  private async handleHello(
    socket: WebSocket,
    msg: { t: 'hello'; device?: DeviceInfo; name?: string },
  ): Promise<void> {
    const memberId = this.sessions.get(socket);
    if (!memberId) return this.close(socket, 4401, 'unauthorized');
    const members = await this.getMembers();
    const member = members.find((m) => m.id === memberId);
    if (!member) return this.close(socket, 4404, 'unknown member');

    if (msg.device) member.device = msg.device;
    if (msg.name) member.name = msg.name.slice(0, 60);
    await this.saveMembers(members);

    socket.send(JSON.stringify({ t: 'hello.ok', memberId, lobbyId: this.id }));
    socket.send(JSON.stringify(await this.buildSnapshot()));
    this.broadcastPresence(member, true, socket);
  }

  private broadcastPresence(member: Member, joined: boolean, except?: WebSocket): void {
    const event = {
      t: 'event',
      event: {
        lobbyId: this.id,
        ts: Date.now(),
        kind: 'presence',
        authorId: member.id,
        payload: { memberId: member.id, name: member.name, joined },
      },
    };
    for (const [sock] of this.sessions) {
      if (sock === except) continue;
      try {
        sock.send(JSON.stringify(event));
      } catch {
        this.sessions.delete(sock);
      }
    }
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } finally {
      this.sessions.delete(socket);
    }
  }

  /* Shared helpers ------------------------------------------------------------ */

  private async buildSnapshot(): Promise<LobbySnapshot> {
    const entries = await this.getFileIndex();
    const files: Record<string, string> = {};
    const binaries: Record<string, string> = {};
    /** path → base64 Yjs full-state blob, so live mirrors share item structure. */
    const docs: Record<string, string> = {};
    await Promise.all(
      entries.map(async (e) => {
        const value = await this.storage.get<unknown>(KEYS.fileContent(this.id, e.path));
        if (typeof value === 'string') files[e.path] = value;
        else if (value instanceof ArrayBuffer) {
          binaries[e.path] = toBase64(new Uint8Array(value));
        }
        if (e.kind === 'text') {
          const yBlob = await this.storage.get<ArrayBuffer>(KEYS.yDoc(this.id, e.path));
          if (yBlob) docs[e.path] = toBase64(new Uint8Array(yBlob));
        }
      }),
    );
    return { t: 'snapshot', entries, files, binaries, docs };
  }

  private async requireMember(request: Request): Promise<Member | null> {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length);
    const payload = await verifyMemberToken(this.env.MCP_SIGNING_SECRET, token);
    if (!payload || payload.lid !== this.id) return null;
    return (await this.getMembers()).find((m) => m.id === payload.mid) ?? null;
  }

  private async getMembers(): Promise<Member[]> {
    const raw = await this.storage.get<string>(KEYS.members(this.id));
    return raw ? (JSON.parse(raw) as Member[]) : [];
  }

  private async saveMembers(members: Member[]): Promise<void> {
    await this.storage.put(KEYS.members(this.id), JSON.stringify(members));
  }

  private async getFileIndex(): Promise<FileIndexEntry[]> {
    const raw = await this.storage.get<string>(KEYS.fileIndex(this.id));
    return raw ? (JSON.parse(raw) as FileIndexEntry[]) : [];
  }

  private async saveFileIndex(index: FileIndexEntry[]): Promise<void> {
    await this.storage.put(KEYS.fileIndex(this.id), JSON.stringify(index));
  }

  private async getTotalBytes(): Promise<number> {
    if (this.totalBytes !== null) return this.totalBytes;
    const stored = await this.storage.get<number>(KEYS.totalBytes(this.id));
    if (typeof stored === 'number') {
      this.totalBytes = stored;
      return stored;
    }
    const index = await this.getFileIndex();
    this.totalBytes = index.reduce((sum, e) => sum + (e.size ?? 0), 0);
    await this.storage.put(KEYS.totalBytes(this.id), this.totalBytes);
    return this.totalBytes;
  }

  private async addBytes(delta: number): Promise<void> {
    this.totalBytes = Math.max(0, (await this.getTotalBytes()) + delta);
    await this.storage.put(KEYS.totalBytes(this.id), this.totalBytes);
  }

  private async checkQuota(
    index: FileIndexEntry[],
    path: string,
    size: number,
  ): Promise<string | null> {
    return quotaError(index, path, size, await this.getTotalBytes(), {
      maxFiles: DEFAULTS.maxFilesPerLobby,
      maxBytes: DEFAULTS.maxLobbyBytes,
    });
  }

  private async getRecord(): Promise<LobbyRecord | null> {
    const raw = await this.storage.get<string>(KEYS.lobby(this.id));
    return raw ? (JSON.parse(raw) as LobbyRecord) : null;
  }

  private async info(): Promise<Response> {
    const record = await this.getRecord();
    if (!record) return json({ error: 'lobby not found' }, 404);
    return json({
      id: this.id,
      name: record.name,
      inviteRequired: record.inviteTokenHash !== '',
      memberCount: (await this.getMembers()).length,
      fileCount: (await this.getFileIndex()).length,
      createdAt: record.createdAt,
    });
  }

  private async health(): Promise<Response> {
    const record = await this.getRecord();
    return json({
      ok: true,
      node: 'lobby',
      lobbyId: this.id,
      name: record?.name ?? null,
      memberCount: (await this.getMembers()).length,
      fileCount: (await this.getFileIndex()).length,
      at: Date.now(),
    });
  }
}

/* Pure helpers -------------------------------------------------------------- */

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export interface QuotaLimits {
  maxFiles: number;
  maxBytes: number;
}

/**
 * Decides whether a file write fits the lobby quota. Replacing an existing
 * path only counts the size delta. Pure for unit tests.
 */
export function quotaError(
  index: FileIndexEntry[],
  path: string,
  size: number,
  totalBytes: number,
  limits: QuotaLimits,
): string | null {
  const existing = index.find((e) => e.path === path);
  if (!existing && index.length >= limits.maxFiles) {
    return 'lobby file limit reached';
  }
  const delta = size - (existing?.size ?? 0);
  if (totalBytes + delta > limits.maxBytes) {
    return 'lobby storage quota exceeded';
  }
  return null;
}

/**
 * Validates a lobby-relative POSIX path (used by REST PUTs and every WS file
 * message). Returns an error message or null (ok). Pure for unit tests.
 */
export function validLobbyPath(path: string): string | null {
  if (!path || path.length > MAX_PATH_LENGTH) return 'invalid path length';
  if (path.startsWith('/') || path.includes('\\')) return 'path must be relative';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'invalid path segments';
  if (isIgnored(path)) return 'path is ignored';
  return null;
}

/**
 * Validates an M1 file PUT. Returns an error message or null (ok).
 * Kept pure for unit tests.
 */
export function validateFilePut(body: FilePutRequest | null): string | null {
  if (!body || typeof body.path !== 'string') return 'path required';
  const pathErr = validLobbyPath(body.path);
  if (pathErr) return pathErr;
  const hasText = typeof body.content === 'string';
  const hasBin = typeof body.content_base64 === 'string';
  if (hasText === hasBin) return 'exactly one of content | content_base64 required';
  return null;
}

/** Pure helper: the file index a lobby would list — kept pure for unit tests. */
export function indexPaths(entries: FileIndexEntry[]): string[] {
  return entries.map((e) => e.path).sort();
}

export type { MemberKind };