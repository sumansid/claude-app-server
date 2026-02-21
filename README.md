# claude-app-server

A **JSON-RPC 2.0 server** that wraps **Claude Code** capabilities — the Claude equivalent of the OpenAI Codex App Server.

Clients communicate over **stdio** (default) or **WebSocket**, using newline-delimited JSON (NDJSON). The same protocol that powers VS Code extensions, web UIs, and other rich clients.

---

## Quick start

```bash
# Install
npm install

# Build
npm run build

# Run (stdio — default)
ANTHROPIC_API_KEY=sk-... node dist/index.js

# Run (WebSocket on port 3284)
ANTHROPIC_API_KEY=sk-... node dist/index.js --transport ws --port 3284
```

---

## Protocol overview

Messages are newline-delimited JSON, following [JSON-RPC 2.0](https://www.jsonrpc.org/specification).

### Handshake

```jsonc
// Client → Server
{ "jsonrpc": "2.0", "method": "initialize", "params": {
    "client": { "name": "my-app", "version": "1.0.0" },
    "cwd": "/path/to/project",
    "permission_mode": "default"   // "default" | "acceptEdits" | "bypassPermissions"
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
| `thread/fork` | `{ thread_id, at_turn_id? }` | `{ thread_id, forked_from, created_at }` |

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
| `approval/respond` | `{ request_id, approved }` | Reply to an `approval/request` notification |

---

## Server notifications

After `turn/start`, the server streams these notifications:

| Notification | When |
|-------------|------|
| `turn/started` | Turn began |
| `item/progress` | Streaming text delta — `{ turn_id, item_id, delta: { type, text } }` |
| `item/created` | An item was finalized (text, tool_call, tool_result, file_change, command_output) |
| `approval/request` | Dangerous operation needs approval — `{ request_id, tool_name, description, input }` |
| `turn/completed` | Turn finished — `{ turn_id, status, items_count, completed_at }` |
| `turn/error` | Turn failed — `{ turn_id, error }` |

---

## Permission modes

| Mode | Behaviour |
|------|-----------|
| `default` | Prompts (via `approval/request`) for `bash` and file writes |
| `acceptEdits` | Auto-approves file writes; prompts for `bash` |
| `bypassPermissions` | Approves all tools automatically |

---

## Tools (skills)

| Tool | Description | Needs approval |
|------|-------------|---------------|
| `read_file` | Read file contents (with optional line range) | No |
| `write_file` | Write / create a file | Yes (default mode) |
| `bash` | Execute a shell command | Yes (always, unless bypass) |
| `list_files` | List directory entries | No |
| `search_files` | Regex search (ripgrep / grep) | No |
| `glob` | Find files by glob pattern | No |

---

## Example session

```bash
# Start the server
node dist/index.js

# Send over stdio (each line is one JSON-RPC message):
{"jsonrpc":"2.0","method":"initialize","params":{"client":{"name":"demo","version":"1.0"},"cwd":"/tmp/my-project"},"id":1}
{"jsonrpc":"2.0","method":"thread/start","params":{"cwd":"/tmp/my-project","permission_mode":"acceptEdits"},"id":2}
{"jsonrpc":"2.0","method":"turn/start","params":{"thread_id":"<id from above>","content":"List the files in this project and summarize what it does."},"id":3}
```

---

## Architecture

```
src/
  index.ts       CLI entry point — parses --transport / --port
  protocol.ts    JSON-RPC 2.0 types and helpers
  types.ts       Domain types: Thread → Turn → Item
  transport.ts   stdio and WebSocket transports
  tools.ts       Tool definitions (Claude API format) + execution logic
  server.ts      ClaudeAppServer — method handlers + agentic streaming loop
```

### Agentic loop

```
turn/start received
  → build conversation history from thread
  → stream Claude API call (adaptive thinking, tool use)
    → emit item/progress for each text delta
  → await finalMessage
  → if tool_use:
      → for each tool call:
          → check approval policy → maybe emit approval/request → await approval/respond
          → execute tool
          → emit item/created (tool_call, tool_result, file_change, command_output)
      → add tool results → loop
  → emit turn/completed
```

---

## Models

Defaults to `claude-opus-4-6` with adaptive thinking. Override per turn:

```json
{ "method": "turn/start", "params": { "thread_id": "…", "content": "…", "model": "claude-sonnet-4-6" } }
```
