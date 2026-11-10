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
const DB_VERSION = 8;

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
      // v4: GEO brand tracking. Every upgrade block is guarded by a `contains`
      // check and only ever ADDS stores, so an existing install upgrades in
      // place — no capture is touched or migrated, and `derived.geo` simply
      // reads as undefined (treated as null / ad-hoc) on pre-v4 records.
      if (!db.objectStoreNames.contains("profiles")) {
        db.createObjectStore("profiles", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("trackedPrompts")) {
        const tp = db.createObjectStore("trackedPrompts", { keyPath: "id" });
        tp.createIndex("profileId", "profileId", { unique: false });
      }
      if (!db.objectStoreNames.contains("geoRuns")) {
        const gr = db.createObjectStore("geoRuns", { keyPath: "id" });
        gr.createIndex("profileId", "profileId", { unique: false });
        gr.createIndex("startedAt", "startedAt", { unique: false });
      }
      // v5: the error log. Errors used to go nowhere — 22 silent `catch (_)`
      // blocks in the service worker plus an in-memory DEBUG ring buffer that
      // MV3 wiped on every worker restart (~30s idle) and that only recorded
      // capture events, never failures. So "something broke" could not be
      // turned into "this broke, here, at this time". Durable because the
      // failures that matter most happen hours into an unattended run, long
      // before anyone looks. Same additive, `contains`-guarded upgrade as
      // every block above: no existing record is touched.
      if (!db.objectStoreNames.contains("errors")) {
        const er = db.createObjectStore("errors", { keyPath: "id" });
        er.createIndex("at", "at", { unique: false });
        er.createIndex("where", "where", { unique: false });
      }
      // v6: the error log became the one unified diagnostics log — entries
      // now carry a `kind` ("error" | "capture" | "turn", folding in what
      // used to be the separate in-memory DEBUG ring buffer plus per-turn
      // outcome history) and a `runId` so a campaign export can pull every
      // entry for its runs in one indexed query instead of a full scan.
      // The store already exists for any install that ran v5, so this adds
      // the index onto it rather than recreating it — `contains` above only
      // covers a fresh install.
      {
        const er = e.target.transaction.objectStore("errors");
        if (!er.indexNames.contains("runId")) {
          er.createIndex("runId", "context.runId", { unique: false });
        }
      }
      // v7: the cited pages read on this computer (0.62.0, "Read the cited
      // pages"), one row per address: its readable text, when and how it was
      // read. Kept apart from the records so a reprocess re-matches brands
      // against the same text without fetching anything again.
      if (!db.objectStoreNames.contains("pages")) {
        const pg = db.createObjectStore("pages", { keyPath: "url" });
        pg.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
      // Also v7: what ChatGPT loaded after an answer (a product card's stores,
      // 0.62.0), one row per reply, tied to the capture it followed.
      if (!db.objectStoreNames.contains("interactions")) {
        const it = db.createObjectStore("interactions", { keyPath: "id" });
        it.createIndex("captureId", "captureId", { unique: false });
      }
      // v8 (0.70.0): the built-in AI's checks, keyed by the answer's text,
      // the model and the prompt version, so a duplicate answer is checked
      // once and a reprocess never runs the model again; and the answers
      // waiting for a check, so a browser restart loses none.
      if (!db.objectStoreNames.contains("ai")) {
        const ai = db.createObjectStore("ai", { keyPath: "key" });
        ai.createIndex("captureId", "captureId", { unique: false });
      }
      if (!db.objectStoreNames.contains("aiQueue")) {
        db.createObjectStore("aiQueue", { keyPath: "captureId" });
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
  // Every row whose index `index` equals `value` (e.g. a capture's interactions).
  getAllByIndex(store, index, value) {
    return tx(store, "readonly", (os) => reqToPromise(os.index(index).getAll(value)));
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
  /* Oldest-first keys the retention cap may actually delete.
   *
   * getAllKeysSortedByTime() below returns keys blindly, which meant pruning
   * could delete campaign captures mid-run (see isPrunableCapture in
   * lib/geo.js for why that is data loss, not housekeeping). This walks the
   * same capturedAt index oldest-first but reads each VALUE so the caller's
   * predicate can veto it, and keeps walking past a vetoed record rather than
   * stopping — so a store whose oldest entries are all campaign captures
   * still yields the ad-hoc ones behind them instead of pruning nothing.
   */
  getOldestPrunableKeys(store, limit, isPrunable) {
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
        const req = idx.openCursor(null, "next"); // ascending = oldest first
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve(out);
          try {
            if (isPrunable(cur.value)) out.push(cur.primaryKey);
          } catch (_) {
            /* a predicate throwing must not abort the walk; just skip this one */
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  // Records captured between two times, via the capturedAt index. Used to
  // find other copies of the same answer (lib/sameAnswer.js) without loading
  // the whole store.
  getByTimeRange(store, from, to) {
    return tx(store, "readonly", (os) => {
      let idx;
      try {
        idx = os.index("capturedAt");
      } catch (_) {
        return Promise.resolve([]);
      }
      return reqToPromise(idx.getAll(IDBKeyRange.bound(from, to)));
    });
  },

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
