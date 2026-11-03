#!/usr/bin/env node
// Headless sync agent — the same SyncEngine the tray app uses, runnable on any
// device (Windows / Ubuntu / Linux) for demos, tests, and CI.
//
//   mvc-agent create <name>                  → prints an invite token
//   mvc-agent push  <inviteToken> <dir>      → upload a local folder into the lobby
//   mvc-agent join  <inviteToken>            → materialize ~/Lobbies/<name> + stay synced
//   mvc-agent join  <inviteToken> --live     → + real-time two-way CRDT sync (watch + apply)
//   mvc-agent chat  <inviteToken> "<body>"   → send a lobby chat message
//   mvc-agent update [--check] [--force]     → self-hosted auto-update (sha256-verified)
//   mvc-agent setup [--dry-run] [--remove]   → register /mcp with every detected AI CLI
//                                             (Claude Code, Cursor, Windsurf, Zed, Gemini)
//   mvc-agent setup --mcp-token <t>          → also set an Authorization header
//
//   --server <url>   (or MVC_SERVER_URL)     Worker base URL (default https://…workers.dev)
//   --home <dir>                             lobby folder parent (default ~/Lobbies)
//   --name <n>                               member display name (default hostname)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SyncEngine } from './sync/engine.js';
import { applyUpdate, checkForUpdate, managedRoot, normalizeServerUrl, readManagedMeta } from './update/updater.js';
import { installMcp } from './mcp/install.js';

const [cmd, a, b, ...rest] = process.argv.slice(2);
const parse = () => {
  // Flags may appear anywhere after the command name, not only at the end:
  // `join <token> --server X` and `--server X join <token>` both work.
  const args = [...process.argv.slice(2)];
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag) => args.includes(flag);
  return {
    server: get('--server') ?? process.env.MVC_SERVER_URL,
    home: get('--home') ?? process.env.LOBBY_HOME ?? join(homedir(), 'Lobbies'),
    name: get('--name'),
    has,
    get,
  };
};

