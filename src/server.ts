/**
 * ClaudeAppServer — core logic.
 *
 * Uses your locally installed `claude` CLI (no API key required).
 * Each turn spawns:   claude --print --output-format stream-json --include-partial-messages
 * and parses the NDJSON event stream back into JSON-RPC 2.0 notifications.
 *
 * Claude session IDs tie turns together so the CLI can --resume conversations.
 *
 * Methods:
 *   Session:   initialize
 *   Threads:   thread/start  thread/resume  thread/fork
 *   Turns:     turn/start    turn/steer     turn/interrupt
 *   Discovery: model/list    skills/list    app/list
 */

import { execFileSync, spawn } from "child_process";
import * as os from "os";
import * as readline from "readline";
import { v4 as uuid } from "uuid";

// Resolve the full path to the claude binary once at startup so that spawn()
// can find it even when ~/.local/bin is not in the inherited PATH.
function resolveClaude(): string {
  for (const cmd of ["which", "/usr/bin/which"]) {
    try {
      return execFileSync(cmd, ["claude"], { encoding: "utf-8" }).trim();
    } catch { /* try next */ }
  }
  return "claude"; // fall back; spawn will throw a clear error if not found
}

const CLAUDE_BIN = resolveClaude();

import {
  ok, rpcErr, notif,
  isRequest,
  E, RpcException,
  type RpcIncoming,
  type RpcResponse,
} from "./protocol.js";
import type {
  ConnectionState, Thread, Turn, StoredItem, PermissionMode,
} from "./types.js";
import { BUILTIN_SKILLS } from "./tools.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_NAME    = "claude-app-server";
const SERVER_VERSION = "1.0.0";

const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6",   name: "Claude Opus 4.6",   aliases: ["opus"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", aliases: ["sonnet"] },
  { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5",  aliases: ["haiku"] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createThread(cwd: string, permMode: PermissionMode): Thread {
  return { id: uuid(), created_at: Date.now(), turns: [], cwd, permission_mode: permMode };
}

function createTurn(threadId: string, userContent: string): Turn {
  return {
    id: uuid(),
    thread_id: threadId,
    status: "active",
    user_content: userContent,
    steer_queue: [],
    items: [],
    abortController: new AbortController(),
    created_at: Date.now(),
  };
}

function serializeTurn(turn: Turn) {
  return {
    id: turn.id, thread_id: turn.thread_id, status: turn.status,
    user_content: turn.user_content, items: turn.items,
    created_at: turn.created_at, completed_at: turn.completed_at, error: turn.error,
  };
}

// ─── ClaudeAppServer ─────────────────────────────────────────────────────────

export class ClaudeAppServer {
  private threads = new Map<string, Thread>();
  private claudePath: string;
  private debug: boolean;

  constructor(claudePath: string, debug = false) {
    this.claudePath = claudePath;
    this.debug = debug;
  }

