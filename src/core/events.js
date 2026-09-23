export class EventBus {
  #listeners = new Map();

  constructor({ onListenerError } = {}) {
    this.onListenerError = onListenerError;
  }

  on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async emit(type, payload) {
    const event = Object.freeze({ type, at: new Date().toISOString(), ...payload });
    const listeners = [
      ...(this.#listeners.get(type) ?? []),
      ...(this.#listeners.get("*") ?? []),
    ];
    // Wrapped so a listener that throws synchronously is contained as well.
    const settled = await Promise.allSettled(listeners.map(async (listener) => listener(event)));
    for (const outcome of settled) {
      if (outcome.status === "rejected") this.#reportListenerError(outcome.reason, event);
    }
    return event;
  }

  #reportListenerError(error, event) {
    // Observers must never change the outcome of the run they observe.
    try {
      if (this.onListenerError) this.onListenerError(error, event);
      else console.error(`Event listener for '${event.type}' failed:`, error);
    } catch {
      // A failing error observer is itself not allowed to escape.
    }
  }
}
