# Multiplayer Vibe Code

A lobby owns a project folder. Every device that joins gets that folder synced to
its own machine — code locally with any editor, changes flow to everyone in real
time with CRDT merging. AI models join the same lobby via MCP.

- **Lobby folder sync** — join with a token → `~/Lobbies/<project>` appears on your device
- **CRDT (Yjs)** — concurrent edits from any device/model merge, zero data loss
- **Model locks** — an AI can't edit a file while another AI holds its lock
- **Commands on devices** — models request commands; you approve in the app, they run
  on your machine, output syncs to everyone. No cloud compute.
- **Cloudflare Workers** — always-on 24/7, free tier, MCP at `/mcp`

## Install

```sh
curl -fsSL https://mvc-server.csomeone301.workers.dev/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://mvc-server.csomeone301.workers.dev/install.ps1 | iex
```

## Workspaces

| Package | Role |
|---|---|
| `packages/shared` | Protocol types, wire messages, ignore rules |
| `packages/server` | Cloudflare Worker: REST, `/ws`, `/mcp`, auth |
| `packages/server-do` | Durable Object per lobby: file index, Yjs merge, event bus, locks, commands |
| `packages/node-server` | Self-hosted Node.js server: same lobby logic, file-backed storage, central directory |
| `packages/agent` | Electron tray app: folder sync, approval UI, command executor |
| `packages/e2e` | Online tests against the deployed staging Worker |

## Quickstart

```sh
npm install
npm run typecheck
npm test
```

### Deploy to Cloudflare

Prod: `cd packages/server && npx wrangler deploy --env prod` (OAuth), or set
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars` and run
`npm run deploy:prod`. The central directory uses D1:

```sh
npx wrangler d1 create mvc-lobbies
npx wrangler d1 execute mvc-lobbies --remote --file src/schema.sql
```

`wrangler.toml` binds it as `DB` for `staging` and `prod`; a one-minute cron
prunes stale self-hosted lobby entries. The API deploy script bundles with
`esbuild-wasm`, drives the Workers JSON API, and falls back to packing the
working tree when git is unavailable.

### Local Worker + tray app

`wrangler dev` works on real Windows/Ubuntu/Linux machines (`npm run dev
--workspace @mvc/server`); the executable is an optional dependency that this
Android dev box installs are skipped for. The tray app needs a desktop OS:
`npm start --workspace @mvc/agent`.

### Self-host a lobby on your own device

Any Node.js device can host a lobby. The central directory stores only the
public host link and a liveness heartbeat; if the host stops, the entry expires.

```sh
npm start --workspace @mvc/node-server       # listens on :8787
mvc-agent create my-project --server http://localhost:8787
```

Set `MVC_PUBLIC_URL` when the host is behind a tunnel/reverse proxy. Use
`MVC_REGISTRY_URL=off` for a LAN-only lobby. Node.js >= 22.18 is required.

## Install for users — one command

No `cd`, no clone, no registry. The installer downloads the source from the
server, verifies its sha256, npm-installs and puts `mvc-agent` on your PATH:

```sh
curl -fsSL https://mvc-server.csomeone301.workers.dev/install.sh | sh   # Ubuntu / Linux / macOS
irm https://mvc-server.csomeone301.workers.dev/install.ps1 | iex         # Windows (PowerShell)
```

Or the source-only route (manual install):

```sh
curl -fsSL https://mvc-server.csomeone301.workers.dev/source.tar.gz | tar xz && cd multiplayer-vibe-code
npm install
npm link --workspace @mvc/agent
npm link --workspace @mvc/node-server
```

Then: `mvc-agent setup` (auto-register `/mcp` with any detected AI CLI),
`mvc-agent create <name>` to start a lobby, and `mvc-agent update --check` to
stay current.

## M1+M3 — folder join + live sync (live on staging)

The headless agent on each device runs the exact engine the tray app uses.

```sh
# Device A: create the lobby — then copy the ready-to-run commands it prints
mvc-agent create my-project          # --server not needed after a one-command install

# Device A (first push of an existing local folder into the lobby)
mvc-agent push INVITE_TOKEN ./path/to/project

# Device B: join once — ~/Lobbies/my-project appears with all files
mvc-agent join INVITE_TOKEN

# Device B: join with LIVE two-way sync — edits stream both ways in real time
mvc-agent join INVITE_TOKEN --live

# Anything with a connection can chat to the lobby
mvc-agent chat INVITE_TOKEN "hey team, I pushed a fix"
```

(After a manual/source install, add `--server https://mvc-server-staging.csomeone301.workers.dev`
to each command, or `export MVC_SERVER_URL=…` once.)

The invite token is `lobbyId:secret` — share it over any channel; only its hash is
stored server-side.

Live sync is CRDT-based (Yjs): every text file has a per-path document on the
lobby Durable Object, local edits are pushed as transaction updates, remote edits
land on your disk, and concurrent multi-device edits all survive — no last-writer
wins, no loops (echo guards at both ends). The merged CRDT state is persisted on
the server, so a device that joins later gets the current state even after the
worker has restarted. Supported ignores: `.git`, `node_modules`, `dist`, and a
`.lobbyignore` if you add one. Binaries sync whole-file with sha256 dedupe.

## Auto-update & AI CLI setup

```sh
mvc-agent update --check    # is there a newer build on the server?
mvc-agent update            # download (sha256-verified), install, re-link
mvc-agent setup --dry-run   # which AI CLIs will get the /mcp server?
mvc-agent setup             # register mvc as an MCP server in each detected CLI
mvc-agent setup --remove    # unregister again
```

The update source of truth is the server's `/version` endpoint (source sha256 +
build time). `setup` auto-detects Claude Code, Cursor, Windsurf, Zed and Gemini
by their config dirs/binaries and writes a remote HTTP MCP entry pointing at
`/mcp` into each (with a `.mvc.bak` backup). The tray app checks for updates
daily and applies them automatically when `MVC_AUTO_UPDATE=1`.

## License & distribution

MIT licensed. The project is self-hosted — no third-party registry or git host:
the public install page on the staging server serves the complete source at
`/source.tar.gz` (a gzipped tarball built from git-tracked files only, so
`.dev.vars` and other untracked secrets never ship), and `/license` serves the
MIT text.

## Release gate

Push to `main` → CI typecheck/tests → deploy staging → online E2E must pass
**before** a release tag is allowed.

_See [docs/PLAN.md](docs/PLAN.md) for the full design._