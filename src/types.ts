/**
 * Domain types: Thread → Turn → Item hierarchy.
 *
 * Thread   A conversation between user and agent (maps 1:1 to a claude session).
 * Turn     A single user request + all agent work that follows.
 * Item     An atomic unit of content (text, tool call, file change, …).
 */

import type { ChildProcess } from "child_process";

// ─── Permissions ─────────────────────────────────────────────────────────────

/** Maps directly to claude's --permission-mode flag. */
export type PermissionMode =
  | "default"           // prompt for dangerous ops
  | "acceptEdits"       // auto-approve file edits
  | "bypassPermissions" // approve everything (use in sandboxes only)
  | "dontAsk"           // skip prompts, don't approve (log only)

// ─── Items ───────────────────────────────────────────────────────────────────

export interface TextItem     { type: "text";           text: string }
export interface ThinkingItem { type: "thinking";       thinking: string }

export interface ToolCallItem {
  type: "tool_call";
  tool_use_id: string;
  name: string;
  input: unknown;
}

export interface ToolResultItem {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface FileChangeItem {
  type: "file_change";
  path: string;
  operation: "create" | "update" | "delete";
}

export interface CommandOutputItem {
  type: "command_output";
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type Item =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | ToolResultItem
  | FileChangeItem
  | CommandOutputItem;

export interface StoredItem {
  id: string;
  created_at: number;
  item: Item;
}

// ─── Turn ─────────────────────────────────────────────────────────────────────

export type TurnStatus = "active" | "completed" | "interrupted" | "error";

export interface Turn {
  id: string;
  thread_id: string;
  status: TurnStatus;

  /** Content the user sent to start this turn. */
  user_content: string;

  /** Extra content queued via turn/steer (injected into next claude call). */
  steer_queue: string[];

  /** All items produced during this turn. */
  items: StoredItem[];

  /** The running claude subprocess for this turn (if still active). */
  process?: ChildProcess;

  abortController: AbortController;

  created_at: number;
  completed_at?: number;
  error?: string;
}

// ─── Thread ───────────────────────────────────────────────────────────────────

export interface Thread {
  id: string;
  created_at: number;
  turns: Turn[];
  cwd: string;
  permission_mode: PermissionMode;
  active_turn_id?: string;

  /**
   * The actual claude CLI session ID captured from the "system/init" event.
   * May differ from thread.id for forked threads.
   */
  cliSessionId?: string;

  /**
   * Set when this thread was forked from another.
   * Used to pass --resume <id> --fork-session on the first turn.
   */
  forkFrom?: { cliSessionId: string };
}

// ─── Connection State ─────────────────────────────────────────────────────────

export interface ConnectionState {
  initialized: boolean;
  client_info?: { name: string; version: string };
  /** send a message to the connected client */
  send: (msg: unknown) => void;
}
