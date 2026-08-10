# Minecraft Claude Agent

A small web-hosted agent that controls a Minecraft character. The Node server
spawns [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)
as an MCP subprocess, exposes its Mineflayer tools to Claude, and runs the
tool-use loop. The browser page is plain HTML with a few colors.

Everything is configured from the page itself — API key, model, and the
Minecraft host/port/bot name. There is no `.env` to edit.

```
browser  ->  Express (src/server.js)  ->  Claude Messages API
                     |
                     +--> MCP stdio subprocess (npx ... minecraft-mcp-server)
                                  |
                                  +--> Mineflayer bot -> your Minecraft world
```

## Files

| Path                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `src/server.js`      | Express server, HTTP API, NDJSON streaming to the browser  |
| `src/config.js`      | Settings store, persisted to `config.local.json`           |
| `src/mcp.js`         | Spawns and talks to the Minecraft MCP server over stdio    |
| `src/agent.js`       | Claude tool-use loop (Opus 5, adaptive thinking)           |
| `public/index.html`  | The page: settings panel, connect button, chat, event log  |
| `config.local.json`  | Created on first save. Holds your API key. Gitignored.     |

## Running it

1. `npm install` (already done)
2. `npm start`, then open <http://localhost:3000>
3. Launch Minecraft **Java Edition** (the MCP server targets 1.21.x), enter a
   singleplayer world, and press `Esc -> Open to LAN -> Start LAN World`.
4. Minecraft prints the port it chose in chat: `Local game hosted on port 54321`.
   It is usually **not** 25565.
5. On the page, fill in the Settings panel — paste your Anthropic or AWS Claude API key, optionally set a Claude base URL, and enter that port number — then click **Save settings**.
6. Click **Connect bot**. The first connect runs `npx` to download the MCP
   server, which can take a minute. `ClaudeBot` spawns in your world.
7. Type an instruction, e.g. `Build a 5x5 dirt platform above me`.

## Settings

| Field        | Default         | Notes                                            |
| ------------ | --------------- | ------------------------------------------------ |
| API key      | —               | Stored in `config.local.json`, never sent back to the browser |
| Model        | `claude-opus-5` | Any current Claude model                         |
| Base URL     | —               | Optional custom Claude endpoint (AWS Claude, private proxy, etc.) |
| Workspace ID | —               | Optional AWS/Anthropic workspace header for endpoint auth |
| Host         | `localhost`     | Minecraft host                                   |
| Port         | `25565`         | The LAN port Minecraft printed                   |
| Bot name     | `ClaudeBot`     | Name in game                                     |

Saved settings take effect immediately. Changing host, port, or bot name
disconnects the bot so the next **Connect bot** uses the new values.
**Forget API key** clears the stored key.

`ANTHROPIC_API_KEY`, `AWS_CLAUDE_API_KEY`, `ANTHROPIC_MODEL`, `CLAUDE_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_BASE_URL`, `ANTHROPIC_WORKSPACE_ID`, `AWS_CLAUDE_WORKSPACE_ID`, `MC_HOST`, `MC_PORT`, `MC_USERNAME` and
`PORT` still work as environment variables if you'd rather not use the panel;
they act as the initial defaults, and anything saved in the UI overrides them.

## Notes

- The server binds to `127.0.0.1` only, since the settings endpoint accepts an
  API key. It is not reachable from other machines on your network.
- The agent keeps one conversation. **New conversation** clears it; the bot
  stays connected.
- Tool calls run sequentially, since movement and block placement are ordered.
- The loop stops after 25 tool turns per message. Send another message to
  continue a long build.
- Effort is set to `medium` in `src/agent.js`. Raise it to `high` for harder
  building tasks, drop to `low` for snappier replies.
