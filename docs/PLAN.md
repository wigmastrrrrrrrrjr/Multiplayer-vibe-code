# Multiplayer Vibe Code — Project Plan

> **A lobby owns a project folder. Every device that joins gets that folder synced
> to its own machine** — you code locally with whatever editor you like, and every
> change flows to everyone else's machine in real time, with no lost edits.
> AI models can join the same lobby and work in the same folder.
> Works on Windows, Ubuntu, Linux.

---

## 1. Locked-in decisions

| Question | Decision |
|---|---|
| Core feature | **Folder sync per lobby** — join a lobby → the project folder appears on your device and stays in sync |
| Merge strategy | **CRDT (Yjs) per text file** — concurrent edits from any device/model merge automatically, zero data loss |
| AI file access | **Per-file lock between models** — a model must hold the lock to edit a file; other models are refused until it's released. Humans are never locked |
| On-device agent | **Background tray app** (Dropbox-style) — join → folder appears, syncs silently |
| What syncs | **Smart ignores** — source + assets; auto-skip `node_modules`, `.git`, build/cache dirs; per-lobby `.lobbyignore` |
| Human editing surface | **Your own local editor** (VS Code, Neovim, anything). Optional web viewer for phones |
| Agent integration | **Generic MCP clients** — any MCP-capable model tool joins via `/mcp` |
| Command execution | **Runs on a device in the lobby — no cloud compute at all** — a model's `execute_command` goes *pending*, you approve it in the app, then it **runs locally on the approving device** (inside the synced folder) and the output syncs to every device. Approval lives in our UI, **never** in the agent's own permission prompts |
| Hosting | **Cloudflare Workers** — always-on 24/7; Durable Objects hold each lobby's folder; MCP on the Worker |
| Release | **Online tests against staging before every release** |

---

## 2. The concept

There is no "the cloud app." **The lobby *is* a project folder.** When you create a
lobby you get a token; anyone (or any model) who joins with it gets a synced copy
of the folder at `~/Lobbies/<project-name>` on their device. Everyone edits locally,
everyone sees everyone's changes live. Models join via MCP and edit the same folder.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐        ┌─────────────┐
│ PC (Windows) │   │ Laptop (Ubuntu)│  │ Friend (Linux)│       │ opencode /  │
│ ~/Lobbies/app│   │ ~/Lobbies/app │  │ ~/Lobbies/app│       │ Claude Code │
│ tray app     │   │ tray app      │  │ tray app     │       │ (via /mcp)  │
└──────┬───────┘   └──────┬───────┘  └──────┬───────┘       └──────┬──────┘
       └──────────────────┴─────────────────┴─────────────────────┘
                          │ WebSocket (wss), real-time
                 ┌────────┴──────────────────────────┐
                 │ Cloudflare Worker + Durable Object │
                 │  = the lobby's project folder      │
                 │  text files → Yjs docs (merge)     │
                 │  binaries → R2 (hash-addressed)    │
                 │  chat / presence / events          │
                 └────────────────────────────────────┘
