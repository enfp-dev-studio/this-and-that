// Everything the app keeps stays in this browser: records (images, jobs,
// traces, part tags, sessions with their versions and references, 3D models)
// in IndexedDB, and the big blobs (pictures, results, voice, videos) in the
// origin private file system, or IndexedDB where OPFS is missing. There is no
// server state. Writes are best effort: a full disk never breaks an edit.

const DB_NAME = 'this-and-that';
const STORES = ['images', 'jobs', 'traces', 'parts', 'sessions', 'models', 'blobs'] as const;
export type StoreName = (typeof STORES)[number];

let db: Promise<IDBDatabase> | null = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

function tx<R>(store: StoreName, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<R>) {
  return open().then(
    (d) =>
      new Promise<R>((resolve, reject) => {
        const req = f(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

const warn = (what: string) => (e: unknown) => console.warn(`[store] ${what}:`, e);

export const put = (store: StoreName, value: { id: string } & Record<string, unknown>) => tx(store, 'readwrite', (s) => s.put(value)).catch(warn(`put ${store}`));
export const get = <T>(store: StoreName, id: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>).catch(() => undefined);
export const all = <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>).catch(() => [] as T[]);

// ---------- blobs ----------

const opfs: Promise<FileSystemDirectoryHandle | null> = (async () => {
  try {
    const root = await navigator.storage.getDirectory();
    // Main-thread writes need createWritable (Chrome, Edge, Firefox; Safari 26).
    const probe = await root.getFileHandle('.probe', { create: true });
    if (!('createWritable' in probe)) return null;
    return root;
  } catch {
    return null;
  }
})();

async function fileAt(path: string, create: boolean) {
  const root = await opfs;
  if (!root) return null;
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts.at(-1)!, { create });
}

export async function saveBlob(path: string, blob: Blob) {
  try {
    const file = await fileAt(path, true);
    if (!file) return void (await put('blobs', { id: path, blob }));
    const w = await file.createWritable();
    await w.write(blob);
    await w.close();
  } catch (e) {
    warn(`save ${path}`)(e);
  }
}

export async function loadBlob(path: string): Promise<Blob | null> {
  try {
    const file = await fileAt(path, false);
    if (file) return await file.getFile();
    return (await get<{ blob: Blob }>('blobs', path))?.blob ?? null;
  } catch {
    return null;
  }
}

// Ask the browser not to evict what we keep (granted silently for installed
// or often-used sites in Chrome; Firefox asks).
export const persisted = (async () => {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
})();
