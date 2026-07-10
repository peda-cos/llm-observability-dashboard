import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "ingress"], { stdio: "inherit" }),
  spawn("npm", ["run", "dashboard"], { stdio: "inherit" }),
];
let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

for (const child of children) {
  child.on("exit", (code) => {
    shutdown();
    process.exitCode = code ?? 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
