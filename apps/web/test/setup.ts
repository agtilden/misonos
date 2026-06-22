import "@testing-library/jest-dom/vitest";

// Some Node versions (25+) ship a built-in Web Storage `localStorage` global that
// shadows jsdom's and throws without a backing store, breaking anything that persists
// to localStorage. Install a deterministic in-memory implementation so the suite
// behaves identically on every Node version.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(String(key), String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}
const memoryStorage = new MemoryStorage() as unknown as Storage;
for (const target of [globalThis, typeof window === "undefined" ? undefined : window]) {
  if (!target) continue;
  try {
    Object.defineProperty(target, "localStorage", { configurable: true, writable: true, value: memoryStorage });
  } catch {
    try { (target as { localStorage: Storage }).localStorage = memoryStorage; } catch { /* exotic env: leave its own in place */ }
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
}