```

---

## 3. What each device has

Every joined device holds a real folder on disk. The sync agent (tray app) keeps
it identical to the lobby's canonical folder:

- **Changes you make locally** — file create/edit/rename/delete → watched by the
  agent → pushed to the lobby within ~100ms.
- **Changes others make** (human or model) → pushed to you over WebSocket →
  written into your local folder → your editor shows them however it shows local
  edits (with Yjs there are no "external" edit markers — they're just file changes).
- **Joining** → instant snapshot: the agent pulls the canonical file index + latest
  content and materializes the folder.
- **Offline / reconnect** → on reconnect the agent pulls all Yjs updates it missed;
  CRDT merges everything you did offline with what others did. Nothing is lost.

---

## 4. The sync engine (inside the tray app)

The heart of the project. Same logic runs on Windows, Ubuntu, Linux (Node.js).

1. **Watch**: `chokidar` watches the lobby folder for create/change/rename/delete.
2. **Push**: text edits are sent as **Yjs updates** (tiny deltas, not whole files);
   binaries are chunk-uploaded with a content hash (only if hash changed).
3. **Apply**: incoming updates are applied to the local Yjs doc, then the merged
   text is written to disk atomically (write-file-atomic). Binaries stream from R2.
4. **Echo guard**: files the agent itself wrote are tagged as *self-applied* so the
   watcher doesn't re-push them (prevents infinite ping-pong loops).
5. **Ignores**: smart defaults (`node_modules/`, `.git/`, `dist/`, `build/`,
   `__pycache__/`, `.cache/`, etc.) + optional `.lobbyignore` in the folder root.
6. **Respects your editor**: no lock files, no `.lobby` metadata inside the folder
   where it gets in the way — metadata lives in the tray app's own data dir.

**Merge model:** one Yjs document per text file, persisted server-side. Two people
(and a model) can edit `auth.ts` at once — all three edits survive and merge.

> **Binary files** (images, audio, lockfiles): last-write-wins with content-addressed
> storage in R2; the newer timestamp wins, nothing merges — same as Dropbox.

---

## 5. Hosting: Cloudflare (unchanged, still 24/7 + MCP)

| Piece | Host |
|---|---|
| REST + auth + chat + presence | Worker |
| The lobby's folder (file index, Yjs docs, event bus) | **Durable Object per lobby** |
| Text doc persistence | DO SQLite (Yjs updates as blobs) |
| Binary files | **R2** (hash-addressed) |
| Command execution | **On member devices via the tray app** — approved commands run locally in the synced folder with the device's own shell; output streams back through the event bus. Zero cloud compute ⇒ near-zero cost (Workers free tier only) |
| MCP server | Worker at `/mcp` (Streamable HTTP + SSE) |
| WebSocket sync | Worker → DO (hibernatable sockets) |

Web viewer (optional, phones): the Worker can serve a read-only / simple-edit web
view of the folder — a bonus, not the main experience.

---

## 6. How models join (MCP)

Same MCP tools as before, now operating on the lobby's folder:

| Tool | Purpose |
|---|---|
| `lobby_join(token)` / `lobby_leave()` | Join/leave with a member identity |
| `presence_list()` | Who's here (humans + models), what they're editing |
| `file_list()` / `file_read(path)` / `file_stat(path)` | Explore the folder |
| `file_create(path, content)` | **Create a new file** — no lock needed (nothing to corrupt); materializes on every device instantly. Errors if path exists |
| `file_write(path, content)` | **Edit an existing file** — sends a *Yjs update*, merges like a human edit; refused `409` if another model holds the lock. Errors if path is missing |
| `file_rename(from, to)` / `file_delete(path)` | Rename/delete, broadcast to all devices; delete of a lock-held file is refused |
| `file_lock(path, {wait?})` | **Acquire** the per-file edit lock. Refused with "held by X" if another model holds it (or waits if `wait: true`) |
| `file_release(path)` | Release the lock (auto-releases on leave or lease expiry) |
| `chat_send(body, @mentions)` | Lobby chat everyone sees |
| `execute_command(cmd, {cwd?})` | **Run a command in the lobby's sandbox.** Returns `{id, status}` immediately; runs **only after a human approves in the UI** — the agent never prompts for permission itself |
| `command_cancel(id)` / `command_result(id)` | Cancel a pending/running command; poll a command's output + exit code |
| `events_recent(limit)` / `events_stream()` | Room activity (edits, chat, joins, presence, locks, commands) |

### AI file locks (mutual exclusion)

**Rule: a model cannot edit a file while another model holds that file's lock.**
This serializes model writes so two AIs never interleave rewrites of the same file
(even though Yjs would "merge" them, the result could be semantically corrupted —
this prevents that).

- **Acquire**: `file_lock(path)` — granted if free; refused with `409 held by <member>`
  if another model holds it (optional `wait: true` queues/waits up to a timeout).
- **Enforced on**: every `file_write` (MCP) and every model WebSocket edit. The lock
  holder may edit freely; a non-holder is refused until release.
- **Lease with TTL** (e.g. 5 min), renewed by a heartbeat while the model works —
  a crashed model's lock **auto-expires**, so files can never be locked forever.
- **Released on**: explicit `file_release`, `lobby_leave`, or lease expiry.
- **Visibility**: lock state is public — `presence_list` shows `locks: [{path, holder, since}]`
  and a lock/unlock event is broadcast, so other models pick a different file instead
  of waiting.
- **Humans are exempt**: their local editor writes merge via Yjs regardless; the lock
  only gates models.

### How a model creates a file — end to end

1. Model calls `file_create(path, content)` on the Worker's `/mcp` (JWT-authenticated).
2. The Worker routes it to the lobby's **Durable Object**.
3. The DO checks the path: **new path** → fresh Yjs doc + `FileIndexEntry` + persist to
   DO SQLite (text) / plan R2 (binary). **Creating never needs a lock** — nothing exists
   to corrupt. `file_write` on an existing path is lock-checked instead.
4. The DO broadcasts `{ kind: "file.change", op: "create" | "edit" | "delete" | "rename" }`
   to every connected member.
5. Every device's sync agent applies it and **materializes the file onto disk**
   (`~/Lobbies/<project>/…`) — it appears in humans' editors in real time.
6. Other models see it via `file_list`/`file_read` or the same event on their
   `events_stream`. Large scaffolds batch their creates.

**Models coordinate like humans:** Agent A calls `file_lock("auth.ts")` and posts
"taking auth.ts"; Agent B tries `file_write("auth.ts")` → **refused: held by A** — so
B picks `db.ts` instead. A edits freely, then `file_release`s. The human's editor
shows all changes live. Models never call each other — they share the lobby's event
stream and folder; the lock is the referee between them.

### Command execution & human approval

**Models can run commands, but only you decide – through the app's UI, never the
agent's own permission system.**

```
model: execute_command("npm test") ──▶ pending ──▶ YOU approve/reject in your app
                                                     │ approve (▸ "run on my device")
                                                     ▼
                        your tray app runs it locally in ~/Lobbies/<project>
                                                     │
                  output + exit code stream to EVERYONE (events + UI + other devices)
