import { config } from "./config.js";

/**
 * Carries out one instruction with the local agent and bot.
 *
 * Shared by the in-process runner (server owns the bot) and the remote worker
 * (Minecraft lives on another machine), so both behave identically.
 *
 * `onEvent` receives every progress event. `shouldCancel` is polled between
 * agent events; a cancel stops the loop cleanly rather than mid tool call.
 * Resolves to `{ error }` — null when the instruction finished normally.
 */
export async function runInstruction({ job, agent, mcp, onEvent, shouldCancel = () => false }) {
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // A failed progress report must not abandon a half-finished build.
    }
  };

  if (job.control === "reset") {
    agent.reset();
    emit({ type: "text", text: "Conversation reset." });
    return { error: null };
  }

  if (!mcp.connected) {
    return { error: "Not connected to the Minecraft MCP server. Connect the bot first." };
  }
  if (!config.apiKey) {
    return { error: "No Claude API key configured. Save one in Settings, or set ANTHROPIC_API_KEY." };
  }

  if (job.reset) agent.reset();

  let failure = null;
  try {
    const options = { images: job.images ?? [] };
    if (job.maxTurns) options.maxTurns = job.maxTurns;

    for await (const event of agent.run(job.message, options)) {
      // `done` is implied by the job's own terminal status, and `error` becomes
      // the job's error — passing either through would report it twice.
      if (event.type === "done") continue;
      if (event.type === "error") {
        failure = event.text;
        continue;
      }
      emit(event);

      if (shouldCancel()) {
        emit({ type: "text", text: "Stopping — this instruction was cancelled." });
        break;
      }
    }
  } catch (err) {
    failure = err.message;
  }

  return { error: failure };
}

/**
 * Drains the queue in-process. Used when the server and Minecraft are on the
 * same machine, which is the single-computer setup.
 *
 * The lock is shared with the web UI so a browser message and a queued
 * instruction never talk over each other in the same conversation.
 */
export function startLocalRunner({ queue, agent, mcp, lock, name = "local" }) {
  let stopped = false;

  (async function loop() {
    while (!stopped) {
      let job;
      try {
        job = await queue.claim({ worker: name, timeoutMs: 5_000 });
      } catch (err) {
        console.error("Runner: failed to claim an instruction:", err.message);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (!job) continue;

      // Cancelled while it sat in the queue.
      if (job.cancelRequested) {
        queue.finish(job.id, { error: null });
        continue;
      }

      const release = await lock.acquire();
      try {
        const { error } = await runInstruction({
          job,
          agent,
          mcp,
          onEvent: (event) => queue.append(job.id, event),
          shouldCancel: () => job.cancelRequested,
        });
        queue.finish(job.id, { error });
      } catch (err) {
        queue.finish(job.id, { error: err.message });
      } finally {
        release();
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
