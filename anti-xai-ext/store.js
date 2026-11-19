const AXAI_STORE = (() => {
  const DB_NAME = 'axai_db';
  const DB_VERSION = 1;
  const OS = 'detect';
  const MAX_RECORDS = 80000;

  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
          const db = req.result;
          if (e.oldVersion < 1) {
            const os = db.createObjectStore(OS, { keyPath: 'id', autoIncrement: true });
            os.createIndex('handle', 'handle');
            os.createIndex('activity', 'activity');
            os.createIndex('status_activity', ['status', 'activity']);
            os.createIndex('flagged_activity', ['flaggedKey', 'activity']);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
      });
    }
    return dbPromise;
  }

  const done = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const txDone = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const ms = iso => Date.parse(iso || '') || 0;

  function normalize(r) {
    r.flaggedKey = r.flagged ? 1 : 0;
    r.activity = Math.max(ms(r.blockedAt), ms(r.checkedAt));
    return r;
  }

  async function append(records) {
    if (!records.length) return;
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    for (const r of records) {
      const copy = { ...r };
      delete copy.id;
      os.add(normalize(copy));
    }
    await txDone(tx);
    await trim();
  }

  async function trim() {
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    const total = await done(os.count());
    if (total > MAX_RECORDS) {
      const keys = await done(os.getAllKeys(null, total - MAX_RECORDS));
      os.delete(IDBKeyRange.upperBound(keys[keys.length - 1]));
    }
    await txDone(tx);
  }

  async function updateStatus({ handle, status, reason, at }) {
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    const recs = (await done(os.index('handle').getAll(handle))).sort((a, b) => b.id - a.id);
    let changed = 0;
    for (const r of recs) {
      r.status = status;
      r.statusReason = reason || null;
      if (status === 'blocked') r.blockedAt = at || new Date().toISOString();
      os.put(normalize(r));
      changed++;
      break;
    }
    await txDone(tx);
    return changed;
  }

  async function ensureBlocked(record) {
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    const recs = (await done(os.index('handle').getAll(record.handle))).sort((a, b) => b.id - a.id);
    let result = 'exists';
    if (!recs.some(r => r.status === 'blocked')) {
      const latest = recs[0];
      if (latest) {
        latest.status = 'blocked';
        latest.blockedAt = record.blockedAt;
        os.put(normalize(latest));
        result = 'updated';
      } else {
        const copy = { ...record };
        delete copy.id;
        os.add(normalize(copy));
        result = 'added';
      }
    }
    await txDone(tx);
    return result;
  }

  async function markFalsePositive(handle, blockedStatus) {
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    const recs = (await done(os.index('handle').getAll(handle))).sort((a, b) => b.id - a.id);
    const target = recs.find(r => r.status === 'blocked') || recs[0] || null;
    const wasBlocked = target?.status === 'blocked';
    for (const r of recs) {
      r.falsePositive = true;
      r.flagged = false;
      r.status = r === target && wasBlocked ? blockedStatus : 'normal';
      r.statusReason = '标为误判';
      os.put(normalize(r));
    }
    await txDone(tx);
    return target && { ...target, wasBlocked };
  }

  function rangeFor(filter) {
    if (filter === 'all') return { index: 'activity', range: null };
    if (filter === 'flagged') return { index: 'flagged_activity', range: IDBKeyRange.bound([1, -Infinity], [1, Infinity]) };
    return { index: 'status_activity', range: IDBKeyRange.bound([filter, -Infinity], [filter, Infinity]) };
  }

  const postIdOf = url => (url || '').match(/\/status\/(\d+)/)?.[1] || '';
  const matchesText = (r, q) => {
    const qid = postIdOf(q);
    if (qid) return postIdOf(r.postUrl) === qid || postIdOf(r.statusUrl) === qid;
    return `${r.handle} ${r.name} ${r.text} ${r.postText || ''} ${r.reason || ''}`.toLowerCase().includes(q);
  };
  const matchesFilter = (r, filter) =>
    filter === 'all' || (filter === 'flagged' ? r.flagged : r.status === filter);

  let searchCache = null;
  function invalidate() {
    searchCache = null;
  }
  async function loadSearchCache() {
    if (!searchCache) {
      searchCache = (async () => {
        const db = await open();
        const recs = await done(db.transaction(OS).objectStore(OS).index('activity').getAll());
        return recs.reverse();
      })();
    }
    return searchCache;
  }

  async function query({ filter = 'all', q = '', page = 1, size = 50 }) {
    const offset = (page - 1) * size;
    if (q) {
      const matched = (await loadSearchCache()).filter(r => matchesFilter(r, filter) && matchesText(r, q));
      return { rows: matched.slice(offset, offset + size), total: matched.length };
    }
    const db = await open();
    const os = db.transaction(OS).objectStore(OS);
    const { index, range } = rangeFor(filter);
    const idx = os.index(index);
    const rows = [];
    const total = await done(filter === 'all' ? os.count() : idx.count(range));
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(range, 'prev');
      let skipped = offset === 0;
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        if (!skipped) {
          skipped = true;
          return c.advance(offset);
        }
        rows.push(c.value);
        if (rows.length >= size) return resolve();
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return { rows, total };
  }

  async function stats() {
    const db = await open();
    const os = db.transaction(OS).objectStore(OS);
    const count = filter => {
      const { index, range } = rangeFor(filter);
      return done(os.index(index).count(range));
    };
    const [total, flagged, blocked, failed] = await Promise.all([
      done(os.count()), count('flagged'), count('blocked'), count('failed')
    ]);
    return { total, flagged, blocked, failed };
  }

  async function today() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const db = await open();
    const recs = await done(db.transaction(OS).objectStore(OS).index('activity').getAll(IDBKeyRange.lowerBound(start.getTime())));
    const checkedToday = recs.filter(r => ms(r.checkedAt) >= start.getTime());
    return {
      checked: checkedToday.length,
      flagged: checkedToday.filter(r => r.flagged).length,
      blocked: recs.filter(r => r.status === 'blocked' && ms(r.blockedAt) >= start.getTime()).length
    };
  }

  async function blockedHandles() {
    const db = await open();
    const idx = db.transaction(OS).objectStore(OS).index('status_activity');
    const recs = await done(idx.getAll(IDBKeyRange.bound(['blocked', -Infinity], ['blocked', Infinity])));
    return [...new Set(recs.map(r => r.handle))];
  }

  async function all() {
    const db = await open();
    return done(db.transaction(OS).objectStore(OS).getAll());
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction(OS, 'readwrite');
    tx.objectStore(OS).clear();
    await txDone(tx);
    invalidate();
  }

  return {
    append, updateStatus, ensureBlocked, markFalsePositive, query, stats, today, blockedHandles, all, clear, invalidate, MAX_RECORDS
  };
})();
