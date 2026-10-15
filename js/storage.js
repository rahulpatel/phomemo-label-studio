// Templates live in IndexedDB (they can contain large embedded images);
// small settings live in localStorage.

const DB_NAME = 'label-studio';
const STORE = 'templates';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const templates = {
  all: () => run('readonly', (s) => s.getAll()),
  put: (t) => run('readwrite', (s) => s.put(t)),
  delete: (id) => run('readwrite', (s) => s.delete(id)),
};

export function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`label-studio:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  localStorage.setItem(`label-studio:${key}`, JSON.stringify(value));
}
