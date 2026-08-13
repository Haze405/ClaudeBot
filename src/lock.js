/**
 * A promise mutex. The agent keeps one shared conversation and one bot, so
 * every path that runs a turn — the web UI, the job runner — has to take turns.
 */
export class Lock {
  constructor() {
    this.held = false;
    this.waiters = [];
  }

  get busy() {
    return this.held;
  }

  /** Takes the lock if it is free. Returns a release function, or null. */
  tryAcquire() {
    if (this.held) return null;
    this.held = true;
    return this.#releaser();
  }

  /** Waits for the lock. Resolves to a release function. */
  acquire() {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.#releaser()));
    });
  }

  /**
   * A one-shot release. Calling it twice would hand the lock to two owners at
   * once, so the second call is ignored.
   */
  #releaser() {
    let spent = false;
    return () => {
      if (spent) return;
      spent = true;
      const next = this.waiters.shift();
      // Ownership passes straight to the next waiter; `held` stays true.
      if (next) next();
      else this.held = false;
    };
  }
}
