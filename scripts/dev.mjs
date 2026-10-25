// Runs the API (with embedded worker) and the Vite dev server together.
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  ["server", ["run", "dev", "-w", "@automation-studio/server"]],
  ["web", ["run", "dev", "-w", "@automation-studio/web"]],
].map(([name, args]) => {
  const p = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const prefix = (line) => `[${name}] ${line}`;
  for (const stream of [p.stdout, p.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) (stream === p.stderr ? process.stderr : process.stdout).write(`${prefix(l)}\n`);
    });
  }
  p.on("exit", (code) => {
    console.log(prefix(`exited with code ${code}`));
    shutdown();
  });
  return p;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log("Web: http://localhost:5173  ·  API: http://localhost:8787");
