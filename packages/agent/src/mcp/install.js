// One-shot installer that registers the project's remote MCP server (/mcp on
// the chosen server) with every AI CLI it can detect on this machine.
//
// The project's MCP server is remote (HTTP on the Cloudflare Worker), so
// "installing" it means writing one small config entry per tool. Detection is
// intentionally conservative: a tool is only touched if its config file or
// config dir already exists (or its binary is on PATH), so this never creates
// stray config trees on machines that don't use a tool. Every write is preceded
// by a <file>.mvc.bak backup, and --dry-run shows the diff without touching
// anything.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} McpTarget
 * @property {string} id
 * @property {string} name
 * @property {'mcpServers' | 'zed-mcp'} format  how the entry lives in the config
 * @property {(home: string) => string} path
 * @property {(home: string) => Promise<boolean>} detect
 * @property {string[]} [binaries]  PATH checks used as an additional signal
 */

/** @type {McpTarget[]} */
const TARGETS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    format: 'mcpServers',
    path: (home) => join(home, '.claude.json'),
    detect: (home) => Promise.resolve(existsSync(join(home, '.claude.json'))),
    binaries: ['claude'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'mcpServers',
    path: (home) => join(home, '.cursor', 'mcp.json'),
    detect: (home) => Promise.resolve(existsSync(join(home, '.cursor'))),
    binaries: ['cursor'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    format: 'mcpServers',
    path: (home) => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    detect: (home) => Promise.resolve(existsSync(join(home, '.codeium'))),
    binaries: ['windsurf'],
  },
  {
    id: 'zed',
    name: 'Zed',
    format: 'zed-mcp',
    path: (home) => join(home, '.config', 'zed', 'settings.json'),
    detect: (home) => Promise.resolve(existsSync(join(home, '.config', 'zed'))),
    binaries: ['zed'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini CLI',
    format: 'mcpServers',
    path: (home) => join(home, '.gemini', 'settings.json'),
    detect: (home) => Promise.resolve(existsSync(join(home, '.gemini'))),
    binaries: ['gemini'],
  },
];

export const mcpTargets = () => TARGETS;

/** True on POSIX; PATH-based detection is skipped on Windows (PATHEXT quirks). */
const canProbePath = () => !['win32'].includes(platform());

/** @returns {Promise<boolean>} whether `bin` resolves on PATH. */
async function onPath(bin) {
  if (!canProbePath()) return false;
  try {
    await execFileAsync('sh', ['-c', `command -v ${bin}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect every AI CLI present on this machine.
 * @param {string} [home]
 * @returns {Promise<{ id: string, name: string, path: string }[]>}
 */
export async function detectMcpTargets(home = homedir()) {
  const found = [];
  for (const t of TARGETS) {
    const hits = await Promise.all((t.binaries ?? []).map(onPath));
    if ((await t.detect(home)) || hits.some(Boolean)) {
      found.push({ id: t.id, name: t.name, path: t.path(home) });
    }
  }
  return found;
}

/** The "mvc" entry for a tool whose config uses an mcpServers map. */
function mcpServersEntry(url, headers) {
  return { mcpServers: { mvc: { type: 'http', url, ...(headers ? { headers } : {}) } } };
}

/** Merge the mvc entry into a config that stores servers in an object map. */
export function mergeMcpServers(config, url, headers) {
  const out = { ...config };
  out.mcpServers = { ...(out.mcpServers ?? {}), mvc: { type: 'http', url, ...(headers ? { headers } : {}) } };
  return out;
}

/** Merge the mvc entry into a Zed config (servers live in an array under "mcp"). */
export function mergeZedMcp(config, url, headers) {
  const out = { ...config };
  const list = Array.isArray(out.mcp) ? out.mcp.map((e) => ({ ...e })) : [];
  const entry = { name: 'mvc', url, ...(headers ? { headers } : {}) };
  const i = list.findIndex((e) => e.name === 'mvc');
  if (i === -1) list.push(entry);
  else list[i] = entry;
  out.mcp = list;
  return out;
}

const mergeByFormat = {
  mcpServers: mergeMcpServers,
  'zed-mcp': mergeZedMcp,
};

const removeByFormat = {
  mcpServers: (config) => {
    if (!config.mcpServers || config.mcpServers.mvc === undefined) return null;
    const out = { ...config, mcpServers: { ...config.mcpServers } };
    delete out.mcpServers.mvc;
    if (Object.keys(out.mcpServers).length === 0) delete out.mcpServers;
    return out;
  },
  'zed-mcp': (config) => {
    if (!Array.isArray(config.mcp) || !config.mcp.some((e) => e.name === 'mvc')) return null;
    return { ...config, mcp: config.mcp.filter((e) => e.name !== 'mvc') };
  },
};

/**
 * Install (or remove) the mvc MCP server for every detected AI CLI.
 * @param {object} opts
 * @param {string} [opts.home]
 * @param {string} opts.mcpUrl       e.g. https://…/mcp
 * @param {string} [opts.token]      optional Bearer token for the Authorization header
 * @param {string[]} [opts.only]     restrict to these ids (e.g. ['cursor'])
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.remove]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{ id: string, name: string, path: string, action: 'updated'|'removed'|'unchanged'|'skipped'|'would-update'|'would-remove' }>>}
 */
export async function installMcp({ home = homedir(), mcpUrl, token, only, dryRun = false, remove = false, log = console.log } = {}) {
  if (!mcpUrl) throw new Error('installMcp requires mcpUrl');
  const headers = token ? { Authorization: `Bearer ${token}` } : null;
  const detected = await detectMcpTargets(home);
  const report = [];

  for (const { id, name, path } of detected) {
    if (only && !only.includes(id)) continue;
    const target = TARGETS.find((t) => t.id === id);
    let config = {};
    let existed = existsSync(path);
    if (existed) {
      try {
        config = JSON.parse(await fs.readFile(path, 'utf8'));
      } catch (err) {
        log(`skipped ${name}: ${path} is not valid JSON (${err.message})`);
        report.push({ id, name, path, action: 'skipped' });
        continue;
      }
    }

    const next = remove
      ? removeByFormat[target.format](config)
      : mergeByFormat[target.format](config, mcpUrl, headers);
    const verb = remove ? 'removed' : 'updated';
    const would = remove ? 'would-remove' : 'would-update';

    // next === null: nothing to remove; deep-equal: already in the desired state.
    if (next === null || JSON.stringify(next) === JSON.stringify(config)) {
      report.push({ id, name, path, action: 'unchanged' });
      continue;
    }

    if (dryRun) {
      log(`${would} ${name} → ${path}`);
      report.push({ id, name, path, action: would });
      continue;
    }

    if (existed) {
      await fs.copyFile(path, `${path}.mvc.bak`);
    }
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(next, null, 2) + '\n');
    log(`${verb} ${name} → ${path} (backup: ${path}.mvc.bak)`);
    report.push({ id, name, path, action: verb });
  }

  if (detected.length === 0) {
    log('no AI CLI detected (Claude Code / Cursor / Windsurf / Zed / Gemini) — nothing to configure');
  }
  return report;
}