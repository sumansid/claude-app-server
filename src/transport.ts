/**
 * Transport layer: stdio (default) and WebSocket.
 *
 * Both transports create a ConnectionState and forward incoming NDJSON lines
 * to the server, and provide a send() function for outgoing messages.
 */

import * as readline from "readline";
import { WebSocketServer, WebSocket } from "ws";
import { parseLine } from "./protocol.js";
import type { RpcIncoming } from "./protocol.js";
import type { ConnectionState } from "./types.js";
import { ClaudeAppServer } from "./server.js";

// ─── Connection factory ───────────────────────────────────────────────────────

function makeConnection(sendFn: (msg: unknown) => void): ConnectionState {
  return { initialized: false, send: sendFn };
}

// ─── Message dispatcher ───────────────────────────────────────────────────────

async function dispatch(
  raw: RpcIncoming,
  conn: ConnectionState,
  server: ClaudeAppServer,
): Promise<void> {
  const response = await server.handleMessage(raw, conn);
  if (response) conn.send(response);
}

// ─── stdio transport ──────────────────────────────────────────────────────────

export function startStdio(server: ClaudeAppServer): void {
  const conn = makeConnection((msg) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const msg = parseLine(line);
    if (msg) dispatch(msg, conn, server).catch(console.error);
  });

  rl.on("close", () => process.exit(0));

  process.stderr.write("[claude-app-server] listening on stdio\n");
}

// ─── WebSocket transport ──────────────────────────────────────────────────────

export function startWebSocket(server: ClaudeAppServer, port: number): void {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws: WebSocket) => {
    const conn = makeConnection((msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data) => {
      const msg = parseLine(data.toString());
      if (msg) dispatch(msg, conn, server).catch(console.error);
    });
  });

  process.stderr.write(`[claude-app-server] listening on ws://localhost:${port}\n`);
}
