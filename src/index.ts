#!/usr/bin/env node
/**
 * claude-app-server — entry point
 *
 * Wraps your locally installed `claude` CLI. No API key required.
 * Authentication is handled by Claude Code itself (run `claude auth` to log in).
 *
 * Usage:
 *   claude-app-server                          # stdio (default)
 *   claude-app-server start                    # WebSocket on port 3284 + QR code
 *   claude-app-server start --port 4000        # custom port
 *   claude-app-server --transport ws           # WebSocket (legacy flags)
 *   claude-app-server --transport ws --port 4000
 */

import { ClaudeAppServer } from "./server.js";
import { startStdio, startWebSocket } from "./transport.js";
import { execSync } from "child_process";
import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import { realpathSync } from "fs";
import qr from "qrcode-terminal";

// ─── Network helpers ──────────────────────────────────────────────────────────

function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// ─── Pair key generation ─────────────────────────────────────────────────────

function generatePairKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(6);
  let key = "";
  for (let i = 0; i < 6; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

// ─── QR display ───────────────────────────────────────────────────────────────

function printStartBanner(port: number, pairKey: string): void {
  const lan = getLanIp();
  const lanUrl = lan ? `ws://${lan}:${port}?key=${pairKey}` : null;
  const localUrl = `ws://localhost:${port}?key=${pairKey}`;

  process.stderr.write("\n");
  process.stderr.write("  claude-app-server  ·  WebSocket\n");
  process.stderr.write("  ─────────────────────────────────\n");
  process.stderr.write(`  Local:    ${localUrl}\n`);
  if (lan) {
    process.stderr.write(`  Network:  ws://${lan}:${port}\n`);
  }
  process.stderr.write(`  Pair Key: ${pairKey}\n`);
  process.stderr.write("\n");

  const connectUrl = lanUrl ?? localUrl;

  qr.generate(connectUrl, { small: true }, (code: string) => {
    // Indent each line of the QR block
    const indented = code
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    process.stderr.write(indented + "\n");
    process.stderr.write(`  Scan to connect\n\n`);
  });
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  subcommand: "start" | null;
  transport: "stdio" | "ws";
  port: number;
  showQr: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let subcommand: "start" | null = null;
  let transport: "stdio" | "ws" = "stdio";
  let port = 3284;
  let showQr = false;
  let debug = false;

  // Check for `start` subcommand as first token
  if (args[0] === "start") {
    subcommand = "start";
    transport = "ws";
    showQr = true;
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1]) {
      const t = args[++i];
      if (t === "ws" || t === "websocket") transport = "ws";
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--debug") {
      debug = true;
    }
  }

  return { subcommand, transport, port, showQr, debug };
}

// ─── Claude CLI check ─────────────────────────────────────────────────────────

function checkClaude(): string {
  try {
    const resolved = execSync("which claude", { stdio: "pipe" }).toString().trim();
    if (!resolved) throw new Error("not found");
    // Resolve symlinks so spawn gets the real executable path
    return realpathSync(resolved);
  } catch {
    process.stderr.write(
      "[claude-app-server] ERROR: `claude` CLI not found.\n" +
        "Install Claude Code: https://claude.ai/code\n" +
        "Then log in: claude auth\n",
    );
    process.exit(1);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

function main() {
  const claudePath = checkClaude();
  const { transport, port, showQr, debug } = parseArgs(process.argv);
  const server = new ClaudeAppServer(claudePath, debug);

  if (transport === "ws") {
    const pairKey = generatePairKey();

    if (showQr) {
      printStartBanner(port, pairKey);
    }
    startWebSocket(server, port, { pairKey, debug });
  } else {
    startStdio(server);
  }
}

main();
