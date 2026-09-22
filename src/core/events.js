export class EventBus {
  #listeners = new Map();

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
    await Promise.all(listeners.map((listener) => listener(event)));
    return event;
  }
}
