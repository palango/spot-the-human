import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ClaudeBrain, checkAgent } from "./agents.js";
import { PromptPool } from "./prompts.js";
import { startServer } from "./server.js";

const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
if (!publicUrl) {
  console.error("PUBLIC_URL is required: the URL phones open, e.g. PUBLIC_URL=https://xyz.trycloudflare.com npm start");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be a port number, got ${process.env.PORT}`);
  process.exit(1);
}
const hostKey = process.env.HOST_KEY || randomUUID();

const AGENT_CHECK_BUDGET_MS = 15_000;

const pool = PromptPool.fromFile(fileURLToPath(new URL("../prompts.txt", import.meta.url)));
const brain = new ClaudeBrain();
// A missing or bad key only shows up on the first call; without this check every agent would answer "…" and
// the first reveal would expose the humans. Simulation runs without a key set SKIP_AGENT_CHECK=1.
if (process.env.SKIP_AGENT_CHECK === "1") {
  console.log("Agent check skipped (SKIP_AGENT_CHECK=1)");
} else {
  const check = await checkAgent(brain, AGENT_CHECK_BUDGET_MS);
  if (!check.ok) {
    console.error(
      `Agent check failed: a test answer came back empty after ${check.ms} ms (see the error above). Check ANTHROPIC_API_KEY / network`,
    );
    process.exit(1);
  }
  console.log(`Agent check ok (${check.ms} ms)`);
}
const server = await startServer({ port, hostKey, publicUrl, brain, pool }).catch((err: Error) => {
  console.error(`Could not start the server on port ${port}: ${err.message}`);
  process.exit(1);
});

console.log(`Listening on port ${server.port}`);
console.log(`Phones: ${publicUrl}`);
// The only place the host key is ever printed. A localhost URL keeps the key off the tunnel: open it on the laptop.
console.log(`Screen (host): http://localhost:${server.port}/screen?host=${encodeURIComponent(hostKey)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close().then(() => process.exit(0));
  });
}
