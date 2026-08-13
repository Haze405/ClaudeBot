# Instruction API

Send instructions to the Minecraft agent from any script or language. Every
endpoint takes and returns JSON.

Base URL is wherever the server runs, e.g. `http://localhost:3000` locally or
`https://your-server.example.com` when hosted.

## Authentication

Set `API_TOKENS` on the server (comma-separated to allow several) and send the
token with each request:

```
Authorization: Bearer your-token
```

`x-api-key: your-token` works too, and so does `?token=your-token` on the query
string — some Lua HTTP clients cannot set headers at all.

**If `API_TOKENS` is not set, only the server's own machine can submit
instructions.** That way a server accidentally exposed to the internet is not
wide open. Set a token before letting anything else reach it.

## The short version

```bash
curl -X POST http://localhost:3000/api/v1/instructions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"message": "build a 5x5 dirt platform above me", "wait": true, "timeoutMs": 120000}'
```

---

## `POST /api/v1/instructions`

Queues an instruction. Returns **202** immediately with a job id.

| Field       | Type    | Meaning                                                          |
| ----------- | ------- | ---------------------------------------------------------------- |
| `message`   | string  | **Required.** What Claude should do. `instruction`, `prompt`, and `text` are accepted as aliases. |
| `wait`      | boolean | Hold the connection until the instruction finishes. Default `false`. |
| `timeoutMs` | number  | With `wait`, how long to hold. Default 60000, capped at 300000.  |
| `events`    | boolean | With `wait`, include the full event list in the response.        |
| `reset`     | boolean | Forget the earlier conversation before running this.             |
| `maxTurns`  | number  | Cap on Claude's tool-use rounds. Default 100.                    |
| `images`    | array   | `[{ "name": "ref.png", "data": "<base64>" }]` — up to 4, 5MB each. |
| `source`    | string  | A label for your script; shows up in the job list.               |

```json
{
  "id": "6daf454d-6cbe-4345-942f-05609d46f4dd",
  "status": "queued",
  "message": "build a 5x5 dirt platform above me",
  "reply": "",
  "error": null,
  "createdAt": 1786657419743
}
```

`status` is one of `queued`, `running`, `done`, `error`, `cancelled`.

Instructions run **one at a time, in the order they arrive** — there is one bot
and one conversation, so a second instruction waits for the first to finish.

Returns 429 when too many are already waiting.

### Waiting inline

Set `wait: true` to get the finished job back in the same response. Convenient
for `curl` and short instructions. Builds routinely take longer than any HTTP
client will hold a connection, so for real work submit and poll instead.

## `GET /api/v1/instructions/:id`

The current state of one instruction. Add `?events=1` for the full trace of
tool calls.

```json
{
  "id": "6daf454d-...",
  "status": "done",
  "reply": "Built the platform 3 blocks above you, 25 dirt in a 5x5.",
  "eventCount": 14,
  "events": [
    { "type": "tool", "name": "place-block", "input": { "x": 10, "y": 65, "z": 3 } },
    { "type": "tool_result", "name": "place-block", "text": "Placed dirt", "isError": false },
    { "type": "text", "text": "Built the platform..." }
  ]
}
```

Event types: `text` (Claude talking), `tool` (a tool call starting),
`tool_result` (what it returned), `error`.

## `GET /api/v1/instructions/:id/wait`

Long-polls until the instruction finishes, then returns the job. Takes
`?timeoutMs=` (default 60000, max 300000) and `?events=1`. Returns the job in
whatever state it is in when the wait runs out, so check `status`.

Cheaper than polling `GET /:id` in a loop, when your HTTP client can wait.

## `GET /api/v1/instructions/:id/stream`

Live progress as newline-delimited JSON — one event per line, ending when the
instruction does. Add `?from=N` to skip events you already have.

```bash
curl -N http://localhost:3000/api/v1/instructions/$ID/stream -H "Authorization: Bearer your-token"
```

## `GET /api/v1/instructions`

Recent instructions, newest first. `?limit=` up to 100.

## `POST /api/v1/instructions/:id/cancel`

Asks an instruction to stop. A queued one is dropped; a running one stops at
the next safe point rather than mid tool call — the bot will not be yanked out
of a half-placed block, but a partly built structure stays partly built.

## `POST /api/v1/reset`

Starts Claude's conversation over. It forgets earlier instructions and any
reference images. Queued like anything else, so it takes effect after the
current instruction rather than interrupting it.

## `GET /api/v1/health`

No authentication — safe for uptime checks.

```json
{
  "ok": true,
  "ready": true,
  "mode": "relay",
  "botConnected": false,
  "workers": 1,
  "queued": 0,
  "running": 1,
  "authRequired": true
}
```

`ready` is the one to check before sending work: it means a bot is actually
attached and instructions will be carried out rather than piling up.

---

## Errors

Failures come back as `{ "error": "..." }` with a real status code.

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 400  | Bad request — usually a missing `message` or a rejected image.    |
| 401  | Missing or wrong API token.                                      |
| 403  | No tokens configured, and you are not on the server's machine.    |
| 404  | No such instruction (ids are forgotten 30 minutes after finishing). |
| 409  | Nothing can run the instruction — bot not connected, or no worker attached. |
| 429  | Too many instructions already queued.                            |

An instruction that fails *while running* still returns 200 from the status
endpoint — check `status` and `error` on the job itself.

---

## Worker endpoints

`/api/worker/*` is how the machine running Minecraft pulls work from a hosted
relay. It is authenticated separately with `WORKER_TOKEN`. You do not need
these unless you are writing your own worker; `npm run worker` speaks it.

| Endpoint                   | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `GET /api/worker/next`     | Long-polls for the next instruction. 204 when nothing is waiting. |
| `POST /api/worker/events`  | Reports progress. The reply says whether a cancel was requested. |
| `POST /api/worker/result`  | Reports the outcome and finishes the job.                   |
| `POST /api/worker/heartbeat` | Says the worker is still alive.                           |

A job whose worker goes silent for 15 minutes is failed rather than retried —
re-running a build that may have half-happened would stack a second structure
on top of the first.
