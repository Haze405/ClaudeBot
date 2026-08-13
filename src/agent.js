import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const MAX_TOKENS = 16000;
const MAX_TURNS = 100;

/**
 * Runs the tool-use loop: Claude picks Minecraft tools, we execute them against
 * the MCP server, feed the results back, and repeat until Claude stops calling tools.
 */
export class MinecraftAgent {
  constructor(mcp) {
    this.mcp = mcp;
    this.messages = [];
    this.client = null;
    this.clientKey = null;
  }

  get anthropic() {
    // Rebuilt whenever the key, base URL, or workspace ID changes in settings.
    if (!this.client || this.clientKey !== config.apiKey || this.clientBaseUrl !== config.baseUrl || this.clientWorkspaceId !== config.workspaceId) {
      const defaultHeaders = config.workspaceId ? { 'anthropic-workspace-id': config.workspaceId } : undefined;
      this.client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || undefined,
        defaultHeaders,
      });
      this.clientKey = config.apiKey;
      this.clientBaseUrl = config.baseUrl;
      this.clientWorkspaceId = config.workspaceId;
    }
    return this.client;
  }

  reset() {
    this.messages = [];
  }

  systemPrompt() {
    const { username } = config;
    return [
      `You control a Minecraft character named ${username} through the Mineflayer tools available to you.`,
      "",
      "The tools are your only senses — you cannot see the world except through their results.",
      "Check your position, inventory, or nearby blocks when the answer depends on them.",
      "Builds and journeys take many tool calls: keep going until the task is finished rather than",
      "reporting a plan back. If a tool fails, read the error and try a different approach.",
      "Reply to the person briefly — what you did and what the world looks like now.",
      "",
      "The person may attach a reference image. You can see those directly, but you still cannot",
      "see the world you are building in, so read the image for what to build — shape, proportions,",
      "colors to match with blocks — and use tools to check what is actually there.",
      "An attached image stays visible for the rest of the conversation, so refer back to it as you build.",
    ].join("\n");
  }

  /**
   * Yields UI events as the turn progresses.
   * `images` are `{ mediaType, data }` with base64 data, already validated.
   */
  async *run(userMessage, { images = [], maxTurns = MAX_TURNS } = {}) {
    // Images go before the text — Claude reads a prompt better when the image
    // it refers to is already in view.
    const content = [
      ...images.map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      })),
      { type: "text", text: userMessage },
    ];

    this.messages.push({ role: "user", content });
    const tools = this.mcp.anthropicTools();

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.anthropic.messages.create({
        model: config.model,
        max_tokens: MAX_TOKENS,
        system: this.systemPrompt(),
        output_config: { effort: "medium" },
        tools,
        messages: this.messages,
      });

      // Echo the full content back, including thinking blocks, so the next turn
      // sees an unmodified assistant message.
      this.messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          yield { type: "text", text: block.text };
        }
      }

      if (response.stop_reason === "refusal") {
        yield { type: "error", text: "Claude declined this request." };
        return;
      }
      if (response.stop_reason !== "tool_use") {
        yield { type: "done" };
        return;
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      // Run sequentially — order matters when the bot is moving and placing blocks.
      for (const toolUse of toolUses) {
        yield { type: "tool", name: toolUse.name, input: toolUse.input };

        let outcome;
        try {
          outcome = await this.mcp.call(toolUse.name, toolUse.input);
        } catch (err) {
          outcome = { text: `Tool call failed: ${err.message}`, isError: true };
        }

        yield {
          type: "tool_result",
          name: toolUse.name,
          text: outcome.text,
          isError: outcome.isError,
        };
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: outcome.text,
          is_error: outcome.isError,
        });
      }

      this.messages.push({ role: "user", content: toolResults });
    }

    yield {
      type: "error",
      text: `Stopped after ${maxTurns} turns. Send another message to continue.`,
    };
  }
}
