--[[
  claude_mc.lua — send instructions to the Minecraft Claude agent from Lua.

  Drop this file next to your script and:

      local claude = require("claude_mc").new({
        url   = "http://192.168.1.50:3000",
        token = "your-api-token",
      })

      claude:send("build a 5x5 dirt platform above me")

  It finds an HTTP client and a JSON codec on its own, so the same file works
  under Roblox, ComputerCraft, and plain Lua with luasocket. Nothing to install
  beyond whichever of those you already have.
--]]

local M = {}

-- ---------------------------------------------------------------- JSON

-- Uses the host's JSON codec when there is one; the pure-Lua fallback below
-- keeps the file dependency-free everywhere else.
local json = {}

do
  local ok, native = pcall(require, "cjson")
  if not ok then ok, native = pcall(require, "dkjson") end

  if ok and native and native.encode and native.decode then
    json.encode = native.encode
    json.decode = function(text) return native.decode(text) end
  elseif type(game) == "userdata" and game.GetService then
    local http = game:GetService("HttpService")
    json.encode = function(value) return http:JSONEncode(value) end
    json.decode = function(text) return http:JSONDecode(text) end
  elseif textutils and textutils.serialiseJSON then
    -- ComputerCraft
    json.encode = function(value) return textutils.serialiseJSON(value) end
    json.decode = function(text) return textutils.unserialiseJSON(text) end
  end
end

