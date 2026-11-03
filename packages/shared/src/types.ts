/** Core domain types shared by the Worker, Durable Object, sync agents, and MCP. */

export type MemberKind = 'human' | 'agent';

export interface DeviceInfo {
  id: string;
  kind: 'windows' | 'linux' | 'macos' | 'other';
  name: string; // user-facing, e.g. "dan-pc"
  os: string; // os.platform() + version info for the UI
}

export interface Member {
  id: string;
  lobbyId: string;
  name: string;
  kind: MemberKind;
  provider?: string; // agents: 'opencode' | 'claude-code' | 'cursor' | …
  device?: DeviceInfo; // humans
  joinedAt: number;
}

export interface FileIndexEntry {
  path: string;
  kind: 'text' | 'binary';
  /**
   * text files: Yjs update blobs stored in DO SQLite under `y:${path}`.
   * binary files: objects in R2 addressed by `r2Key`.
   */
  r2Key?: string;
  hash?: string; // content hash for binaries (dedupe + change detection)
  size?: number;
  updatedAt: number;
  updatedBy: string; // memberId
}

export interface ChatMessage {
  id: string;
  lobbyId: string;
  authorId: string;
  body: string;
  mentions: string[]; // memberIds
  ts: number;
}

export interface FileLock {
  path: string;
  holderId: string; // model member id — humans are exempt from locks
  since: number;
  leaseUntil: number; // auto-expires; renewed by heartbeat
}

export type CommandStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'done'
  | 'timeout'
  | 'cancelled';

export interface CommandOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  ts: number;
}

export interface CommandRequest {
  id: string;
  lobbyId: string;
  authorId: string;
  cmd: string;
  cwd?: string;
  executorDeviceId?: string; // device that runs it (default: approver's device)
  status: CommandStatus;
  output: CommandOutputChunk[];
  exitCode?: number;
  decidedBy?: string;
  decidedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
}

export interface Lobby {
  id: string;
  name: string;
  createdAt: number;
  inviteTokenHash: string; // never store the plaintext token
}

export type EventKind =
  | 'file.change'
  | 'chat'
  | 'presence'
  | 'locks'
  | 'command'
  | 'system';

export interface LobbyEvent {
  lobbyId: string;
  ts: number;
  kind: EventKind;
  authorId: string;
  payload: unknown;
}