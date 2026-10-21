// Browser-local storage for notes and uploaded documents (IndexedDB).
// Nothing here is sent to the server. Falls back to memory if IndexedDB is unavailable.

const DB_NAME = "unspoken";
const STORES = ["notes", "docs"];

let dbPromise = null;
let memory = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function db() {
  if (memory) return null;
  try {
    dbPromise ??= openDb();
    return await dbPromise;
  } catch {
    memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
    return null;
  }
}

/** True when data will be lost on reload (e.g. private browsing blocked IndexedDB). */
export async function isMemoryOnly() {
  await db();
  return Boolean(memory);
}

function run(database, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function all(storeName) {
  const d = await db();
  if (!d) return [...memory[storeName].values()];
  return run(d, storeName, "readonly", (s) => s.getAll());
}

export async function put(storeName, value) {
  const d = await db();
  if (!d) return void memory[storeName].set(value.id, value);
  await run(d, storeName, "readwrite", (s) => s.put(value));
}

export async function remove(storeName, id) {
  const d = await db();
  if (!d) return void memory[storeName].delete(id);
  await run(d, storeName, "readwrite", (s) => s.delete(id));
}
