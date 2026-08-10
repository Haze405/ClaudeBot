import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import { config, publicConfig, updateConfig, clearApiKey } from "./config.js";
import { MinecraftMcp } from "./mcp.js";
import { MinecraftAgent } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mcp = new MinecraftMcp(config);
const agent = new MinecraftAgent(mcp);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// The agent keeps one shared conversation, so only one turn may run at a time.
let busy = false;

app.get("/api/status", (req, res) => {
  res.json({
    connected: mcp.connected,
    tools: mcp.tools.map((t) => t.name),
    busy,
    ...publicConfig(),
  });
});

app.post("/api/settings", async (req, res) => {
  if (busy) {
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

app.post("/api/reset", (req, res) => {
  agent.reset();
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }
  if (!mcp.connected) {
    return res.status(409).json({ error: "Not connected to the Minecraft MCP server." });
  }
  if (!config.apiKey) {
    return res.status(400).json({ error: "Save a Claude API key in Settings first." });
  }
  if (busy) {
    return res.status(409).json({ error: "The agent is still working on the previous message." });
  }

  busy = true;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  const send = (event) => res.write(JSON.stringify(event) + "\n");

  try {
    for await (const event of agent.run(message)) {
      send(event);
    }
  } catch (err) {
    send({ type: "error", text: err.message });
  } finally {
    busy = false;
    res.end();
  }
});

const port = Number(process.env.PORT || 3000);

// Bound to loopback on purpose: the settings endpoint accepts an API key.
app.listen(port, "127.0.0.1", () => {
  console.log(`Minecraft Claude agent running at http://localhost:${port}`);
  console.log(`Bot target: ${config.host}:${config.port} as "${config.username}"`);
  if (!config.apiKey) {
    console.log("No API key saved yet. Add one in the Settings panel on the page.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await mcp.disconnect();
    process.exit(0);
  });
}
