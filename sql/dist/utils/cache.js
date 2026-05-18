"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TtlCache = void 0;
class TtlCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.storage = new Map();
    }
    get(key) {
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
    set(key, value, ttlMs) {
        if (ttlMs <= 0) {
            return;
        }
        if (this.storage.has(key)) {
            this.storage.delete(key);
        }
        this.storage.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (this.storage.size > this.maxSize) {
            const oldestKey = this.storage.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.storage.delete(oldestKey);
        }
    }
}
exports.TtlCache = TtlCache;
