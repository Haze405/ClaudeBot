# Minecraft Claude Agent

A small web-hosted agent that controls a Minecraft character. The Node server
spawns [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server)
as an MCP subprocess, exposes its Mineflayer tools to Claude, and runs the
tool-use loop. The browser page is plain HTML with a few colors.

Everything is configured from the page itself — API key, model, and the
Minecraft host/port/bot name. There is no `.env` to edit.

```
browser ----+
            |
scripts ----+-->  instruction queue  -->  Claude Messages API
(HTTP API)        (src/jobs.js)                    |
                                                   v
                                    MCP stdio subprocess (npx ... minecraft-mcp-server)
                                                   |
                                                   +--> Mineflayer bot -> your Minecraft world
```

The queue can be drained by the same machine, or by a worker on a *different*
machine that has Minecraft open — see [Setup B](#setup-b--two-computers).

## Files

| Path                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `src/server.js`      | Express server, HTTP API, NDJSON streaming to the browser  |
| `src/config.js`      | Settings store, persisted to `config.local.json`           |
| `src/mcp.js`         | Spawns and talks to the Minecraft MCP server over stdio    |
| `src/agent.js`       | Claude tool-use loop (Opus 5, adaptive thinking)           |
| `src/jobs.js`        | The instruction queue everything runs through              |
| `src/api.js`         | The script-facing API and the worker endpoints             |
| `src/runner.js`      | Carries out one instruction; drains the queue locally      |
| `src/worker.js`      | Standalone worker for the two-computer setup               |
| `public/index.html`  | The page: settings panel, connect button, chat, event log  |
| `lua/claude_mc.lua`  | Lua client for the API — see [lua/README.md](lua/README.md) |
| `docs/API.md`        | Full API reference                                         |
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

## Sending instructions from a script

Anything that can make an HTTP request can drive the bot:

```bash
curl -X POST http://localhost:3000/api/v1/instructions \
  -H "Content-Type: application/json" \
  -d '{"message": "build a 5x5 dirt platform above me", "wait": true, "timeoutMs": 120000}'
```

From Lua:

```lua
local claude = require("claude_mc").new({ url = "http://localhost:3000" })
print(claude:send("build a 5x5 dirt platform above me"))
```

- **[docs/API.md](docs/API.md)** — the full API: queueing, polling, streaming
  progress, cancelling, images.
- **[lua/README.md](lua/README.md)** — the Lua client, including Roblox and
  ComputerCraft.

Instructions from scripts and from the web page go into the same queue and run
one at a time in order, sharing one conversation. There is one bot, so this is
the only thing that makes sense.

By default **only the server's own machine may submit instructions.** To let
other machines in, set `API_TOKENS` and have callers send
`Authorization: Bearer <token>`.

## Setup A — one computer

Minecraft, the server, and your script all on the same machine. Follow
[Running it](#running-it) above, then send requests to
`http://localhost:3000`. Nothing else to configure.

To let *other devices on your network* send instructions, restart the server so
it listens beyond loopback and requires a token:

```powershell
# PowerShell
$env:BIND_HOST="0.0.0.0"; $env:API_TOKENS="pick-a-long-random-string"; npm start
```

```bash
# bash
BIND_HOST=0.0.0.0 API_TOKENS="pick-a-long-random-string" npm start
```

Scripts then use your LAN address — `http://192.168.1.50:3000` — and send the
token. Find the address with `ipconfig`.

## Setup B — two computers

One machine takes API requests; a different machine runs Minecraft. This is the
setup to use when the script and the game are not in the same place.

The Minecraft machine **dials out** to the relay and asks for work, so it needs
no port forwarding, no public address, and no inbound firewall holes. That is
what makes this work from an ordinary home connection.

```
your script  --HTTPS-->  relay (public)  <--long-poll--  worker (Minecraft PC)
                                                              |
                                                              +--> Minecraft
```

### 1. The relay

On the public machine — a VPS, or any host that gives you a URL:

```bash
git clone <this repo> && cd minecraftmcp && npm install

RELAY_ONLY=1 \
BIND_HOST=0.0.0.0 \
PORT=3000 \
API_TOKENS="client-token-here" \
WORKER_TOKEN="worker-token-here" \
npm start
```

Or `npm run relay`, which sets `RELAY_ONLY` for you.

Use two different random strings. `API_TOKENS` is what your scripts send;
`WORKER_TOKEN` is what the Minecraft machine sends. Generate them with
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

The relay never sees your Claude API key and never touches Minecraft. It only
holds the queue.

> **Put HTTPS in front of it** if it is reachable from the internet — a reverse
> proxy like Caddy or nginx, or your host's built-in TLS. Tokens sent over
> plain HTTP travel in the clear.

> The queue is held in memory, so run **one** relay instance. Don't scale it to
> multiple replicas — requests would land on a relay the worker isn't attached to.

### 2. The worker

On the computer with Minecraft, with the world **open to LAN**:

```powershell
# PowerShell
$env:RELAY_URL="https://your-relay.example.com"
$env:WORKER_TOKEN="worker-token-here"
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:MC_PORT="54321"        # the port Minecraft printed in chat
npm run worker
```

```bash
# bash
RELAY_URL="https://your-relay.example.com" \
WORKER_TOKEN="worker-token-here" \
ANTHROPIC_API_KEY="sk-ant-..." \
MC_PORT=54321 \
npm run worker
```

It connects the bot, then waits for instructions:

```
Worker "gaming-pc" -> https://your-relay.example.com
Connecting the bot to localhost:54321 as "ClaudeBot"...
Bot connected. 14 Minecraft tools available.
```

The Claude API key lives here, on your machine — not on the relay.

`MC_PORT` changes every time you re-open the world to LAN, so expect to restart
the worker each session. `MC_HOST` and `MC_USERNAME` work the same way, and
values saved in `config.local.json` are used when the variables are unset.

### 3. Check it

```bash
curl https://your-relay.example.com/api/v1/health
```

`{"ready": true, "workers": 1}` means the worker is attached. Then:

```bash
curl -X POST https://your-relay.example.com/api/v1/instructions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer client-token-here" \
  -d '{"message": "say hello in chat", "wait": true}'
```

If `workers` is 0, the worker is not attached — check its terminal for a
`Relay unreachable` line, and confirm `WORKER_TOKEN` matches on both sides.

### No public machine? Use a tunnel

A tunnel gives your home machine a public URL, so you can run everything on the
Minecraft PC and skip the relay entirely:

```bash
# terminal 1
API_TOKENS="client-token-here" npm start

# terminal 2
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a URL your scripts can use. `ngrok http 3000` does the
same. This is also the answer for **Roblox**, which cannot reach `localhost` or
LAN addresses at all.

Anyone with the URL can reach the page and drive the bot — there is no
password. Shut the tunnel down when you're done.

## Reference images

Attach an image and Claude can see it while it builds — hand it a screenshot,
a sketch, or a photo and say `build this out of stone`.

Three ways to attach: the file picker next to the message box, **Ctrl+V** to
paste from the clipboard, or drag an image file onto the log. Thumbnails of
what's attached appear above the message box, each with an `x` to remove it.
They're sent when you hit Send.

- JPEG, PNG, GIF, and WebP, up to 5MB and 4 images per message.
- The real format is detected from the file's bytes, not its extension. Windows
  reports the type from the extension, so a HEIC or AVIF saved as `.jpg` would
  otherwise be rejected by the API with a confusing "format not supported"
  error; those now get a clear message telling you to re-save as PNG or JPEG.
- An attached image stays in the conversation, so follow-ups like
  `make the roof match the picture` still refer to it. **New conversation**
  clears it.
- Claude still can't see the Minecraft world itself — only the reference image
  and whatever the tools report back.

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

## Server environment variables

| Variable      | Purpose                                                              |
| ------------- | -------------------------------------------------------------------- |
| `API_TOKENS`  | Optional. Tokens required to submit instructions, comma-separated. **Unset means no authentication at all.** |
| `WORKER_TOKEN`| Optional. Token a remote worker uses to pull instructions.           |
| `RELAY_ONLY`  | `1` to run as a relay with no local bot. Same as `npm run relay`.    |
| `RELAY_URL`   | *(worker)* The relay to pull instructions from.                      |
| `WORKER_NAME` | *(worker)* A label for this machine. Defaults to its hostname.        |
| `BIND_HOST`   | Address to listen on. Default `127.0.0.1`.                           |
| `PORT`        | Default `3000`.                                                      |

## Notes

- The server binds to `127.0.0.1` by default, so it is not reachable from other
  machines until you set `BIND_HOST`. Once you do, it is fully open.

## Host / Prompter (cloud-friendly)

One person runs the Minecraft world and the server; anyone who can reach the
URL can send instructions from the web page or the API.

There is **no host password.** Every endpoint is open — connecting and
disconnecting the bot, changing settings, and sending instructions. Whoever has
the URL has all of it, and every instruction spends your Claude credits.

```bash
BIND_HOST=0.0.0.0 PORT=3000 node src/server.js
```

Set `API_TOKENS` if you later want to require a token on `/api/v1`.

The one thing that stays locked down is `baseUrl` — it cannot be changed over
HTTP, because it is where your API key gets sent. Change it with
`ANTHROPIC_BASE_URL` or by editing `config.local.json`.

- The agent keeps one conversation. **New conversation** clears it; the bot
  stays connected.
- Tool calls run sequentially, since movement and block placement are ordered.
- The loop stops after 100 tool turns per message. Send another message to
  continue a long build, or set `maxTurns` on an API instruction.
- Effort is set to `medium` in `src/agent.js`. Raise it to `high` for harder
  building tasks, drop to `low` for snappier replies.
