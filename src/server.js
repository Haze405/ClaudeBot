import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import { config, publicConfig, updateConfig, clearApiKey } from "./config.js";
import { MinecraftMcp } from "./mcp.js";
import { MinecraftAgent } from "./agent.js";
import { JobQueue } from "./jobs.js";
import { createApiRouter } from "./api.js";
import { startLocalRunner } from "./runner.js";
import { Lock } from "./lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mcp = new MinecraftMcp(config);
const agent = new MinecraftAgent(mcp);

/**
 * "local"  — this machine owns the bot and runs instructions itself.
 * "relay"  — this machine only takes requests; a worker elsewhere (the
 *            computer with Minecraft open) pulls them and does the work.
 */
// `npm run relay` passes --relay; RELAY_ONLY=1 does the same for hosts that
// only let you set environment variables.
const MODE =
  process.env.RELAY_ONLY === "1" || process.argv.includes("--relay") ? "relay" : "local";
const queue = new JobQueue();
const lock = new Lock();

const app = express();
// Images arrive base64-encoded inside the chat JSON body, well past the 100kb default.
app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image cap.
const MAX_IMAGES = 4;

/**
 * Identifies an image from its magic bytes. The browser reports `file.type`
 * from the file extension on Windows, so a HEIC or AVIF renamed ".jpg" claims
 * to be image/jpeg and the API rejects it as a format mismatch. The bytes are
 * the only trustworthy source.
 *
 * Returns a supported media type, or a human-readable name for a format we
 * recognise but cannot send, or null if it isn't an image at all.
 */
function sniffImageType(head) {
  const ascii = (start, end) => head.subarray(start, end).toString("latin1");

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";

  // ISO-BMFF container: the brand at offset 8 says which flavour.
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand.startsWith("hei") || brand.startsWith("mif")) return { unsupported: "HEIC/HEIF" };
    if (brand.startsWith("avi")) return { unsupported: "AVIF" };
  }
  if (ascii(0, 2) === "BM") return { unsupported: "BMP" };
  if (ascii(0, 2) === "II" || ascii(0, 2) === "MM") return { unsupported: "TIFF" };
  if (ascii(0, 5) === "<?xml" || ascii(0, 4) === "<svg") return { unsupported: "SVG" };
  if (head[0] === 0x00 && head[1] === 0x00 && (head[2] === 0x01 || head[2] === 0x02)) {
    return { unsupported: "ICO/CUR" };
  }
  return null;
}

/** Throws on anything the Messages API would reject. */
function validateImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("images must be an array.");
  if (raw.length > MAX_IMAGES) {
    throw new Error(`At most ${MAX_IMAGES} images per message.`);
  }

  return raw.map((image, i) => {
    const name = String(image?.name ?? "").trim();
    const label = name || (raw.length > 1 ? `Image ${i + 1}` : "Image");
    // Some encoders wrap base64 in newlines; the API accepts none.
    const data = String(image?.data ?? "").replace(/\s+/g, "");

    if (!data) throw new Error(`${label}: missing image data.`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error(`${label}: image data is not valid base64.`);
    }
    // Decoded size, without allocating a buffer for the whole image.
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = (data.length / 4) * 3 - padding;
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`${label}: ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds the 5MB limit.`);
    }

    const sniffed = sniffImageType(Buffer.from(data.slice(0, 32), "base64"));
    if (sniffed === null) {
      throw new Error(`${label}: this doesn't look like an image file.`);
    }
    if (typeof sniffed === "object") {
      throw new Error(
        `${label}: that file is really ${sniffed.unsupported}, which Claude can't read` +
          (name.match(/\.(jpe?g|png|gif|webp)$/i) ? " despite its extension" : "") +
          ". Open it and re-save as PNG or JPEG.",
      );
    }

    const declared = String(image?.mediaType ?? "");
    if (declared && declared !== sniffed && IMAGE_TYPES.includes(declared)) {
      console.log(`${label}: browser said ${declared}, bytes say ${sniffed} — using ${sniffed}.`);
    }
    // Trust the bytes, not the extension.
    return { mediaType: sniffed, data };
  });
}

// In local mode this process carries out the instructions itself. In relay
// mode nothing drains the queue here — a remote worker does it over HTTP.
if (MODE === "local") startLocalRunner({ queue, agent, mcp, lock });

app.use(
  "/api",
  createApiRouter({
    queue,
    validateImages,
    describeRuntime: () => ({ mode: MODE, connected: mcp.connected }),
  }),
);