  private log(...args: unknown[]): void {
    if (this.debug) process.stderr.write("[debug] " + args.join(" ") + "\n");
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  async handleMessage(msg: RpcIncoming, conn: ConnectionState): Promise<RpcResponse | null> {
    if (!isRequest(msg)) return null;       // client notifications are ignored
    const { id, method, params } = msg;
    try {
      if (!conn.initialized && method !== "initialize") {
        throw new RpcException(E.NotInitialized, "Not initialized. Send initialize first.");
      }
      const result = await this.dispatch(method, params, conn);
      return ok(id, result);
    } catch (e) {
      if (e instanceof RpcException) return rpcErr(id, e.code, e.message, e.data);
      return rpcErr(id, E.InternalError, String(e));
    }
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────

  private async dispatch(method: string, params: unknown, conn: ConnectionState): Promise<unknown> {
    switch (method) {
      case "initialize":       return this.initialize(params, conn);
      case "thread/start":     return this.threadStart(params);
      case "thread/resume":    return this.threadResume(params);
      case "thread/fork":      return this.threadFork(params);
      case "turn/start":       return this.turnStart(params, conn);
      case "turn/steer":       return this.turnSteer(params);
      case "turn/interrupt":   return this.turnInterrupt(params);
      case "approval/respond": return this.approvalRespond(params);
      case "model/list":       return { models: AVAILABLE_MODELS };
      case "skills/list":      return { skills: BUILTIN_SKILLS };
      case "app/list":         return { apps: [] };
      default:
        throw new RpcException(E.MethodNotFound, `Unknown method: ${method}`);
    }
  }

  // ── initialize ─────────────────────────────────────────────────────────────

  private initialize(params: unknown, conn: ConnectionState): unknown {
    const p = (params ?? {}) as {
      client?: { name?: string; version?: string };
      cwd?: string;
    };
    conn.initialized = true;
    conn.client_info = { name: p.client?.name ?? "unknown", version: p.client?.version ?? "0.0.0" };
    setImmediate(() => conn.send(notif("initialized", { server: SERVER_NAME })));
    return {
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: {
        threads:  ["start", "resume", "fork"],
        turns:    ["start", "steer", "interrupt"],
        models:   AVAILABLE_MODELS.map(m => m.id),
        skills:   BUILTIN_SKILLS.map(s => s.name),
      },
    };
  }

  // ── thread/start ───────────────────────────────────────────────────────────

  private threadStart(params: unknown): unknown {
    const p = (params ?? {}) as { cwd?: string; permission_mode?: PermissionMode };
    let cwd = p.cwd ?? process.cwd();
    // Expand ~ to the user's home directory (Node spawn doesn't do this)
    if (cwd === "~") cwd = os.homedir();
    else if (cwd.startsWith("~/")) cwd = os.homedir() + cwd.slice(1);
    const thread = createThread(cwd, p.permission_mode ?? "default");
    this.threads.set(thread.id, thread);
    return { thread_id: thread.id, created_at: thread.created_at };
  }

  // ── thread/resume ──────────────────────────────────────────────────────────

  private threadResume(params: unknown): unknown {
    const p = params as { thread_id: string };
    const thread = this.getThread(p.thread_id);
    return {
      thread_id:       thread.id,
      created_at:      thread.created_at,
      cwd:             thread.cwd,
      permission_mode: thread.permission_mode,
      cli_session_id:  thread.cliSessionId,
      turns:           thread.turns.map(serializeTurn),
    };
  }

  // ── thread/fork ────────────────────────────────────────────────────────────

  private threadFork(params: unknown): unknown {
    const p = params as { thread_id: string };
    const src = this.getThread(p.thread_id);

    if (!src.cliSessionId) {
      throw new RpcException(E.InvalidParams ?? -32602,
        "Cannot fork a thread that has no turns yet.");
    }

    // Create new thread that will fork the source session on its first turn
    const forked = createThread(src.cwd, src.permission_mode);
    forked.forkFrom = { cliSessionId: src.cliSessionId };
    this.threads.set(forked.id, forked);

    return { thread_id: forked.id, forked_from: src.id, created_at: forked.created_at };
  }

  // ── turn/start ─────────────────────────────────────────────────────────────

  private async turnStart(params: unknown, conn: ConnectionState): Promise<unknown> {
    const p = params as { thread_id: string; content: string; model?: string };
    const thread = this.getThread(p.thread_id);

    if (thread.active_turn_id) {
      throw new RpcException(E.TurnBusy, "Thread already has an active turn. Interrupt it first.");
    }

    const turn = createTurn(thread.id, p.content);

    // Prepend any queued steer content from the last completed turn
    if (turn.steer_queue.length > 0) {
      turn.user_content = turn.steer_queue.join("\n\n") + "\n\n" + turn.user_content;
      turn.steer_queue = [];
    }

    thread.turns.push(turn);
    thread.active_turn_id = turn.id;

    setImmediate(() => {
      conn.send(notif("turn/started", { turn_id: turn.id, thread_id: thread.id }));
      this.runClaudeTurn(thread, turn, conn, p.model).catch((err: unknown) => {
        turn.status = "error";
        turn.error = String(err);
        turn.completed_at = Date.now();
        thread.active_turn_id = undefined;
        conn.send(notif("turn/error", { turn_id: turn.id, error: String(err) }));
      });
    });

    return { turn_id: turn.id };
  }

  // ── turn/steer ─────────────────────────────────────────────────────────────

  private turnSteer(params: unknown): unknown {
    const p = params as { thread_id: string; content: string };
    const thread = this.getThread(p.thread_id);

    // Queue for the next turn (active turn's queue, or thread-level queue)
    if (thread.active_turn_id) {
      const turn = thread.turns.find(t => t.id === thread.active_turn_id)!;
      turn.steer_queue.push(p.content);
      return { turn_id: turn.id, note: "queued: will be prepended to the next user message" };
    }

    throw new RpcException(E.NoActiveTurn, "No active turn to steer.");
  }

  // ── turn/interrupt ─────────────────────────────────────────────────────────

  private turnInterrupt(params: unknown): unknown {
    const p = params as { thread_id: string };
    const thread = this.getThread(p.thread_id);

    if (!thread.active_turn_id) {
      throw new RpcException(E.NoActiveTurn, "No active turn to interrupt.");
    }

    const turn = thread.turns.find(t => t.id === thread.active_turn_id)!;
    turn.abortController.abort();

    // SIGTERM the claude subprocess if it's running
    if (turn.process) {
      turn.process.kill("SIGTERM");
    }

    turn.status = "interrupted";
    turn.completed_at = Date.now();
    thread.active_turn_id = undefined;

    return { turn_id: turn.id, status: "interrupted" };
  }

  // ── approval/respond ───────────────────────────────────────────────────────

  private approvalRespond(params: unknown): unknown {
    const p = params as {
      thread_id: string;
      approved: boolean;
      permission_mode?: PermissionMode;
    };
    const thread = this.getThread(p.thread_id);

    if (p.approved) {
      // Upgrade the thread's permission mode for all subsequent turns.
      // Caller can specify exactly which mode; default to "acceptEdits" which
      // auto-approves file writes/edits but still guards arbitrary shell commands.
      thread.permission_mode = p.permission_mode ?? "acceptEdits";
    }

    return {
      thread_id:       thread.id,
      approved:        p.approved,
      permission_mode: thread.permission_mode,
      note: p.approved
        ? `Permission mode updated to "${thread.permission_mode}". Retry your turn/start.`
        : "Approval denied. Permission mode unchanged.",
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Claude subprocess runner
  // ─────────────────────────────────────────────────────────────────────────

  private async runClaudeTurn(
    thread: Thread,
    turn: Turn,
    conn: ConnectionState,
    model?: string,
  ): Promise<void> {
    const args = this.buildClaudeArgs(thread, model);
    this.log(`spawn: ${this.claudePath} ${args.join(" ")}`);
    this.log(`cwd: ${thread.cwd}`);

    const proc = spawn(this.claudePath, args, {
      cwd:   thread.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env:   { ...process.env, CLAUDECODE: undefined } as NodeJS.ProcessEnv,
    });
    turn.process = proc;

    // Register exit/error promise BEFORE reading stdout so we never miss
    // early events (e.g. spawn failures where 'error' fires immediately).
    let spawnError: Error | undefined;
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", (code) => { this.log(`exit code: ${code}`); resolve(code); });
      proc.on("error", (err: Error) => {
        this.log(`proc error: ${err}`);
        spawnError = err;
        resolve(null);
      });
    });

    // Write user content to stdin, then close it
    const stdinContent = turn.user_content;
    this.log(`stdin: ${JSON.stringify(stdinContent)}`);
    try {
      proc.stdin.write(stdinContent, "utf-8");
      proc.stdin.end();
    } catch {
      // stdin may be unusable if spawn failed; ignore
    }

    // Capture stderr for error reporting
    let stderrBuf = "";
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderrBuf += text;
      this.log(`stderr: ${text.trimEnd()}`);
    });

    // Abort → kill the subprocess
    turn.abortController.signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    }, { once: true });

    // Parse stdout as NDJSON events
    const rl = readline.createInterface({ input: proc.stdout, terminal: false });

    // Track partial message text to compute deltas
    const partialText = new Map<string, string>();   // messageId → accumulated text
    const partialThink = new Map<string, string>();  // messageId → accumulated thinking

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.log(`stdout: ${trimmed}`);

      let event: ClaudeStreamEvent;
      try { event = JSON.parse(trimmed) as ClaudeStreamEvent; } catch { continue; }

      this.processClaudeEvent(event, thread, turn, conn, partialText, partialThink);
    }

    // Wait for process to exit (listeners already registered above)
    const exitCode = await exitPromise;

    // Treat 0 and 130 (SIGINT) as OK; spawn errors and non-zero exits are failures
    const aborted = turn.abortController.signal.aborted;
    if (!aborted && spawnError) {
      throw new Error(
        `Failed to spawn claude: ${spawnError.message}` +
        (stderrBuf ? `\nstderr: ${stderrBuf.slice(0, 500)}` : "")
      );
    }
    if (!aborted && exitCode !== null && exitCode !== 0 && exitCode !== 130) {
      throw new Error(
        `claude exited with code ${exitCode}` +
        (stderrBuf ? `\nstderr: ${stderrBuf.slice(0, 500)}` : "")
      );
    }

    turn.status       = aborted ? "interrupted" : "completed";
    turn.completed_at = Date.now();
    thread.active_turn_id = undefined;

    conn.send(notif("turn/completed", {
      turn_id:      turn.id,
      thread_id:    thread.id,
      status:       turn.status,
      items_count:  turn.items.length,
      completed_at: turn.completed_at,
    }));
  }

  // ── Build claude args ──────────────────────────────────────────────────────

  private buildClaudeArgs(thread: Thread, model?: string): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", thread.permission_mode,
    ];

    if (model) args.push("--model", model);

    if (thread.forkFrom && !thread.cliSessionId) {
      // First turn of a forked thread: resume source and fork
      args.push("--resume", thread.forkFrom.cliSessionId, "--fork-session");
    } else if (!thread.cliSessionId) {
      // First turn of a brand-new thread: create session with our thread id
      args.push("--session-id", thread.id);
    } else {
      // Subsequent turns: resume the existing session
      args.push("--resume", thread.cliSessionId);
    }

    return args;
  }

  // ── Process a single stream-json event ────────────────────────────────────

  private processClaudeEvent(
    event: ClaudeStreamEvent,
    thread: Thread,
    turn: Turn,
    conn: ConnectionState,
    partialText:  Map<string, string>,
    partialThink: Map<string, string>,
  ): void {
    switch (event.type) {

      // ── system/init ─────────────────────────────────────────────────────
      case "system": {
        if (event.subtype === "init" && event.session_id) {
          thread.cliSessionId = event.session_id;
        }
        break;
      }

      // ── assistant message ────────────────────────────────────────────────
      case "assistant": {
        const msg    = event.message;
        const msgId  = msg.id ?? "unknown";
        const partial = !!event.is_partial;

        for (const block of (msg.content ?? [])) {

          if (block.type === "text") {
            const prev  = partialText.get(msgId) ?? "";
            const delta = block.text.slice(prev.length);

            if (delta) {
              // Stream delta to client
              conn.send(notif("item/progress", {
                turn_id: turn.id,
                delta:   { type: "text", text: delta },
              }));
              partialText.set(msgId, block.text);
            }

            if (!partial) {
              // Final version: persist as a complete item
              const item: StoredItem = {
                id: uuid(), created_at: Date.now(),
                item: { type: "text", text: block.text },
              };
              turn.items.push(item);
              conn.send(notif("item/created", { turn_id: turn.id, item }));
              partialText.delete(msgId);
            }

          } else if (block.type === "thinking" && !partial) {
            const prevThink  = partialThink.get(msgId) ?? "";
            const thinkDelta = block.thinking.slice(prevThink.length);
            if (thinkDelta) {
              conn.send(notif("item/progress", {
                turn_id: turn.id,
                delta:   { type: "thinking", thinking: thinkDelta },
              }));
            }
            const item: StoredItem = {
              id: uuid(), created_at: Date.now(),
              item: { type: "thinking", thinking: block.thinking },
            };
            turn.items.push(item);
            conn.send(notif("item/created", { turn_id: turn.id, item }));
            partialThink.delete(msgId);

          } else if (block.type === "tool_use" && !partial) {
            const item: StoredItem = {
              id: uuid(), created_at: Date.now(),
              item: {
                type: "tool_call",
                tool_use_id: block.id,
                name: block.name,
                input: block.input,
              },
            };
            turn.items.push(item);
            conn.send(notif("item/created", { turn_id: turn.id, item }));
          }
        }
        break;
      }

      // ── user message (tool results) ──────────────────────────────────────
      case "user": {
        for (const block of (event.message?.content ?? [])) {
          if (block.type === "tool_result") {
            const rawContent = block.content;
            const content = Array.isArray(rawContent)
              ? rawContent.map((c: { text?: string }) => c.text ?? "").join("")
              : String(rawContent ?? "");

            const item: StoredItem = {
              id: uuid(), created_at: Date.now(),
              item: {
                type:        "tool_result",
                tool_use_id: block.tool_use_id,
                content,
                is_error:    !!block.is_error,
              },
            };
            turn.items.push(item);
            conn.send(notif("item/created", { turn_id: turn.id, item }));
          }
        }
        break;
      }

      // ── result (turn complete) ───────────────────────────────────────────
      case "result": {
        // session_id may be updated (e.g. after a fork)
        if (event.session_id) thread.cliSessionId = event.session_id;

        if (event.subtype === "error") {
          turn.status = "error";
          turn.error  = event.error ?? "unknown error";
        }

        // Forward permission denials so the client can show approval UI
        if (event.permission_denials && event.permission_denials.length > 0) {
          conn.send(notif("turn/permission_denied", {
            turn_id:    turn.id,
            thread_id:  thread.id,
            denials:    event.permission_denials,
          }));
        }
        break;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getThread(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new RpcException(E.ThreadNotFound, `Thread not found: ${id}`);
    return t;
  }
}

// ─── stream-json event types (from claude --output-format stream-json) ────────

type ClaudeContentBlock =
  | { type: "text";        text: string }
  | { type: "thinking";    thinking: string }
  | { type: "tool_use";    id: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

interface ClaudeMessage {
  id?: string;
  role?: string;
  content?: ClaudeContentBlock[];
}

type ClaudeStreamEvent =
  | { type: "system";    subtype: string; session_id?: string; cwd?: string; tools?: string[]; model?: string; permissionMode?: string }
  | { type: "assistant"; message: ClaudeMessage; is_partial?: boolean; session_id?: string }
  | { type: "user";      message: ClaudeMessage; session_id?: string }
  | { type: "result";    subtype: string; session_id?: string; error?: string; result?: string; cost_usd?: number; is_error?: boolean; permission_denials?: { tool_name: string; tool_use_id: string; tool_input?: unknown }[] };
