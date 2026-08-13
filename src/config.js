import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "..", "config.local.json");
const TMP_CONFIG_FILE = path.join(os.tmpdir(), "minecraftmcp-config.local.json");

// Environment variables act as initial defaults; anything saved from the
// settings panel wins and is persisted to config.local.json.
const DEFAULTS = {
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.AWS_CLAUDE_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || "claude-opus-5",
  baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL || "",
  workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || process.env.AWS_CLAUDE_WORKSPACE_ID || "",
  host: process.env.MC_HOST || "localhost",
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || "ClaudeBot",
};

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    // If the repo lives on a read-only filesystem (serverless platforms)
    // fall back to a temp-file which is writable for the process lifetime.
    try {
      return JSON.parse(fs.readFileSync(TMP_CONFIG_FILE, "utf8"));
    } catch {
      return {};
    }
  }
}

/** Live singleton — mcp.js and agent.js read straight off it. */
export const config = { ...DEFAULTS, ...readSaved() };

/** What the browser is allowed to see. Never includes the API key itself. */
export function publicConfig() {
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    host: config.host,
    port: config.port,
    username: config.username,
    apiKeySet: Boolean(config.apiKey),
  };
}

const MC_FIELDS = ["host", "port", "username"];

/**
 * Applies a settings patch. Blank fields are left untouched, so the UI can
 * submit an empty API key box to mean "keep the key I already saved".
 * Returns true when a field that affects the bot connection changed.
 */
export function updateConfig(patch) {
  const next = {};

  for (const field of ["apiKey", "model", "baseUrl", "workspaceId", "host", "username"]) {
    const value = patch[field];
    if (typeof value === "string" && value.trim()) next[field] = value.trim();
  }

  if (patch.port !== undefined && patch.port !== "") {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be a whole number between 1 and 65535.");
    }
    next.port = port;
  }

  const mcChanged = MC_FIELDS.some((f) => f in next && next[f] !== config[f]);
  Object.assign(config, next);
  save();
  return mcChanged;
}

export function clearApiKey() {
  config.apiKey = "";
  save();
}

function save() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    // EROFS: read-only filesystem (e.g., serverless). Fall back to tmp dir
    // and keep running; warn so operators know the setting won't persist
    // across restarts.
    try {
      fs.writeFileSync(TMP_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
      console.warn(
        `Warning: could not write ${CONFIG_FILE} (${err.code}). Using ${TMP_CONFIG_FILE} for this run only.`,
      );
    } catch (err2) {
      console.warn(`Warning: failed to persist settings: ${err.message}; ${err2.message}`);
    }
  }
}
