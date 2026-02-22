# claude-app-server

A **JSON-RPC 2.0 server** that wraps **Claude Code** capabilities — the Claude equivalent of the OpenAI Codex App Server.

```
npm i claude-app-server
```


No API key required. Authentication is handled by the `claude` CLI (`claude auth`).

Clients communicate over **stdio** (default) or **WebSocket**, using newline-delimited JSON (NDJSON).

---

## Requirements

- Node.js >= 18
- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude auth`)
- pnpm

---

## Quick start

```bash
# Install
pnpm install

# Build
pnpm run build

# Start with WebSocket + QR code (recommended)
claude-app-server start

# Or install globally first
pnpm install -g .
claude-app-server start
claude-app-server start --port 4000
```

On startup you'll see:

```
  claude-app-server  ·  WebSocket
  ─────────────────────────────────
  Local:    ws://localhost:3284?key=AbC123
  Network:  ws://192.168.x.x:3284
  Pair Key: AbC123

  ▄▄▄ ... QR code ...
  Scan to connect
```

A random 6-character **pair key** is generated each time the server starts. The key is embedded in the QR code URL. Clients connecting without a valid key are rejected (close code 4401).

Scan the QR code from any device on the same Wi-Fi to connect.

---

## Transports

| Command | Transport | Notes |
|---------|-----------|-------|
| `claude-app-server start` | WebSocket :3284 | Shows QR code, binds to all interfaces |
| `claude-app-server start --port N` | WebSocket :N | Custom port |
| `claude-app-server --transport ws` | WebSocket :3284 | No QR code |
| `claude-app-server` | stdio | For piped/programmatic use |

---

## Protocol overview

Messages are newline-delimited JSON, following [JSON-RPC 2.0](https://www.jsonrpc.org/specification).

### Handshake

```jsonc
// Client → Server
{ "jsonrpc": "2.0", "method": "initialize", "params": {
    "client": { "name": "my-app", "version": "1.0.0" },
    "cwd": "/path/to/project"
  }, "id": 1 }

// Server → Client (response)
{ "jsonrpc": "2.0", "result": {
    "server": { "name": "claude-app-server", "version": "1.0.0" },
    "capabilities": { ... }
  }, "id": 1 }

// Server → Client (notification, async)
{ "jsonrpc": "2.0", "method": "initialized", "params": { "server": "claude-app-server" } }
```

---

## Methods

### Thread management

| Method | Params | Returns |
|--------|--------|---------|
| `thread/start` | `{ cwd?, permission_mode? }` | `{ thread_id, created_at }` |
| `thread/resume` | `{ thread_id }` | `{ thread_id, turns[], cwd, … }` |
| `thread/fork` | `{ thread_id }` | `{ thread_id, forked_from, created_at }` |

### Turn management

| Method | Params | Returns |
|--------|--------|---------|
| `turn/start` | `{ thread_id, content, model? }` | `{ turn_id }` |
| `turn/steer` | `{ thread_id, content }` | `{ turn_id }` |
| `turn/interrupt` | `{ thread_id }` | `{ turn_id, status }` |

`turn/start` returns immediately; the agent streams back **notifications** until `turn/completed`.

### Discovery

| Method | Returns |
|--------|---------|
| `model/list` | List of available Claude models |
| `skills/list` | List of available tools (read_file, bash, …) |
| `app/list` | (stub, always empty) |

### Approval

| Method | Params | Description |
|--------|--------|-------------|
| `approval/respond` | `{ thread_id, approved, permission_mode? }` | Respond to a permission prompt |

---

## Server notifications

After `turn/start`, the server streams these notifications:

| Notification | When |
|-------------|------|
| `turn/started` | Turn began |
| `item/progress` | Streaming text delta — `{ turn_id, delta: { type, text } }` |
| `item/created` | Item finalized (text, tool_call, tool_result) |
| `turn/completed` | Turn finished — `{ turn_id, status, items_count, completed_at }` |
| `turn/error` | Turn failed — `{ turn_id, error }` |

---

## Permission modes

| Mode | Behaviour |
|------|-----------|
| `default` | Prompts for bash and file writes |
| `acceptEdits` | Auto-approves file writes; prompts for bash |
| `bypassPermissions` | Approves all tools automatically |

---

## Example session (stdio)

```bash
node dist/index.js
```

```jsonc
// Initialize
{"jsonrpc":"2.0","method":"initialize","params":{"client":{"name":"demo","version":"1.0"},"cwd":"/tmp/my-project"},"id":1}

// Start a thread
{"jsonrpc":"2.0","method":"thread/start","params":{"cwd":"/tmp/my-project","permission_mode":"acceptEdits"},"id":2}

// Start a turn
{"jsonrpc":"2.0","method":"turn/start","params":{"thread_id":"<id>","content":"List the files in this project."},"id":3}
```

---

## Architecture

```
src/
  index.ts       CLI entry — parses subcommand / flags, shows QR code
  protocol.ts    JSON-RPC 2.0 types and helpers
  types.ts       Domain types: Thread → Turn → Item
  transport.ts   stdio and WebSocket transports
  tools.ts       Built-in skills catalog
  server.ts      ClaudeAppServer — method handlers + claude CLI runner
```

Each turn spawns:
```
claude --print --output-format stream-json --include-partial-messages
       --permission-mode <mode>
       --session-id <id>    # first turn of a thread
       --resume <id>        # subsequent turns
```

---

## Models

Default model can be overridden per turn:

```json
{ "method": "turn/start", "params": { "thread_id": "…", "content": "…", "model": "claude-haiku-4-5" } }
```

Available: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
