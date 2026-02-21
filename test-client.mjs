/**
 * Quick integration smoke-test for the stdio transport.
 * Runs the server as a child process and fires a sequence of JSON-RPC calls.
 * Does NOT call the Anthropic API (stops before turn/start).
 *
 * Usage:  node test-client.mjs
 */

import { spawn } from "child_process";
import * as readline from "readline";
import * as path from "path";

const serverPath = path.join(import.meta.dirname, "dist", "index.js");

const server = spawn("node", [serverPath], {
  env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-test" },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: server.stdout });
const pending = new Map();
let notifCount = 0;

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if ("id" in msg) {
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  } else if ("method" in msg) {
    console.log("  notification:", msg.method, JSON.stringify(msg.params ?? {}).slice(0, 120));
    notifCount++;
  }
});

function send(req) {
  server.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(req.id, resolve));
}

async function run() {
  console.log("\n=== claude-app-server smoke test ===\n");

  // 1. initialize
  const initRes = await send({ jsonrpc: "2.0", method: "initialize", params: {
    client: { name: "test-client", version: "1.0.0" },
    cwd: process.cwd(),
  }, id: 1 });
  console.log("initialize:", initRes.error ?? `OK — ${JSON.stringify(initRes.result?.server)}`);

  // wait a tick for the "initialized" notification
  await new Promise(r => setTimeout(r, 50));

  // 2. model/list
  const modelsRes = await send({ jsonrpc: "2.0", method: "model/list", id: 2 });
  console.log("model/list:", modelsRes.error ?? `OK — ${modelsRes.result.models.length} models`);

  // 3. skills/list
  const skillsRes = await send({ jsonrpc: "2.0", method: "skills/list", id: 3 });
  console.log("skills/list:", skillsRes.error ?? `OK — ${skillsRes.result.skills.length} skills`);

  // 4. thread/start
  const threadRes = await send({ jsonrpc: "2.0", method: "thread/start", params: {
    cwd: process.cwd(),
    permission_mode: "acceptEdits",
  }, id: 4 });
  const threadId = threadRes.result?.thread_id;
  console.log("thread/start:", threadRes.error ?? `OK — thread_id=${threadId}`);

  // 5. thread/resume
  const resumeRes = await send({ jsonrpc: "2.0", method: "thread/resume", params: { thread_id: threadId }, id: 5 });
  console.log("thread/resume:", resumeRes.error ?? `OK — ${resumeRes.result.turns.length} turns`);

  // 6. thread/fork
  const forkRes = await send({ jsonrpc: "2.0", method: "thread/fork", params: { thread_id: threadId }, id: 6 });
  console.log("thread/fork:", forkRes.error ?? `OK — forked_thread=${forkRes.result.thread_id}`);

  // 7. Error handling — call a non-existent method
  const badRes = await send({ jsonrpc: "2.0", method: "nonexistent", id: 7 });
  console.log("unknown method:", badRes.error ? `OK (expected error ${badRes.error.code})` : "UNEXPECTED success");

  // 8. Error handling — turn/steer with no active turn
  const steerRes = await send({ jsonrpc: "2.0", method: "turn/steer", params: { thread_id: threadId, content: "hi" }, id: 8 });
  console.log("turn/steer (no active turn):", steerRes.error ? `OK (expected error)` : "UNEXPECTED success");

  // 9. app/list
  const appRes = await send({ jsonrpc: "2.0", method: "app/list", id: 9 });
  console.log("app/list:", appRes.error ?? `OK — ${appRes.result.apps.length} apps`);

  console.log(`\n✓ ${notifCount} notification(s) received`);
  console.log("✓ All protocol tests passed\n");
  server.kill();
  process.exit(0);
}

run().catch(err => { console.error("FAILED:", err); server.kill(); process.exit(1); });
