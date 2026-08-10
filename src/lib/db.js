/*
 * db.js — minimal promise-based IndexedDB wrapper (no external deps, so nothing
 * remote ships — required for Chrome Web Store MV3 compliance).
 *
 * Two object stores:
 *   raw      — immutable captured payloads (gzipped). Source of truth.
 *   derived  — normalized records produced by adapters. Always re-derivable
 *              from `raw` via "Reprocess all".
 */

const DB_NAME = "lcfc";
const DB_VERSION = 3;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("raw")) {
        const raw = db.createObjectStore("raw", { keyPath: "captureId" });
        raw.createIndex("platform", "platform", { unique: false });
        raw.createIndex("capturedAt", "capturedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("derived")) {
        const derived = db.createObjectStore("derived", { keyPath: "captureId" });
        derived.createIndex("platform", "platform", { unique: false });
        derived.createIndex("conversationId", "conversationId", { unique: false });
        derived.createIndex("capturedAt", "capturedAt", { unique: false });
      }
      // v2: named prompt groups ("projects").
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
      // v3: Loader runs, so the Compare view can diff one run against another.
      if (!db.objectStoreNames.contains("runs")) {
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("startedAt", "startedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        Promise.resolve(fn(os)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  put(store, value) {
    return tx(store, "readwrite", (os) => reqToPromise(os.put(value)));
  },
  get(store, key) {
    return tx(store, "readonly", (os) => reqToPromise(os.get(key)));
  },
  getAll(store) {
    return tx(store, "readonly", (os) => reqToPromise(os.getAll()));
  },
  getAllKeys(store) {
    return tx(store, "readonly", (os) => reqToPromise(os.getAllKeys()));
  },
  delete(store, key) {
    return tx(store, "readwrite", (os) => reqToPromise(os.delete(key)));
  },
  clear(store) {
    return tx(store, "readwrite", (os) => reqToPromise(os.clear()));
  },
  count(store) {
    return tx(store, "readonly", (os) => reqToPromise(os.count()));
  },
  // Oldest-first keys, up to `limit`. Walks the capturedAt index with a cursor so
  // retention pruning never loads whole records (or gzipped blobs) into memory.
  getAllKeysSortedByTime(store, limit) {
    return tx(store, "readonly", (os) => {
      return new Promise((resolve, reject) => {
        const out = [];
        if (limit <= 0) return resolve(out);
        let idx;
        try {
          idx = os.index("capturedAt");
        } catch (_) {
          return resolve(out); // index missing — skip pruning rather than guess
        }
        const req = idx.openKeyCursor(null, "next"); // ascending = oldest first
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve(out);
          out.push(cur.primaryKey);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  },
};
