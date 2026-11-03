import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * A tiny file-backed implementation of the subset of DurableObjectStorage the
 * Lobby class uses. One JSON file per lobby; ArrayBuffers are base64-tagged.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt a lobby.
 */
export class FileStorage {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [key, value] of Object.entries(raw)) this.map.set(key, decode(value));
    } catch {
      this.map = new Map();
    }
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = {};
    for (const [key, value] of this.map) data[key] = encode(value);
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }

  async get(key) {
    return this.map.get(key);
  }

  async put(key, value) {
    this.map.set(key, value);
    this.flush();
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.map.delete(key);
    this.flush();
  }

  async list() {
    return new Map(this.map);
  }
}

function encode(value) {
  if (value instanceof ArrayBuffer) {
    return { __mvc: 'ab', data: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __mvc: 'ab',
      data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encode(item);
    return out;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (value.__mvc === 'ab') {
      const bytes = Uint8Array.from(Buffer.from(value.data, 'base64'));
      return bytes.buffer;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = decode(item);
    return out;
  }
  return value;
}

/** A minimal DurableObjectState stand-in for the Lobby class. */
export function lobbyState(id, storage) {
  return {
    id: { toString: () => id },
    storage,
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil: () => {},
  };
}

export function storagePath(dataDir, lobbyId) {
  const file = `${dataDir}/lobbies/${lobbyId}.json`;
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  return file;
}