if not json.encode then
  local escapes = {
    ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b",
    ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
  }

  local function escape(text)
    return (text:gsub('[%c"\\]', function(c)
      return escapes[c] or string.format("\\u%04x", c:byte())
    end))
  end

  local function isArray(value)
    local count = 0
    for key in pairs(value) do
      if type(key) ~= "number" then return false end
      count = count + 1
    end
    return count == #value
  end

  local function encode(value)
    local kind = type(value)
    if value == nil then return "null" end
    if kind == "boolean" then return tostring(value) end
    if kind == "number" then return string.format("%.14g", value) end
    if kind == "string" then return '"' .. escape(value) .. '"' end
    if kind ~= "table" then error("cannot encode " .. kind) end

    local parts = {}
    if isArray(value) then
      for i = 1, #value do parts[#parts + 1] = encode(value[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, item in pairs(value) do
      parts[#parts + 1] = '"' .. escape(tostring(key)) .. '":' .. encode(item)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end

  json.encode = encode
end

if not json.decode then
  local decodeValue

  local function skip(text, pos)
    local _, stop = text:find("^[ \n\r\t]*", pos)
    return stop + 1
  end

  local unescapes = {
    ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b",
    f = "\f", n = "\n", r = "\r", t = "\t",
  }

  local function decodeString(text, pos)
    local out, i = {}, pos + 1
    while i <= #text do
      local char = text:sub(i, i)
      if char == '"' then return table.concat(out), i + 1 end
      if char == "\\" then
        local nextChar = text:sub(i + 1, i + 1)
        if nextChar == "u" then
          local code = tonumber(text:sub(i + 2, i + 5), 16) or 63
          -- Enough for the ASCII range the agent replies with; anything higher
          -- becomes "?" rather than failing the whole parse.
          out[#out + 1] = code < 128 and string.char(code) or "?"
          i = i + 6
        else
          out[#out + 1] = unescapes[nextChar] or nextChar
          i = i + 2
        end
      else
        out[#out + 1] = char
        i = i + 1
      end
    end
    error("unterminated string in JSON")
  end

  decodeValue = function(text, pos)
    pos = skip(text, pos)
    local char = text:sub(pos, pos)

    if char == "{" then
      local out = {}
      pos = skip(text, pos + 1)
      if text:sub(pos, pos) == "}" then return out, pos + 1 end
      while true do
        local key, item
        pos = skip(text, pos)
        key, pos = decodeString(text, pos)
        pos = skip(text, pos)
        pos = pos + 1 -- ':'
        item, pos = decodeValue(text, pos)
        out[key] = item
        pos = skip(text, pos)
        local sep = text:sub(pos, pos)
        pos = pos + 1
        if sep == "}" then return out, pos end
      end
    elseif char == "[" then
      local out = {}
      pos = skip(text, pos + 1)
      if text:sub(pos, pos) == "]" then return out, pos + 1 end
      while true do
        local item
        item, pos = decodeValue(text, pos)
        out[#out + 1] = item
        pos = skip(text, pos)
        local sep = text:sub(pos, pos)
        pos = pos + 1
        if sep == "]" then return out, pos end
      end
    elseif char == '"' then
      return decodeString(text, pos)
    elseif text:sub(pos, pos + 3) == "true" then
      return true, pos + 4
    elseif text:sub(pos, pos + 4) == "false" then
      return false, pos + 5
    elseif text:sub(pos, pos + 3) == "null" then
      return nil, pos + 4
    end

    local number = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
    if number then return tonumber(number), pos + #number end
    error("unexpected JSON at position " .. pos)
  end

  json.decode = function(text)
    local ok, value = pcall(function()
      return (decodeValue(text, 1))
    end)
    if not ok then return nil end
    return value
  end
end

M.json = json

-- ---------------------------------------------------------------- HTTP

--- Performs one request. Returns `status, bodyText` or `nil, errorMessage`.
local function httpRequest(method, url, body, headers)
  -- 1. Executor-style request functions (Roblox exploits, some sandboxes).
  local request = rawget(_G, "request")
    or rawget(_G, "http_request")
    or (rawget(_G, "syn") and syn.request)
    or (rawget(_G, "fluxus") and fluxus.request)

  if type(request) == "function" then
    local ok, res = pcall(request, {
      Url = url, Method = method, Headers = headers, Body = body,
    })
    if not ok then return nil, tostring(res) end
    return res.StatusCode or res.status_code, res.Body or res.body
  end

  -- 2. Roblox in-game HttpService. Requires HTTP requests to be enabled in
  --    game settings, and it cannot reach private LAN addresses.
  if type(game) == "userdata" and game.GetService then
    local http = game:GetService("HttpService")
    local ok, res = pcall(function()
      return http:RequestAsync({
        Url = url, Method = method, Headers = headers, Body = body,
      })
    end)
    if not ok then return nil, tostring(res) end
    return res.StatusCode, res.Body
  end

  -- 3. ComputerCraft.
  if type(http) == "table" and http.post and http.get then
    local handle, err
    if method == "POST" then
      handle, err = http.post(url, body or "", headers)
    else
      handle, err = http.get(url, headers)
    end
    if not handle then return nil, tostring(err) end
    local text = handle.readAll()
    local code = handle.getResponseCode and handle.getResponseCode() or 200
    handle.close()
    return code, text
  end

  -- 4. Plain Lua with luasocket / luasec.
  local okHttp, socketHttp = pcall(require, "socket.http")
  local okHttps, ssl = pcall(require, "ssl.https")
  local client = url:match("^https:") and okHttps and ssl or (okHttp and socketHttp)
  if client then
    local ltn12 = require("ltn12")
    local chunks = {}
    local requestHeaders = {}
    for key, value in pairs(headers or {}) do requestHeaders[key] = value end
    requestHeaders["content-length"] = tostring(#(body or ""))

    local _, code = client.request({
      url = url,
      method = method,
      headers = requestHeaders,
      source = body and ltn12.source.string(body) or nil,
      sink = ltn12.sink.table(chunks),
    })
    return code, table.concat(chunks)
  end

  return nil, "no HTTP client available (tried request/HttpService/ComputerCraft/luasocket)"
end

--- Seconds since the epoch, as a number.
--- ComputerCraft's os.time() is the *in-game* clock (0-24), so a deadline built
--- from it would be nonsense there; os.epoch is the real one.
local function now()
  if type(os) == "table" and os.epoch then
    local ok, ms = pcall(os.epoch, "utc")
    if ok and type(ms) == "number" then return ms / 1000 end
  end
  return os.time()
end

--- Sleeps for `seconds`, using whatever the host provides.
local function sleep(seconds)
  if type(task) == "table" and task.wait then return task.wait(seconds) end
  if type(wait) == "function" then return wait(seconds) end
  if type(os) == "table" and os.sleep then return os.sleep(seconds) end

  local okSocket, socket = pcall(require, "socket")
  if okSocket and socket.sleep then return socket.sleep(seconds) end

  local target = os.clock() + seconds
  while os.clock() < target do end
end

-- ---------------------------------------------------------------- client

local Client = {}
Client.__index = Client

--- Creates a client.
--- opts.url      base URL of the server, e.g. "http://192.168.1.50:3000"
--- opts.token    API token, when the server sets API_TOKENS
--- opts.timeout  seconds to wait for an instruction to finish (default 600)
--- opts.poll     seconds between status checks while waiting (default 2)
function M.new(opts)
  opts = opts or {}
  local self = setmetatable({}, Client)
  self.url = (opts.url or "http://localhost:3000"):gsub("/+$", "")
  self.token = opts.token
  self.timeout = opts.timeout or 600
  self.poll = opts.poll or 2
  self.onEvent = opts.onEvent
  return self
end

function Client:headers()
  local headers = { ["Content-Type"] = "application/json" }
  if self.token then headers["Authorization"] = "Bearer " .. self.token end
  return headers
end

function Client:call(method, path, payload)
  local body = payload and json.encode(payload) or nil
  local status, text = httpRequest(method, self.url .. path, body, self:headers())

  if not status then return nil, text end
  local data = text and text ~= "" and json.decode(text) or {}
  if status >= 400 then
    return nil, (data and data.error) or ("HTTP " .. tostring(status))
  end
  return data or {}
end

--- Is the agent up and ready to build? Returns a table, or nil plus an error.
function Client:health()
  return self:call("GET", "/api/v1/health")
end

--- Queues an instruction without waiting. Returns the job id.
function Client:submit(instruction, opts)
  opts = opts or {}
  local payload = { message = instruction, source = opts.source or "lua" }
  if opts.reset then payload.reset = true end
  if opts.maxTurns then payload.maxTurns = opts.maxTurns end

  local job, err = self:call("POST", "/api/v1/instructions", payload)
  if not job then return nil, err end
  return job.id, job
end

--- Fetches the current state of a queued instruction.
function Client:status(id)
  return self:call("GET", "/api/v1/instructions/" .. id)
end

--- Waits for an instruction to finish. Returns the finished job table.
function Client:wait(id, timeout)
  local deadline = now() + (timeout or self.timeout)
  local seen = 0

  while now() < deadline do
    local job, err = self:call("GET", "/api/v1/instructions/" .. id .. "?events=1")
    if not job then return nil, err end

    -- Report anything new since the last check, so callers can print progress.
    if self.onEvent and job.events then
      for i = seen + 1, #job.events do
        self.onEvent(job.events[i])
        seen = i
      end
    end

    if job.status == "done" then return job end
    if job.status == "error" then return nil, job.error or "the instruction failed" end
    if job.status == "cancelled" then return nil, "the instruction was cancelled" end

    sleep(self.poll)
  end

  return nil, "timed out waiting for the instruction to finish"
end

--- Sends an instruction and waits for it. Returns Claude's reply text.
--- This is the one-liner most scripts want:
---     local reply = assert(claude:send("dig down to bedrock"))
function Client:send(instruction, opts)
  local id, err = self:submit(instruction, opts)
  if not id then return nil, err end

  local job, waitErr = self:wait(id, opts and opts.timeout)
  if not job then return nil, waitErr end
  return job.reply, job
end

--- Asks a running instruction to stop at the next safe point.
function Client:cancel(id)
  return self:call("POST", "/api/v1/instructions/" .. id .. "/cancel")
end

--- Starts Claude's conversation fresh — it forgets earlier instructions.
function Client:reset()
  return self:call("POST", "/api/v1/reset")
end

return M
