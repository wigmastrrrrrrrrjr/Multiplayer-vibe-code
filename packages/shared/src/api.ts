import type { DeviceInfo, FileIndexEntry } from './types.ts';

/**
 * REST surface of the Worker (M1+). WebSocket sync lives on WS_PATH (/ws).
 * File content is carried as plain `content` (UTF-8 text) or `content_base64`
 * (standard base64 for small binaries) until the CRDT path lands in M3.
 */

export const API = {
  createLobby: '/lobbies', // POST
  joinLobby: '/lobbies/join', // POST
  lobby: (id: string) => `/lobbies/${id}`, // GET info
  files: (id: string) => `/lobbies/${id}/files`, // GET index | PUT upsert
  snapshot: (id: string) => `/lobbies/${id}/snapshot`, // GET
} as const;

export interface CreateLobbyRequest {
  name: string;
}

export interface CreateLobbyResponse {
  lobbyId: string;
  lobbyName: string;
  /** Single-use-ish inviter secret: `${lobbyId}:${hex}`. Only the hash is stored. */
  inviteToken: string;
  wsUrl: string; // same-origin wss://…/ws
}

export interface JoinLobbyRequest {
  inviteToken: string;
  name: string; // display name of the joining member
  device: DeviceInfo;
}

export interface JoinLobbyResponse {
  lobbyId: string;
  lobbyName: string;
  memberId: string;
  memberToken: string; // HMAC-signed, sent as `Authorization: Bearer` + ws ?token=
  wsUrl: string;
}

export interface LobbyInfoResponse {
  id: string;
  name: string;
  inviteRequired: boolean;
  memberCount: number;
  fileCount: number;
  createdAt: number;
}

export interface FilePutRequest {
  path: string; // POSIX-style relative path within the lobby
  content?: string; // UTF-8 text (kind: text)
  content_base64?: string; // standard base64 (kind: binary)
}

export interface FilePutResponse {
  entry: FileIndexEntry;
}

/** Snapshot payload for the initial pull (M1: raw content, M3: Yjs updates). */
export interface LobbySnapshot {
  t: 'snapshot';
  entries: FileIndexEntry[];
  /** path → UTF-8 text content (text files). */
  files: Record<string, string>;
  /** path → standard base64 content (small binary files). */
  binaries: Record<string, string>;
  /** path → standard base64 Yjs full-state blob (text files, M3+). */
  docs?: Record<string, string>;
}

export { WS_PATH } from './protocol.ts';