```

- **The gate is server-side.** The model's harness is configured to simply *allow* the
  `execute_command` tool — **no permission prompts are injected into the agent's
  context**. The model just calls the tool and gets a result when you've decided.
  This avoids the "keeps asking for permission in its own loop" problem entirely:
  there's only one approval, from you, on your device.
- **Pending card in the UI.** A request shows command + cwd + author (with a redacted
  preview) as a notification/card in the tray app and web viewer: **Approve / Reject**.
  Approving means *"run it on my device"* — the device that approves is the executor.
- **Approve → run locally, sync everywhere.** Your tray app spawns the command in the
  synced folder with your OS shell (cmd/PowerShell on Windows, bash/sh on Linux/free
  shells elsewhere). Output streams as `command.output` events — every device and
  every model sees the same live log, like a shared terminal that happens to run
  on your machine. The executing device is shown in the UI + audit log.
- **Reject / timeout.** Rejected gets a clean `rejected` result to the model; if no one
  approves within a timeout (e.g. 5 min) it auto-times-out. Cancellable while running
  (`command_cancel` kills the local process).
- **Human commands**: humans can run commands from the UI directly (no self-approval),
  also executing on their own device.
- **Lobby routing** (optional setting): route approved commands to a *specific* device
  (e.g. "Server-Laptop") instead of the approver's device.
- **Needs an online executor**: with no device connected, commands stay pending.
- **Toolchain reality**: the command runs with *that device's* tools — Node version,
  `node_modules`, etc. Executor identity is shown so everyone knows where it ran.
- **Audit**: every request, decision, executor, and output is part of the lobby event
  log.

---

## 7. Data model

```
Lobby { id, name, inviteToken, createdAt }

Member { id, name, kind: 'human' | 'agent', provider?, device? }

FileIndexEntry {
  path,                       // "src/auth.ts"
  kind: 'text' | 'binary',
  yDocState?: blob,           // text: persisted Yjs update (DO SQLite)
  r2Key?: string,  hash?,     // binary: R2 object
  updatedAt,  updatedBy
}

ChatMessage { id, lobbyId, author, body, mentions[], ts }

FileLock { path, holder: MemberId, since, leaseUntil }   // model-held per-file locks

CommandRequest {
  id, lobbyId, author: MemberId,
  cmd, cwd,
  executor?: DeviceId,             // device that runs it (default = approver's device)
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'timeout' | 'cancelled',
  output: [{ stream: 'stdout'|'stderr', text, ts }],
  exitCode?, decidedBy?, decidedAt?, startedAt?, finishedAt?
}

Event { lobbyId, ts, kind: 'file.change' | 'chat' | 'presence' | 'command' | 'system',
        author, payload }
