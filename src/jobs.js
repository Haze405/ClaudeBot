import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/** Statuses a job never leaves. */
export const TERMINAL = new Set(["done", "error", "cancelled"]);

const MINUTE = 60_000;

/**
 * A queue of instructions waiting to be carried out in Minecraft.
 *
 * Two things drain it, and they never both run at once:
 *   - the in-process runner, when the server itself owns the bot (local mode);
 *   - a remote worker on the Minecraft machine, which long-polls `claim()`
 *     over HTTP (relay mode).
 *
 * Everything lives in memory. A restart loses the queue, which is the right
 * trade for instructions whose whole meaning is "do this in the world now".
 */
export class JobQueue {
  constructor({
    maxQueued = 50,
    keepFinished = 200,
    finishedTtlMs = 30 * MINUTE,
    leaseMs = 15 * MINUTE,
  } = {}) {
    this.maxQueued = maxQueued;
    this.keepFinished = keepFinished;
    this.finishedTtlMs = finishedTtlMs;
    this.leaseMs = leaseMs;

    this.jobs = new Map();
    this.waiting = []; // ids of queued jobs, oldest first
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
    this.workers = new Map(); // name -> { name, lastSeen }

    this.sweeper = setInterval(() => this.sweep(), MINUTE);
    // Never hold the process open just to expire old jobs.
    this.sweeper.unref?.();
  }

  /**
   * Adds an instruction to the queue.
   * `images` are `{ mediaType, data }` with base64 data, already validated.
   */
  enqueue({ message, images = [], reset = false, source = "api", client = null, maxTurns, control = null }) {
    const text = String(message ?? "").trim();
    // A control job ("reset the conversation") carries no instruction of its own.
    if (!control && !text) throw new Error("message is required");
    if (this.waiting.length >= this.maxQueued) {
      throw new Error(`Queue is full (${this.maxQueued} instructions waiting). Try again shortly.`);
    }

    const job = {
      id: randomUUID(),
      status: "queued",
      control,
      message: text || "(reset conversation)",
      images,
      reset: Boolean(reset),
      maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
      source,
      client,
      events: [],
      reply: "",
      error: null,
      worker: null,
      cancelRequested: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      leaseUntil: null,
    };

    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    this.bus.emit("queued");
    this.#changed(job.id);
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  /**
   * Long-polls for the next instruction. Resolves to a job once one is
   * available, or null when `timeoutMs` passes with the queue still empty.
   */
  async claim({ timeoutMs = 25_000, worker = "local" } = {}) {
    this.heartbeat(worker);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = this.#takeQueued();
      if (job) {
        job.status = "running";
        job.worker = worker;
        job.startedAt = Date.now();
        job.leaseUntil = job.startedAt + this.leaseMs;
        this.#changed(job.id);
        return job;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.#waitForQueued(Math.min(remaining, 5_000));
    }
  }

  /** Records progress from whoever is running the job. */
  append(id, event) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return null;

    job.events.push(event);
    job.leaseUntil = Date.now() + this.leaseMs;
    // The reply is the assistant's prose, stitched together for callers that
    // only want an answer and not the whole tool trace.
    if (event.type === "text" && event.text) {
      job.reply = job.reply ? `${job.reply}\n${event.text}` : event.text;
    }
    this.#changed(id);
    return job;
  }

  /** Marks a job finished. Passing an `error` marks it failed instead. */
  finish(id, { error = null } = {}) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return null;

