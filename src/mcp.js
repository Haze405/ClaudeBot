import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// npx resolves to npx.cmd on Windows; spawning bare "npx" there fails with ENOENT.
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const MCP_PACKAGE = "github:yuniko-software/minecraft-mcp-server";
const CONNECT_TIMEOUT_MS = 120_000;

/**
 * Owns the stdio connection to the Minecraft MCP server. The MCP server is
 * spawned as a child process and joins the Minecraft world as a bot, so
 * connecting only succeeds once the world is open to LAN on the configured port.
 */
export class MinecraftMcp {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.tools = [];
  }

  get connected() {
    return this.client !== null;
  }

  async connect() {
    if (this.client) return this.tools;

    const { host, port, username } = this.config;
    const transport = new StdioClientTransport({
      command: NPX,
      args: [
        "-y",
        MCP_PACKAGE,
        "--host",
        host,
        "--port",
        String(port),
        "--username",
        username,
      ],
      // Mineflayer's connection errors go to stderr — surface them in our terminal.
      stderr: "inherit",
    });

    const client = new Client(
      { name: "minecraft-claude-agent", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `The MCP server did not respond within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          `Check that Minecraft is open to LAN on ${host}:${port}.`,
      );
      const { tools } = await client.listTools();
      this.client = client;
      this.tools = tools;
      return tools;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  async disconnect() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.tools = [];
    await client.close().catch(() => {});
  }

  /** MCP tool definitions in the shape the Messages API expects. */
  anthropicTools() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema,
    }));
  }

  async call(name, args) {
    if (!this.client) throw new Error("Not connected to the Minecraft MCP server.");
    const result = await this.client.callTool({ name, arguments: args ?? {} });
    const text =
      (result.content ?? [])
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n")
        .trim() || "(no output)";
    return { text, isError: Boolean(result.isError) };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
