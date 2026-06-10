import type { RuntimeScopeKind } from "@agenthub/shared";

export type SeqStore = Record<string, number>;

export function scopeKey(scopeKind: RuntimeScopeKind, scopeId: string) {
  return `${scopeKind}:${scopeId}`;
}

export function seqStorageKey(userId: string) {
  return `agenthub-realtime-seq:${userId}`;
}

export function readSeqStore(userId: string): SeqStore {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(seqStorageKey(userId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SeqStore;
  } catch {
    window.localStorage.removeItem(seqStorageKey(userId));
    return {};
  }
}

export function writeSeqStore(userId: string, store: SeqStore) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(seqStorageKey(userId), JSON.stringify(store));
}

export function clearRealtimeSeqStore(userId?: string) {
  if (typeof window === "undefined") return;
  if (userId) {
    window.localStorage.removeItem(seqStorageKey(userId));
    return;
  }
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("agenthub-realtime-seq:")) window.localStorage.removeItem(key);
  }
}
