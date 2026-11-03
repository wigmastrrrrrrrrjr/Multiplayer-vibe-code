import type {
  ChatMessage,
  CommandOutputChunk,
  CommandRequest,
  DeviceInfo,
  FileIndexEntry,
  FileLock,
  LobbyEvent,
} from './types.ts';

/**
 * Wire protocol between sync agents / web clients and the Worker (WebSocket at /ws).
 *
 * Transport note: the plan called for binary payloads (Yjs updates, binary file
 * contents) as a trailing binary frame, but both ends are ours and M1 already
 * carries content base64-encoded inside JSON (snapshot.files/binaries). For M2/M3
 * we keep single-frame UTF-8 JSON everywhere: fields named `update` / `data` are
 * **base64 strings (standard alphabet)**. Documented deviation — revisit framing
 * if payloads get heavy.
 */

export type ClientToServer =
  | { t: 'hello'; device: DeviceInfo; name: string }
  | { t: 'snapshot.pull' }
  | { t: 'doc.sync'; path: string; update: Uint8Array }
  | { t: 'doc.pull'; path: string }
  | { t: 'file.delete'; path: string }
  | { t: 'file.rename'; from: string; to: string }
  | { t: 'binary.put'; path: string; hash: string; size: number; data: Uint8Array }
  | { t: 'chat.send'; body: string; mentions: string[] }
  | { t: 'locks.list' }
  | { t: 'locks.acquire'; path: string; waitMs?: number }
  | { t: 'locks.release'; path: string }
  | {
      t: 'command.submit';
      cmd: string;
      cwd?: string;
    }
  | { t: 'command.decide'; id: string; approve: boolean; executorDeviceId?: string }
  | { t: 'command.cancel'; id: string }
  | { t: 'command.result'; id: string }
  | { t: 'ping' };

export type ServerToClient =
  | { t: 'hello.ok'; memberId: string; lobbyId: string }
  | { t: 'hello.err'; reason: string }
  | { t: 'snapshot'; entries: FileIndexEntry[]; files: Record<string, string>; binaries: Record<string, string> }
  | { t: 'doc.update'; path: string; update: Uint8Array }
  | { t: 'doc.missing'; path: string }
  | { t: 'file.deleted'; path: string }
  | { t: 'file.renamed'; from: string; to: string }
  | { t: 'binary.put.ok'; path: string; hash: string; url: string }
  | { t: 'binary.update'; path: string; hash: string; data: Uint8Array }
  | { t: 'chat.message'; message: ChatMessage }
  | { t: 'locks.state'; locks: FileLock[] }
  | { t: 'locks.granted'; path: string }
  | { t: 'locks.denied'; path: string; holderId: string }
  | { t: 'command.state'; command: CommandRequest }
  | { t: 'command.output'; id: string; chunk: CommandOutputChunk }
  | { t: 'event'; event: LobbyEvent }
  | { t: 'pong' };

export const WS_PATH = '/ws';

export const DEFAULTS = {
  /** Agent-side debounce before flushing a Yjs update to the server (ms). */
  syncDebounceMs: 100,
  /** Model file-lock lifetime; renewed by heartbeat (ms). */
  lockTtlMs: 5 * 60_000,
  /** How long a pending command waits for human approval (ms). */
  approvalTimeoutMs: 5 * 60_000,
  /** Max chat body length. */
  maxChatLength: 8_000,
  /** Max single Yjs update payload before denial (bytes). */
  maxUpdateBytes: 1_000_000,
  /** Max binary upload size (bytes) — bigger files are chunked. */
  maxBinaryBytes: 50_000_000,
  /** Max members per lobby (join is capped to keep member JSON bounded). */
  maxMembersPerLobby: 200,
  /** Max files per lobby (index + storage quota). */
  maxFilesPerLobby: 5_000,
  /** Max total file bytes per lobby (text + binary). */
  maxLobbyBytes: 100_000_000,
  /** Chat messages retained per lobby; older ones are pruned. */
  maxChatHistory: 500,
} as const;