app.get("/api/status", (req, res) => {
  const stats = queue.stats();
  res.json({
    connected: mcp.connected,
    tools: mcp.tools.map((t) => t.name),
    busy: lock.busy || stats.running > 0,
    mode: MODE,
    queued: stats.queued,
    running: stats.running,
    workers: stats.workers,
    ...publicConfig(),
  });
});

app.post("/api/settings", async (req, res) => {
  if (lock.busy) {
    return res.status(409).json({ error: "Wait for the current message to finish." });
  }

  let mcChanged;
  try {
    mcChanged = updateConfig(req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // A new host/port/username only takes effect on a fresh bot connection.
  let disconnected = false;
  if (mcChanged && mcp.connected) {
    await mcp.disconnect();
    agent.reset();
    disconnected = true;
  }

  res.json({ ...publicConfig(), disconnected });
});

app.post("/api/forget-key", (req, res) => {
  clearApiKey();
  res.json(publicConfig());
});

app.post("/api/connect", async (req, res) => {
  if (MODE === "relay") {
    return res.status(409).json({
      error: "This server is a relay. Connect the bot from the worker on the Minecraft machine.",
    });
  }
  try {
    const tools = await mcp.connect();
    res.json({ connected: true, tools: tools.map((t) => t.name) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/disconnect", async (req, res) => {
  await mcp.disconnect();
  agent.reset();
  res.json({ connected: false });
});

// Queued rather than applied on the spot: wiping the conversation out from
// under a build in progress would leave the agent with no idea what it was doing.
app.post("/api/reset", (req, res) => {
  const job = queue.enqueue({ control: "reset", source: "ui" });
  res.json({ ok: true, id: job.id });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  let images;
  try {
    images = validateImages(req.body?.images);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Fail early with something the page can explain, rather than queueing a
  // message that is guaranteed to fail once it reaches the front.
  if (MODE === "local") {
    if (!mcp.connected) {
      return res.status(409).json({ error: "Not connected to the Minecraft MCP server." });
    }
    if (!config.apiKey) {
      return res.status(400).json({ error: "Save a Claude API key in Settings first." });
    }
  } else if (queue.activeWorkers().length === 0) {
    return res.status(409).json({
      error: "No Minecraft worker is attached. Start the worker on the computer running Minecraft.",
    });
  }

  let job;
  try {
    job = queue.enqueue({ message, images, source: "ui" });
  } catch (err) {
    return res.status(429).json({ error: err.message });
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  const send = (event) => res.write(JSON.stringify(event) + "\n");

  try {
    for await (const event of queue.stream(job.id)) {
      send(event);
    }
  } catch (err) {
    send({ type: "error", text: err.message });
  } finally {
    res.end();
  }
});

// Body-parser rejections (oversized uploads, malformed JSON) would otherwise
// come back as an HTML page the browser code can't read.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooLarge = err.type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({
    error: tooLarge ? "That image is too large to upload." : `Bad request: ${err.message}`,
  });
});

const port = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

app.listen(port, BIND_HOST, () => {
  console.log(`Minecraft Claude agent running at http://${BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST}:${port}`);
  console.log(`Mode: ${MODE}${MODE === "relay" ? " (waiting for a worker to attach)" : " (this machine runs the bot)"}`);
  console.log(`Script API: POST http://${BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST}:${port}/api/v1/instructions`);

  if (process.env.API_TOKENS || process.env.API_TOKEN) {
    console.log("Script API auth: enabled (send 'Authorization: Bearer <token>').");
  } else {
    console.log("Script API auth: not set — only this machine can submit instructions. Set API_TOKENS to open it up.");
  }
  if (MODE === "relay" && !(process.env.WORKER_TOKEN || process.env.WORKER_TOKENS)) {
    console.log("Warning: relay mode without WORKER_TOKEN — a remote worker will not be able to attach.");
  }

  if (MODE === "local") console.log(`Bot target: ${config.host}:${config.port} as "${config.username}"`);
  if (!config.apiKey && MODE === "local") {
    console.log("No API key saved yet. Add one in the Settings panel on the page (host-only).");
  }
  if (BIND_HOST !== "127.0.0.1") {
    console.log("Warning: reachable from other machines, and every endpoint is open — anyone who");
    console.log("can reach this URL can drive the bot and spend your Claude credits.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await mcp.disconnect();
    process.exit(0);
  });
}