async function main() {
  const opts = parse();
  if (!opts.server) {
    // The one-command installer records where it came from — remember it so
    // setup / update / create / push / join work with zero flags afterwards.
    const meta = await readManagedMeta();
    if (meta?.serverUrl) opts.server = normalizeServerUrl(meta.serverUrl);
  }
  if (!opts.server) {
    console.error(
      'no server configured — pass --server <url> (e.g. https://mvc-server-staging.csomeone301.workers.dev)\n' +
        'or set MVC_SERVER_URL (a one-command install records it automatically)',
    );
    process.exit(2);
  }
  const engine = new SyncEngine({ serverUrl: opts.server, lobbyHome: opts.home });

  if (cmd === 'create' && a) {
    const { lobbyId, lobbyName, inviteToken, wsUrl } = await engine.createLobby(a);
    console.log(`lobby created:  ${lobbyName} (${lobbyId})`);
    console.log(`invite token:   ${inviteToken}`);
    console.log(`ws:             ${wsUrl}`);
    console.log(`\nother devices:  mvc-agent join ${inviteToken}`);
    console.log(`first push:     mvc-agent push ${inviteToken} ./path/to/project`);
  } else if (cmd === 'update') {
    const checkOnly = opts.has('--check');
    const force = opts.has('--force');
    const res = await checkForUpdate({ serverUrl: opts.server });
    if (checkOnly) {
      if (res.available) {
        console.log(`update available (${res.current ? res.current.slice(0, 12) : 'not installed'} → ${res.latest.slice(0, 12)}, built ${res.builtAt})`);
        console.log('run: mvc-agent update');
        process.exit(2);
      }
      console.log(`up to date: ${res.latest.slice(0, 12)} (${res.current ? 'installed' : 'not installed'})`);
      return;
    }
    if (!res.available && !force && res.current) {
      console.log('already up to date — nothing to do (use --force to reinstall)');
      return;
    }
    if (!res.available && !res.current) {
      console.log('first install from this server…');
    }
    const meta = await applyUpdate({ serverUrl: opts.server });
    console.log(`\nmvc-agent updated (${meta.sourceSha256.slice(0, 12)}…). Managed copy: ${managedRoot()}`);
  } else if (cmd === 'setup') {
    const dryRun = opts.has('--dry-run');
    const remove = opts.has('--remove');
    const token = opts.get('--mcp-token');
    console.log(`server: ${opts.server}`);
    if (!dryRun) {
      const up = await checkForUpdate({ serverUrl: opts.server });
      if (up.available || !up.current) {
        console.log('agent source: updating…');
        const meta = await applyUpdate({ serverUrl: opts.server });
        console.log(`agent source: ${meta.sourceSha256.slice(0, 12)}… (${managedRoot()})`);
      } else {
        console.log(`agent source: up to date (${up.latest.slice(0, 12)}…)`);
      }
    }
    console.log('detecting AI CLIs and registering the /mcp server…');
    const mcpUrl = `${opts.server.replace(/\/+$/, '')}/mcp`;
    await installMcp({ mcpUrl, token, dryRun, remove });
    if (!remove) {
      console.log(`\nAI CLIs will reach the model server at ${mcpUrl} (implements MCP in M4);`);
      console.log('edit or unregister anytime with: mvc-agent setup --remove');
    }
  } else if (cmd === 'push' && a && b) {
    const { lobbyId, lobbyName, memberToken } = await engine.join(a, { name: opts.name ?? 'pusher' });
    const { uploaded, skipped } = await engine.pushDir(b, { memberToken, lobbyId, name: lobbyName });
    console.log(`pushed ${uploaded} files into "${lobbyName}"${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
    console.log(`\nother devices:  mvc-agent join ${a}`);
  } else if (cmd === 'join' && a) {
    const joined = await engine.join(a, { name: opts.name });
    console.log(`joined "${joined.lobbyName}" as ${joined.memberId}`);
    const { ws, snapshot } = await engine.syncLobby({
      wsUrl: joined.wsUrl,
      memberToken: joined.memberToken,
      name: opts.name,
    });
    const { dir, wrote } = await engine.materialize(snapshot, { lobbyName: joined.lobbyName });
    console.log(`folder ready:   ${dir} (${wrote.length} files)`);

    let watcher = null;
    if (opts.has('--live')) {
      // Live two-way sync (M3): mirrors share the snapshot's Yjs baselines,
      // local edits stream as CRDT deltas, remote edits land on disk.
      engine.applySnapshotBaselines(snapshot);
      watcher = engine.watch(dir, { ws });
      engine.on('msg', ({ msg }) => {
        engine.applyRemote(dir, msg).catch((e) => console.error(`[live] ${e.message}`));
      });
      console.log(`live sync on:   ${dir} (edits sync both ways; Ctrl+C to stop)`);
    } else {
      console.log('syncing… Ctrl+C to stop');
    }
    process.on('SIGINT', () => {
      if (watcher) watcher.close().catch(() => {});
      engine.closeAll();
      ws.close();
      process.exit(0);
    });
    await new Promise(() => {});
  } else if (cmd === 'chat' && a && b) {
    const joined = await engine.join(a, { name: opts.name });
    const { ws } = await engine.syncLobby({
      wsUrl: joined.wsUrl,
      memberToken: joined.memberToken,
      name: opts.name,
    });
    const echo = engine.waitFor('chat.message', 10_000);
    engine.chat(ws, b);
    const message = (await echo).message;
    console.log(`[${message.authorId}] ${message.body}`);
    engine.closeAll();
    process.exit(0);
  } else {
    console.error(
      'usage: mvc-agent <create <name>>|<push <inviteToken> <dir>>|<join <inviteToken> [--live]>|' +
        '<chat <inviteToken> "<body>">|<update [--check]>|<setup [--dry-run|--remove]> [--server URL] [--home DIR] [--name NAME]',
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});