    job.status = error ? "error" : job.cancelRequested ? "cancelled" : "done";
    job.error = error ? String(error) : null;
    job.finishedAt = Date.now();
    job.leaseUntil = null;
    job.images = [];
    this.#changed(id);
    this.#trim();
    return job;
  }

  /**
   * Asks for a job to stop. A queued job is dropped outright; a running one is
   * only flagged — the runner checks between turns, because yanking the bot
   * mid-build would leave half a structure behind.
   */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.status)) return null;

    job.cancelRequested = true;
    if (job.status === "queued") {
      const at = this.waiting.indexOf(id);
      if (at !== -1) this.waiting.splice(at, 1);
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.images = [];
      this.#changed(id);
    } else {
      this.#changed(id);
    }
    return job;
  }

  /**
   * Yields a job's events as they happen, ending when the job does. Used by
   * the browser's NDJSON stream and by API clients that want to watch.
   */
  async *stream(id, { fromIndex = 0 } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No such job: ${id}`);

    let sent = Math.max(0, fromIndex);
    for (;;) {
      while (sent < job.events.length) yield job.events[sent++];
      if (TERMINAL.has(job.status)) {
        if (job.status === "error" && job.error) yield { type: "error", text: job.error };
        if (job.status === "cancelled") yield { type: "error", text: "Instruction cancelled." };
        if (job.status === "done") yield { type: "done" };
        return;
      }
      await this.#waitForChange(id, 20_000);
    }
  }

  /** Resolves once the job reaches a terminal status, or the wait times out. */
  async waitForFinish(id, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.jobs.get(id);
      if (!job) return null;
      if (TERMINAL.has(job.status)) return job;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return job;
      await this.#waitForChange(id, Math.min(remaining, 20_000));
    }
  }

  heartbeat(name) {
    if (!name) return;
    this.workers.set(name, { name, lastSeen: Date.now() });
  }

  /** Workers seen within the last minute count as attached. */
  activeWorkers(withinMs = MINUTE) {
    const cutoff = Date.now() - withinMs;
    return [...this.workers.values()].filter((w) => w.lastSeen >= cutoff);
  }

  stats() {
    let running = 0;
    for (const job of this.jobs.values()) if (job.status === "running") running++;
    return {
      queued: this.waiting.length,
      running,
      tracked: this.jobs.size,
      workers: this.activeWorkers().map((w) => ({ name: w.name, lastSeen: w.lastSeen })),
    };
  }

  /**
   * Fails jobs whose worker went away, and forgets old finished ones.
   *
   * A lost job is failed rather than requeued on purpose: re-running a build
   * that may have half-happened would stack a second structure on top of the
   * first. The caller gets an error and decides whether to send it again.
   */
  sweep() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.leaseUntil && now > job.leaseUntil) {
        this.finish(job.id, {
          error: "The worker running this instruction stopped responding. Nothing more will happen; check the world before sending it again.",
        });
      }
      if (TERMINAL.has(job.status) && job.finishedAt && now - job.finishedAt > this.finishedTtlMs) {
        this.jobs.delete(job.id);
      }
    }
    this.#trim();
  }

  close() {
    clearInterval(this.sweeper);
  }

  #takeQueued() {
    while (this.waiting.length) {
      const job = this.jobs.get(this.waiting.shift());
      if (job && job.status === "queued") return job;
    }
    return null;
  }

  #changed(id) {
    this.bus.emit(`job:${id}`);
  }

  /** Resolves on the next change to this job, or after `ms` regardless. */
  #waitForChange(id, ms) {
    return new Promise((resolve) => {
      const key = `job:${id}`;
      const timer = setTimeout(() => {
        this.bus.off(key, onChange);
        resolve();
      }, ms);
      const onChange = () => {
        clearTimeout(timer);
        resolve();
      };
      this.bus.once(key, onChange);
    });
  }

  #waitForQueued(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bus.off("queued", onQueued);
        resolve();
      }, ms);
      const onQueued = () => {
        clearTimeout(timer);
        resolve();
      };
      this.bus.once("queued", onQueued);
    });
  }

  /** Keeps only the most recent finished jobs so memory stays bounded. */
  #trim() {
    const finished = [...this.jobs.values()]
      .filter((j) => TERMINAL.has(j.status))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

    const excess = finished.length - this.keepFinished;
    for (let i = 0; i < excess; i++) this.jobs.delete(finished[i].id);
  }
}

/** The view of a job handed back over HTTP. Never includes image payloads. */
export function jobView(job, { events = false } = {}) {
  if (!job) return null;
  const view = {
    id: job.id,
    status: job.status,
    control: job.control ?? null,
    message: job.message,
    reply: job.reply,
    error: job.error,
    source: job.source,
    worker: job.worker,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    eventCount: job.events.length,
  };
  if (events) view.events = job.events;
  return view;
}
