/**
 * Tiny persisted key/value used by the sync sources (tokens, cursors, last-pull records).
 * localStorage on the main thread; an in-memory double in tests. Kept free of app imports so
 * src/sync stays testable in Node.
 */

export interface KeyValue {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
  remove(key: string): void;
}

/** localStorage-backed; every failure (private mode, quota, no DOM) degrades to the fallback. */
export const localKV: KeyValue = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function memoryKV(initial: Record<string, unknown> = {}): KeyValue & { dump(): Record<string, unknown> } {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) map.set(k, JSON.stringify(v));
  return {
    read<T>(key: string, fallback: T): T {
      const raw = map.get(key);
      return raw === undefined ? fallback : (JSON.parse(raw) as T);
    },
    write(key, value) {
      map.set(key, JSON.stringify(value));
    },
    remove(key) {
      map.delete(key);
    },
    dump() {
      const out: Record<string, unknown> = {};
      for (const [k, v] of map) out[k] = JSON.parse(v);
      return out;
    },
  };
}
