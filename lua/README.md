# Driving the agent from Lua

`claude_mc.lua` sends instructions to the Minecraft agent. It has no
dependencies — it finds an HTTP client and a JSON codec from whatever Lua
environment it is running in.

## Setup

1. Copy `claude_mc.lua` next to your script (or anywhere on your `package.path`).
2. Make sure the agent is running and a bot is connected — `GET /api/v1/health`
   should report `"ready": true`.
3. Point the client at the server:

```lua
local ClaudeMC = require("claude_mc")

local claude = ClaudeMC.new({
  url   = "http://192.168.1.50:3000",  -- where the server is
  token = "your-api-token",            -- only if API_TOKENS is set
})

local reply = claude:send("build a 5x5 dirt platform above me")
print(reply)
```

`send` blocks until the build is finished and returns what Claude said. That is
the whole thing for most scripts.

## The full interface

```lua
ClaudeMC.new({
  url     = "http://localhost:3000",
  token   = nil,   -- API token, when the server requires one
  timeout = 600,   -- seconds to wait for an instruction (default 10 minutes)
  poll    = 2,     -- seconds between status checks while waiting
  onEvent = nil,   -- function(event) called for each tool call and reply
})
```

| Call                          | Does                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `claude:send(text[, opts])`   | Sends and waits. Returns `reply, job` or `nil, err`.        |
| `claude:submit(text[, opts])` | Queues without waiting. Returns `id, job` or `nil, err`.    |
| `claude:wait(id[, timeout])`  | Waits for a queued instruction. Returns `job` or `nil, err`. |
| `claude:status(id)`           | Current state, without waiting.                             |
| `claude:cancel(id)`           | Asks a running instruction to stop.                         |
| `claude:reset()`              | Makes Claude forget the conversation so far.                |
| `claude:health()`             | Server and bot status.                                      |

`opts` accepts `reset = true`, `maxTurns = 50`, and `timeout = 300`.

**Every call returns `nil, errorMessage` on failure rather than raising**, so
wrap them the way you prefer:

```lua
local reply, err = claude:send("mine 30 cobblestone")
if not reply then
  print("failed: " .. err)
  return
end
```

Or let it raise, with `assert`:

```lua
local reply = assert(claude:send("mine 30 cobblestone"))
```

## Watching progress

Builds take a while. `onEvent` fires as things happen:

```lua
local claude = ClaudeMC.new({
  url = "http://localhost:3000",
  onEvent = function(event)
    if event.type == "tool" then
      print("  ..." .. event.name)
    elseif event.type == "text" then
      print("  claude: " .. event.text)
    end
  end,
})
```

## Running several instructions

Claude remembers the conversation, so later instructions can refer to earlier
ones:

```lua
claude:send("build a stone tower 20 blocks tall")
claude:send("put a torch on top of it")        -- "it" still means the tower
claude:send("now build a second one next to it")
```

Call `claude:reset()` when you want a clean slate.

Instructions are carried out **one at a time in the order they arrive**, even
when several scripts submit at once — there is only one bot. If your script
should not block, `submit` and check back later:

```lua
local id = claude:submit("dig down to y=12 and light the area")
-- ...do other work...
local job = claude:wait(id)
```

---

## Environment notes

### Roblox

Works both in-game (`HttpService`) and under executors that provide a
`request` global. In-game requires **Game Settings → Security → Allow HTTP
Requests**.

**Roblox cannot reach `localhost` or LAN addresses like `192.168.x.x`.** The
agent has to be on a public URL — see the tunnel option in the main README.

```lua
local claude = ClaudeMC.new({
  url   = "https://your-server.example.com",
  token = "your-api-token",
})
```

Call it from a coroutine or a server script so waiting does not stall anything
else.

### ComputerCraft / CC:Tweaked

Uses `http.post`. Enable HTTP in the mod config, and add your server to the
whitelist if it has one. In-game `os.time()` is the world clock rather than
real time, which the library already handles.

```lua
local claude = ClaudeMC.new({ url = "http://192.168.1.50:3000" })
print(claude:send("come to my base"))
```

### Standard Lua (5.1–5.4, LuaJIT)

Needs [luasocket](https://lunarmodules.github.io/luasocket/) for `http://`, and
luasec as well for `https://`:

```
luarocks install luasocket
luarocks install luasec
```

`cjson` or `dkjson` will be used if installed; otherwise the bundled JSON
encoder handles it.

### Something else

If your Lua has none of the above, provide a global `request` before requiring
the library and it will be used:

```lua
function request(opts)
  -- opts.Url, opts.Method, opts.Headers, opts.Body
  return { StatusCode = 200, Body = "..." }
end
```

## Troubleshooting

| Symptom                                    | Cause                                                   |
| ------------------------------------------ | ------------------------------------------------------- |
| `no HTTP client available`                 | None of the backends above were found — provide `request`. |
| `Unauthorized: missing or invalid API token` | `token` is wrong or missing.                          |
| `Forbidden: set API_TOKENS...`             | Server has no tokens set, so it only accepts local calls. |
| Instruction sits at `queued` forever       | No bot attached. Check `claude:health().ready`.          |
| `timed out waiting`                        | Build ran past `timeout`. Raise it, or use `submit`.     |
