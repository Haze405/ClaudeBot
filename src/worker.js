import os from "node:os";
import "dotenv/config";
import { config } from "./config.js";
import { MinecraftMcp } from "./mcp.js";
import { MinecraftAgent } from "./agent.js";
import { runInstruction } from "./runner.js";

/**
 * The Minecraft side of a two-machine setup.
 *
 * This process runs on the computer where Minecraft is open. It dials *out* to
 * the relay server and long-polls for instructions, so the Minecraft machine
 * needs no port forwarding, no public address, and no inbound firewall holes —
 * which is what makes this work from an ordinary home network.
 *
 *   relay (public)  <--- long-poll ---  worker (this machine)
 *                                          |
 *                                          +--> MCP subprocess --> Minecraft
 *
 * Run with: npm run worker
 */

const RELAY_URL = String(process.env.RELAY_URL || "").replace(/\/+$/, "");
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const WORKER_NAME = process.env.WORKER_NAME || `${os.hostname()}`;
const POLL_TIMEOUT_MS = 25_000;
const FLUSH_MS = 750;

if (!RELAY_URL) {
  console.error("RELAY_URL is not set. Point it at the relay server, e.g.");
  console.error('  RELAY_URL="https://your-server.example.com" WORKER_TOKEN="..." npm run worker');
  process.exit(1);
}

const mcp = new MinecraftMcp(config);
const agent = new MinecraftAgent(mcp);
let stopping = false;

function headers(extra = {}) {
  return {
    ...(WORKER_TOKEN ? { Authorization: `Bearer ${WORKER_TOKEN}` } : {}),
    ...extra,
  };
}

async function relay(path, { method = "GET", body, timeoutMs = 20_000 } = {}) {
  const res = await fetch(`${RELAY_URL}${path}`, {
    method,
    headers: headers(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Proxies and tunnels return HTML error pages; show a usable prefix.
    throw new Error(`${res.status} from ${path}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data?.error || `${res.status} from ${path}`);
  return data;
}

/**
 * Buffers progress events and ships them to the relay a few times a second.
 * One request per tool call would be a lot of chatter over a home uplink.
 */
class Progress {
  constructor(jobId) {
    this.jobId = jobId;
    this.buffer = [];
    this.cancelled = false;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  push(event) {
    this.buffer.push(event);
  }

  async flush() {
    if (this.sending || this.buffer.length === 0) return;
    this.sending = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const result = await relay("/api/worker/events", {
        method: "POST",
        body: { jobId: this.jobId, events: batch },
      });
      if (result?.cancelRequested) this.cancelled = true;
    } catch (err) {
      // Losing a progress update is survivable; the final result still reports
      // the outcome. Put the events back so nothing is silently dropped.
      this.buffer.unshift(...batch);
      console.warn(`  progress upload failed (${err.message}); retrying`);
    } finally {
      this.sending = false;
    }
  }

  async done() {
    clearInterval(this.timer);
    await this.flush();
    return this.buffer.splice(0, this.buffer.length);
  }
}

async function handle(job) {
  const label = job.control === "reset" ? "(reset conversation)" : job.message;
  console.log(`\n> ${label}`);

  const progress = new Progress(job.id);
  let error = null;

  try {
    ({ error } = await runInstruction({
      job,
      agent,
      mcp,
      onEvent: (event) => {
        progress.push(event);
        if (event.type === "tool") console.log(`  -> ${event.name}`);
      },
      shouldCancel: () => progress.cancelled,
    }));
  } catch (err) {
    error = err.message;
  }

  const leftover = await progress.done();
  try {
    await relay("/api/worker/result", {
      method: "POST",
      body: { jobId: job.id, error, events: leftover },
    });
  } catch (err) {
    // The relay's lease sweeper will fail the job on its own.
    console.error(`  could not report the result: ${err.message}`);
  }

  console.log(error ? `  failed: ${error}` : "  done");
}

async function connectBot() {
  console.log(`Connecting the bot to ${config.host}:${config.port} as "${config.username}"...`);
  console.log("(first run downloads the MCP server with npx — this can take a minute)");
  await mcp.connect();
  console.log(`Bot connected. ${mcp.tools.length} Minecraft tools available.`);
}

async function main() {
  console.log(`Worker "${WORKER_NAME}" -> ${RELAY_URL}`);
  if (!WORKER_TOKEN) console.log("No WORKER_TOKEN set — this only works if the relay is on this machine.");
  if (!config.apiKey) {
    console.error("No Claude API key. Set ANTHROPIC_API_KEY before starting the worker.");
    process.exit(1);
  }

  try {
    await connectBot();
  } catch (err) {
    console.error(`Could not connect the bot: ${err.message}`);
    console.error("Open your world to LAN and check MC_HOST / MC_PORT, then start the worker again.");
    process.exit(1);
  }

  let backoff = 1_000;
  while (!stopping) {
    try {
      const job = await relay(
        `/api/worker/next?worker=${encodeURIComponent(WORKER_NAME)}&timeoutMs=${POLL_TIMEOUT_MS}`,
        { timeoutMs: POLL_TIMEOUT_MS + 10_000 },
      );
      backoff = 1_000;
      if (job) await handle(job);
    } catch (err) {
      if (stopping) break;
      // Timeouts are the long-poll doing its job; anything else is worth saying.
      const expected = err.name === "TimeoutError" || /aborted/i.test(err.message);
      if (!expected) {
        console.warn(`Relay unreachable (${err.message}); retrying in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    stopping = true;
    console.log("\nShutting the worker down...");
    await mcp.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
