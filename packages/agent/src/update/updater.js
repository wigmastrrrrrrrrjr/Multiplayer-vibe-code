// Self-hosted auto-update for `mvc-agent`.
//
// Source of truth is the Worker's /version endpoint, which advertises the
// sha256 of the served source tarball (/source.tar.gz). An "installation" is a
// managed copy of the source under ~/.local/share/mvc/current plus a meta.json
// remembering which sha256 was applied. update() re-downloads the tarball,
// verifies the sha256, extracts it, re-runs `npm link --workspace @mvc/agent`,
// and records the new sha256. The tray app checks daily and applies itself when
// MVC_AUTO_UPDATE=1 (see main.js).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Managed-install root (override with MVC_MANAGED_DIR, used by tests). */
export const managedRoot = () =>
  process.env.MVC_MANAGED_DIR ?? join(homedir(), '.local', 'share', 'mvc');

/** Installs may record a bare host (no scheme) in meta.json — always require one. */
export function normalizeServerUrl(serverUrl) {
  return /^https?:\/\//i.test(serverUrl) ? serverUrl : `https://${serverUrl}`;
}

export const managedMetaPath = () => join(managedRoot(), 'meta.json');

/**
 * @typedef {object} UpdateMeta
 * @property {string} sourceSha256
 * @property {string} builtAt
 * @property {string} installedAt
 * @property {string} serverUrl
 */

/** @returns {Promise<UpdateMeta | null>} */
export async function readManagedMeta() {
  try {
    return JSON.parse(await fs.readFile(managedMetaPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {UpdateMeta} meta */
export async function writeManagedMeta(meta) {
  await fs.mkdir(managedRoot(), { recursive: true });
  await fs.writeFile(managedMetaPath(), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}

/** The extracted project dir, e.g. …/current/multiplayer-vibe-code. */
export const managedAppDir = () => join(managedRoot(), 'current', 'multiplayer-vibe-code');

/**
 * Fetch the server's version payload.
 * @param {string} serverUrl
 * @returns {Promise<{ sourceSha256: string, builtAt: string, version: string }>}
 */
export async function fetchVersion(serverUrl) {
  const res = await fetch(`${normalizeServerUrl(serverUrl).replace(/\/+$/, '')}/version`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET /version -> ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.sourceSha256 !== 'string') {
    throw new Error('server /version response is missing sourceSha256');
  }
  return data;
}

/** True when the local install differs from the server's advertised sha256. */
export function needsUpdate(currentSha, latestSha) {
  return Boolean(latestSha) && currentSha !== latestSha;
}

/** @param {Uint8Array | Buffer} bytes */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Check (without downloading) whether an update is available.
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @returns {Promise<{ available: boolean, current: string | null, latest: string, builtAt: string, meta: UpdateMeta | null }>}
 */
export async function checkForUpdate({ serverUrl }) {
  const latest = await fetchVersion(serverUrl);
  const meta = await readManagedMeta();
  const current = meta?.sourceSha256 ?? null;
  return {
    available: needsUpdate(current, latest.sourceSha256),
    current,
    latest: latest.sourceSha256,
    builtAt: latest.builtAt,
    meta,
  };
}

/**
 * Download, verify and apply the latest source; then re-link the CLI.
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<UpdateMeta>}
 */
export async function applyUpdate({ serverUrl, log = console.log }) {
  const base = normalizeServerUrl(serverUrl).replace(/\/+$/, '');
  const version = await fetchVersion(serverUrl);
  if (!version.sourceSha256) {
    throw new Error('server has no source bundle yet (SOURCE_SHA256 empty) — nothing to update from');
  }

  const res = await fetch(`${base}/source.tar.gz`);
  if (!res.ok) throw new Error(`GET /source.tar.gz -> ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const got = sha256Hex(bytes);
  if (got !== version.sourceSha256) {
    throw new Error(`tarball sha256 mismatch: expected ${version.sourceSha256}, got ${got}`);
  }

  // Extract into the managed dir (tarball carries the multiplayer-vibe-code/ prefix).
  const root = managedRoot();
  const target = join(root, 'current');
  const tmp = join(root, `source-${Date.now()}.tar.gz`);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(tmp, bytes);
  try {
    await execFileAsync('tar', ['-xzf', tmp, '-C', target]);
    // Replace a previous install cleanly: keep only the freshly extracted tree.
    const current = join(target, 'multiplayer-vibe-code');
    for (const entry of await fs.readdir(target)) {
      if (entry !== 'multiplayer-vibe-code') {
        await fs.rm(join(target, entry), { recursive: true, force: true });
      }
    }
    log(`extracted source → ${current}`);
    await relink(current, log);
  } finally {
    await fs.rm(tmp, { force: true });
  }

  const meta = {
    sourceSha256: got,
    builtAt: version.builtAt,
    installedAt: new Date().toISOString(),
    serverUrl: base,
  };
  await writeManagedMeta(meta);
  log(`recorded ${got.slice(0, 12)}… (built ${version.builtAt})`);
  return meta;
}

/** Best-effort: npm install + re-link the mvc-agent bin from the fresh copy. */
async function relink(appDir, log) {
  try {
    await execFileAsync('npm', ['install'], { cwd: appDir, timeout: 600_000 });
    await execFileAsync('npm', ['link', '--workspace', '@mvc/agent'], { cwd: appDir, timeout: 120_000 });
    log('npm install + npm link --workspace @mvc/agent → ok, mvc-agent now points at the new copy');
  } catch (err) {
    log(`warning: could not re-link (${String(err.stderr ?? err.message).trim().split('\n')[0]}); run npm install && npm link --workspace @mvc/agent in ${appDir}`);
  }
}