--[[
  Example: driving the Minecraft Claude agent from Lua.
  Run with:  lua example.lua
  (or paste into whatever Lua environment you're using — see lua/README.md)
--]]

local ClaudeMC = require("claude_mc")

local claude = ClaudeMC.new({
  -- The machine running the server. Use its LAN address, not localhost,
  -- when the Lua script runs on a different computer.
  url = "http://127.0.0.1:3000",

  -- Only needed when the server was started with API_TOKENS set.
  token = "change-me",

  -- Print each tool call as it happens, so the script shows progress.
  onEvent = function(event)
    if event.type == "tool" then
      print("  ..." .. event.name)
    elseif event.type == "text" then
      print("  claude: " .. event.text)
    end
  end,
})

-- 1. Is the bot there? -------------------------------------------------------
local health, err = claude:health()
if not health then
  error("cannot reach the agent: " .. tostring(err))
end
if not health.ready then
  error("the agent is up but no Minecraft bot is connected yet")
end
print("agent ready (mode: " .. health.mode .. ")")

-- 2. Send one instruction and wait for it ------------------------------------
local reply, err2 = claude:send("build a 5x5 platform of dirt above me")
if not reply then
  error("instruction failed: " .. tostring(err2))
end
print("done: " .. reply)

-- 3. Fire several instructions in order --------------------------------------
local plan = {
  "gather 20 oak logs",
  "craft a crafting table and place it down",
  "build a small shelter with a door",
}

for i, instruction in ipairs(plan) do
  print(string.format("[%d/%d] %s", i, #plan, instruction))
  local result, failure = claude:send(instruction)
  if not result then
    print("  stopped: " .. tostring(failure))
    break
  end
  print("  " .. result)
end

-- 4. Queue work without blocking ---------------------------------------------
-- Useful when your script has other things to do while Minecraft catches up.
local id = claude:submit("dig straight down to y=12 and light the area")
print("queued as " .. id)

-- ...do other work here...

local job = claude:wait(id)
if job then print("finished: " .. job.reply) end

-- 5. Start over --------------------------------------------------------------
-- Claude remembers earlier instructions in the conversation. Reset when you
-- want a clean slate.
claude:reset()
