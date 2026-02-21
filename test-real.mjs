import { spawn } from "child_process";
import * as readline from "readline";

const server = spawn("node", ["dist/index.js"], { stdio: ["pipe","pipe","inherit"] });
const rl = readline.createInterface({ input: server.stdout });
let id = 0;
const send = (method, params) => {
  server.stdin.write(JSON.stringify({ jsonrpc:"2.0", id: ++id, method, params }) + "\n");
};

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  console.log("←", JSON.stringify(msg, null, 2));

  if (msg.id === 1) send("thread/start", { cwd: process.cwd() });
  if (msg.id === 2) send("turn/start", { thread_id: msg.result.thread_id, content: "List 3 fruits." });
  if (msg.method === "turn/completed") { server.kill(); process.exit(0); }
});

send("initialize", {});
