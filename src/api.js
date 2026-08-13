import crypto from "node:crypto";
import express from "express";
import { jobView } from "./jobs.js";

/** Splits "a, b,c" into ["a","b","c"]. */
function tokenList(raw) {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Constant-time compare so a token can't be guessed a character at a time. */
function tokenMatches(supplied, allowed) {
  const given = Buffer.from(String(supplied));
  return allowed.some((candidate) => {
    const expected = Buffer.from(candidate);
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
  });
}

/** Reads the token from `Authorization: Bearer x`, `x-api-key`, or `?token=`. */
function readToken(req) {
  const auth = String(req.get("authorization") || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const header = req.get("x-api-key");
  if (header) return String(header).trim();
  // Query fallback: some Lua HTTP stacks cannot set request headers at all.
  if (req.query?.token) return String(req.query.token);
  return "";
}

function isLoopback(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1");
}

/**
 * Builds an auth gate. When tokens are configured the caller must present one;
 * when none are configured only loopback callers get through, so a server that
 * is accidentally exposed without tokens is not wide open.
 */
function requireToken(tokens, what) {
  return (req, res, next) => {
    if (tokens.length === 0) {
      if (isLoopback(req)) return next();
      return res.status(403).json({
        error: `Forbidden: set ${what} on the server to accept requests from other machines.`,
      });
    }
    if (!tokenMatches(readToken(req), tokens)) {
      return res.status(401).json({ error: "Unauthorized: missing or invalid API token." });
    }
    return next();
  };
}

const MAX_WAIT_MS = 300_000;
const clampWait = (raw, fallback) => {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(ms, MAX_WAIT_MS);
};

/**
 * The script-facing API (`/api/v1`) and the endpoints a remote worker uses to
 * pull instructions (`/api/worker`).
 *
 * `validateImages` is passed in so this module does not have to know how the
 * Messages API wants images checked.
 */
export function createApiRouter({ queue, validateImages, describeRuntime }) {
  const router = express.Router();

  const clientTokens = tokenList(process.env.API_TOKENS || process.env.API_TOKEN);
  const workerTokens = tokenList(process.env.WORKER_TOKEN || process.env.WORKER_TOKENS);
  const clientAuth = requireToken(clientTokens, "API_TOKENS");
  const workerAuth = requireToken(workerTokens, "WORKER_TOKEN");

  // ---------------------------------------------------------------- clients

  // Unauthenticated on purpose: uptime checks and "is the bot there?" probes.
  router.get("/v1/health", (req, res) => {
    const runtime = describeRuntime();
    const stats = queue.stats();
    res.json({
      ok: true,
      ready: runtime.mode === "relay" ? stats.workers.length > 0 : runtime.connected,
      mode: runtime.mode,
      botConnected: runtime.connected,
      workers: stats.workers.length,
      queued: stats.queued,
      running: stats.running,
      authRequired: clientTokens.length > 0,
    });
  });

  router.post("/v1/instructions", clientAuth, async (req, res) => {
    const body = req.body ?? {};
    // Accept the obvious synonyms — scripts guess at least one of these.
    const message = body.message ?? body.instruction ?? body.prompt ?? body.text;

    let images;
    try {
      images = validateImages(body.images);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let job;
    try {
      job = queue.enqueue({
        message,
        images,
        reset: Boolean(body.reset),
        maxTurns: body.maxTurns,
        source: String(body.source || "api").slice(0, 64),
        client: readToken(req) ? "token" : "local",
      });
    } catch (err) {
      const full = /Queue is full/.test(err.message);
      return res.status(full ? 429 : 400).json({ error: err.message });
    }

    // Fire-and-forget by default: builds take minutes and most HTTP clients
    // give up long before that. `wait` is for curl and quick one-liners.
    if (!body.wait) {
      return res.status(202).json(jobView(job));
    }

    const finished = await queue.waitForFinish(job.id, clampWait(body.timeoutMs, 60_000));
    return res.status(200).json(jobView(finished ?? job, { events: Boolean(body.events) }));
  });

  router.get("/v1/instructions", clientAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const jobs = [...queue.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((job) => jobView(job));
    res.json({ jobs, ...queue.stats() });
  });

  router.get("/v1/instructions/:id", clientAuth, (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: "No such instruction." });
    res.json(jobView(job, { events: req.query.events === "1" || req.query.events === "true" }));
  });

  /** Long-polls until the instruction finishes. Returns the job either way. */
  router.get("/v1/instructions/:id/wait", clientAuth, async (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: "No such instruction." });

    const finished = await queue.waitForFinish(job.id, clampWait(req.query.timeoutMs, 60_000));
    res.json(jobView(finished ?? job, { events: req.query.events === "1" }));
  });

  /** Live NDJSON events, one JSON object per line, ending when the job does. */
  router.get("/v1/instructions/:id/stream", clientAuth, async (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: "No such instruction." });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();

    const from = Number(req.query.from) || 0;
    try {
      for await (const event of queue.stream(job.id, { fromIndex: from })) {
        if (res.writableEnded) break;
        res.write(JSON.stringify(event) + "\n");
      }
    } catch (err) {
      res.write(JSON.stringify({ type: "error", text: err.message }) + "\n");
    }
    res.end();
  });

  router.post("/v1/instructions/:id/cancel", clientAuth, (req, res) => {
    const job = queue.cancel(req.params.id);
    if (!job) return res.status(404).json({ error: "No such instruction, or it already finished." });
    res.json(jobView(job));
  });

  /** Starts Claude's conversation over without sending an instruction. */
  router.post("/v1/reset", clientAuth, (req, res) => {
    const job = queue.enqueue({ control: "reset", source: "api" });
    res.status(202).json(jobView(job));
  });

  // ---------------------------------------------------------------- workers

  router.get("/worker/next", workerAuth, async (req, res) => {
    const name = String(req.query.worker || "worker").slice(0, 64);
    const job = await queue.claim({
      worker: name,
      timeoutMs: clampWait(req.query.timeoutMs, 25_000),
    });

    if (!job) return res.status(204).end();

    const payload = {
      id: job.id,
      control: job.control ?? null,
      message: job.message,
      images: job.images,
      reset: job.reset,
      maxTurns: job.maxTurns ?? null,
    };
    // Handed off — no reason to keep megabytes of base64 in the queue.
    job.images = [];
    res.json(payload);
  });

  /**
   * Progress from a running job. The response tells the worker whether someone
   * has asked the job to stop, so cancellation needs no second request.
   */
  router.post("/worker/events", workerAuth, (req, res) => {
    const id = String(req.body?.jobId ?? "");
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const job = queue.get(id);
    if (!job) return res.status(404).json({ error: "No such instruction." });

    for (const event of events) queue.append(id, event);
    queue.heartbeat(job.worker);
    res.json({ ok: true, cancelRequested: job.cancelRequested });
  });

  router.post("/worker/result", workerAuth, (req, res) => {
    const id = String(req.body?.jobId ?? "");
    const job = queue.get(id);
    if (!job) return res.status(404).json({ error: "No such instruction." });

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const event of events) queue.append(id, event);

    const finished = queue.finish(id, { error: req.body?.error ?? null });
    res.json(jobView(finished ?? job));
  });

  router.post("/worker/heartbeat", workerAuth, (req, res) => {
    const name = String(req.body?.worker || "worker").slice(0, 64);
    queue.heartbeat(name);
    res.json({ ok: true, ...queue.stats() });
  });

  return router;
}