```

---

## 8. Security on Cloudflare

- JWT + invite tokens; every API/WS/MCP call authenticated.
- TLS automatic (`https`/`wss`) on the Worker.
- Same-origin (UI + WS + `/mcp` on one Worker).
- Size caps (files, messages), rate limiting, audit log of agent actions.
- Tokens revocable; lobby deletion wipes DO SQLite + R2 objects.
- **Local command execution is explicit**: the approval card warns *"runs on your machine
  with your permissions"*; commands default to the lobby folder as working directory;
  `command_cancel` kills the process; execution is rate-limited and time-boxed.

---

## 9. Suggested repo layout

```
multiplayer-vibe-code/
├── packages/
│   ├── shared/        # types, protocol messages, ignore rules
│   ├── server/        # Worker: REST, WS, auth, rooms, MCP module
│   ├── server-do/     # Durable Object: file index, Yjs merge, event bus, commands
│   ├── agent/         # Electron tray app: sync engine (chokidar, Yjs), approval UI,
│   │                  #   and the command Executor (runs approved commands locally)
│   ├── web/           # optional browser viewer
│   └── e2e/           # online tests (2 real agents + MCP agent)
├── .github/workflows/ci.yml   # typecheck/test → staging deploy → online E2E gate
├── packages/server/wrangler.toml  # wrangler dev config (deploy via deploy script)
├── packages/server/scripts/deploy-worker.mjs  # wrangler-free deploy (esbuild-wasm + Workers JSON API)
├── docs/PLAN.md
└── README.md
```

---

## 10. Milestones

> Each milestone ships its tests; the online E2E suite grows with each step (§11).

### M0 — Scaffold
Monorepo, shared protocol types, Worker+DO skeleton, Electron app skeleton, CI.
**Done when:** staging Worker serves a hello page 24/7; tray app opens on Win/Ubuntu/Linux.

### M1 — Folder join (the wow moment)
Create/join lobby with token → agent pulls the canonical file index + content →
**the folder materializes at `~/Lobbies/<name>` with all files intact.**
**Done when:** Device B joins a lobby created on Device A and Device B's folder is a
working copy of A's (files, subdirs, small binaries).
**Status: ✅ done** — REST `/lobbies` + `/join`, HMAC member tokens, `/ws` hello →
snapshot, engine `create/join/push/materialize`; online E2E green on staging.

### M2 — Live one-way + full sync
Watch local folder → push changes → other devices apply in real time; chat works.
Echo guard prevents ping-pong. **Done when:** edit on A appears on B's disk ≈ real
time, both directions, no loops.
**Status: ✅ shipped with M3** — `mvc-agent join <token> --live` / `chat <token> "<body>"`;
chokidar watcher (ignores `.git`/`node_modules`/`dist`/`.lobbyignore`), 30s keepalive,
`#locks`/`command.*` reserved for M4/M5. Wire transport: single-frame UTF-8 JSON with
base64 payloads (protocol.ts) — documented deviation from the original binary-frame
note.

### M3 — CRDT merge + persistence
Yjs per text file (push updates rather than whole files); concurrent multi-device
edits merge; docs persisted to DO SQLite. **Done when:** A + B + C edit the same
file simultaneously → all chunks survive; lobby survives Worker restart.
**Status: ✅ done** — shared `yjs.ts` helpers (`mergeTextEdits` proof: three
concurrent writers, every chunk survives); engine mirrors per path, **transaction
updates** relayed through the DO, **full-state baselines** (`snapshot.docs`) so every
device shares item structure (a plain-text first touch publishes full state once);
DO merges into per-path `Y.Doc`, persists rendered `fileContent` **and** merged full
state (`y:<lobby>:<path>`) synchronously per `doc.sync` → durable across restarts;
echo guard at both ends (server broadcasts except sender; engine emits nothing when
disk == mirror). Binary files sync whole-file via `binary.put`/`binary.update` with
sha256 dedupe. Online E2E `m2-live-sync.spec.ts` gates staging (CI-only).
Design notes: a single delete-all+insert-all transaction re-anchors inserts to the
deleted lineage on receivers, so local edits are expressed as line-anchored diff
transactions (delete tx, then insert tx) — see `yjs.ts` + its tests.

### M4 — Models join (the vibe)
`/mcp` on the Worker with all tools; MCP auth; agent member type; **per-file locks**
(`file_lock`/`file_release`, lease + heartbeat, 409-on-locked `file_write`, lock state
in presence + lock events).
**Done when:** opencode or Claude Code joins a lobby, edits a file, the change shows
on humans' disks, and the model reads the humans' edits back via `events_recent`.
**Lock acceptance:** two models contest the same file → second is refused with holder
info; after `file_release` the second succeeds; a crashed holder's lock auto-expires.

