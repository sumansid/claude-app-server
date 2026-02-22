/**
 * Transport layer: stdio (default) and WebSocket.
 *
 * Both transports create a ConnectionState and forward incoming NDJSON lines
 * to the server, and provide a send() function for outgoing messages.
 */

import * as readline from "readline";
import { URL } from "url";
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

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line) => {
    const msg = parseLine(line);
    if (msg) dispatch(msg, conn, server).catch(() => {});
  });

  rl.on("close", () => process.exit(0));

  process.stderr.write("[claude-app-server] listening on stdio\n");
}

// ─── WebSocket transport ──────────────────────────────────────────────────────

export interface WsOptions {
  pairKey: string;
  debug?: boolean;
}

export function startWebSocket(
  server: ClaudeAppServer,
  port: number,
  options: WsOptions,
): void {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws: WebSocket, req) => {
    // ─── Pair key validation ──────────────────────────────────────────
    const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
    const clientKey = reqUrl.searchParams.get("key");
    if (options.debug) {
      process.stderr.write(
        `[debug] ws connection req.url=${req.url} clientKey=${clientKey} expected=${options.pairKey}\n`,
      );
    }
    if (clientKey !== options.pairKey) {
      ws.close(4401, "Invalid pair key");
      return;
    }

    const conn = makeConnection((msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Socket closed between readyState check and send; ignore
      }
    });

    ws.on("message", (data) => {
      const msg = parseLine(data.toString());
      if (msg) dispatch(msg, conn, server).catch(() => {});
    });
  });

  process.stderr.write(
    `[claude-app-server] listening on ws://0.0.0.0:${port} (use WSS for secure connections)\n `,
  ); // change to WSS later
}
