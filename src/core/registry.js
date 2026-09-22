export class Registry {
  #entries = new Map();

  constructor(kind) {
    this.kind = kind;
  }

  register(name, value) {
    assertName(name, this.kind);
    if (this.#entries.has(name)) {
      throw new Error(`${this.kind} '${name}' is already registered.`);
    }
    this.#entries.set(name, value);
    return value;
  }

  replace(name, value) {
    assertName(name, this.kind);
    this.#entries.set(name, value);
    return value;
  }

  get(name) {
    const value = this.#entries.get(name);
    if (!value) throw new Error(`Unknown ${this.kind}: '${name}'.`);
    return value;
  }

  has(name) {
    return this.#entries.has(name);
  }

  unregister(name, expected) {
    if (expected !== undefined && this.#entries.get(name) !== expected) return false;
    return this.#entries.delete(name);
  }

  list() {
    return [...this.#entries.keys()].sort();
  }
}

function assertName(name, kind) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new TypeError(`Invalid ${kind} name: '${name}'.`);
  }
}
