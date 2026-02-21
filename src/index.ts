#!/usr/bin/env node
/**
 * claude-app-server — entry point
 *
 * Wraps your locally installed `claude` CLI. No API key required.
 * Authentication is handled by Claude Code itself (run `claude auth` to log in).
 *
 * Usage:
 *   claude-app-server                        # stdio (default)
 *   claude-app-server --transport ws         # WebSocket on port 3284
 *   claude-app-server --transport ws --port 4000
 */

import { ClaudeAppServer } from "./server.js";
import { startStdio, startWebSocket } from "./transport.js";
import { execSync } from "child_process";

function parseArgs(argv: string[]): {
  transport: "stdio" | "ws";
  port: number;
} {
  const args = argv.slice(2);
  let transport: "stdio" | "ws" = "stdio";
  let port = 3284;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1]) {
      const t = args[++i];
      if (t === "ws" || t === "websocket") transport = "ws";
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }

  return { transport, port };
}

function checkClaude(): void {
  try {
    execSync("claude --version", { stdio: "pipe" });
  } catch {
    process.stderr.write(
      "[claude-app-server] ERROR: `claude` CLI not found.\n" +
        "Install Claude Code: https://claude.ai/code\n" +
        "Then log in: claude auth\n",
    );
    process.exit(1);
  }
}

function main() {
  checkClaude();

  const { transport, port } = parseArgs(process.argv);
  const server = new ClaudeAppServer();

  if (transport === "ws") {
    startWebSocket(server, port);
  } else {
    startStdio(server);
  }
}

main();