### M5 — Command execution with human approval (on devices)
`execute_command` / `command_cancel` / `command_result` MCP tools; pending queue with
**Approve/Reject cards in the tray app + web viewer**; **device Executor in the tray
app** (spawns approved commands locally in the synced folder, streams output via
events, killable); approval timeout + cancellation + audit log; optional lobby routing
to a specific device.
**Done when:** a model's `npm test` shows as a pending card, runs locally on your
machine only after you approve, and its output appears on every device in real time;
reject/timeout/cancel paths work; the UI shows which device executed it.
**Acceptance — no agent-side prompts:** the model harness only ever sees the tool result
(pending → result), never an injected "may I?" prompt from the agent system.

### M6 — Binaries, ignores, polish
R2 for binaries; smart ignores + `.lobbyignore`; reconnect/merge; tray menu,
notifications, presence in tray; optional web viewer; token revocation.

---

## 11. Testing & release gate

**Nothing ships until online tests pass against the deployed staging Worker.**

```
push → CI (unit + integration) → wrangler deploy --env staging → ONLINE E2E
       (two real agents + MCP agent on the deployed lobby) → green → release
```

- **L1 Unit (CI):** auth, ignore rules, merge helpers, echo-guard logic.
- **L2 Integration:** local `wrangler dev` — **two simulated agents** editing the same
  file concurrently → merged result; join snapshot; chat round-trip; auth rejection.
  **Command approval:** pending → approve → runs → output broadcast; reject and
  approval-timeout paths.
- **L3 Online E2E (staging):** **two real tray agents** on distinct machines join the
  deployed lobby → edit on A appears on B's disk in real time; reconnect+merge works.
  **Approval UX:** a command request pops a card on the tray app; approving runs it
  **locally on that device** and the live output appears on the other device's UI in
  real time, with the executor identity shown.
- **L4 Online E2E (staging):** real MCP client joins via `/mcp`, edits a file → visible
  on agents' disks; human edit visible to model via `events_recent`. **Lock tests:**
  two agents contest one file → refusal with holder info → release → second succeeds;
  a crashed-holder lease expires and frees the file. **Command tests:** model's command
  is refused until a human approves via UI; reject returns `rejected` to the model.
- **Security smoke:** unauthenticated/expired tokens rejected; TLS enforced;
  oversize payloads rejected; rate limits trigger.

---

## 12. Risks & notes

- **Watcher echo loops** — self-applied writes must be tagged to avoid re-push;
  this is the #1 footgun and gets its own integration test.
- **DO SQLite 128MB cap** — text is tiny (Yjs updates); all binaries go to R2.
- **Electron size ~100–150MB** — acceptable for a Dropbox-style app; Tauri is the
  lighter alternative if bundle size ever matters (swap later, logic unchanged).
- **Native file watching** — chokidar works on all 3 OSes (inotify/FSEvents/ReadDirectoryChangesW).
- **Reconnect divergence** — solved by CRDT: pull missed Yjs updates, all edits merge.
- **Local execution runs with the user's own privileges** — the approval card warns
  "runs on your machine", commands default to the lobby folder, cancellable + time-boxed.
- **Toolchain variance across devices** — `npm test` may behave differently per machine
  (Node version, installed deps); executor identity is shown and audit-logged.
- **Needs an online executor** — pending commands wait (and timeout) if no device is
  connected to run them.
- **Cross-platform shells** — the Executor uses cmd/PowerShell on Windows, bash/sh on
  Linux; quoting + env differences are handled in one shared module.
- **Hocuspocus won't run on Workers** — we implement the small y-websocket protocol
  in the DO (or use y-sweet) — decided at M3.
- **Staging vs prod** — two wrangler envs; staging URL is the always-on test target.

---

## 13. Final decisions (locked at build start)

- **Yjs sync**: implement the wire protocol directly in the Durable Object — binary Yjs
  *updates* over WebSocket (we own both ends; no y-sweet, no Hocuspocus).
- **Monorepo**: npm workspaces; TypeScript strict everywhere; shared protocol types in
  `packages/shared`.
- **Auth (MVP)**: lobby invite token → short-lived HMAC-signed member token (secret via
  wrangler secret binding). No identity provider yet.
- **Persistence**: DO native SQLite — Yjs update blobs, file index, chat, pending
  commands. Binaries → R2 (hash-addressed).
- **Agent app**: Electron + React tray app. Tests: Vitest (unit/integration),
  Playwright (online E2E).
- **Deploy**: wrangler envs `dev` / `staging` / `prod`; staging = always-on E2E target.
- **Web viewer**: remains an optional post-MVP bonus (phones).