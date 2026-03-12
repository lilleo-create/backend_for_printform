type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

export class TtlCache<K, V> {
  private readonly storage = new Map<K, CacheEntry<V>>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | null {
    const entry = this.storage.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.storage.delete(key);
      return null;
    }

    this.storage.delete(key);
    this.storage.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    if (ttlMs <= 0) {
      return;
    }

    if (this.storage.has(key)) {
      this.storage.delete(key);
    }
    this.storage.set(key, { value, expiresAt: Date.now() + ttlMs });

    while (this.storage.size > this.maxSize) {
      const oldestKey = this.storage.keys().next().value as K | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.storage.delete(oldestKey);
    }
  }
}
