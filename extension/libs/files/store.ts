/**
 * Known limitation, deliberately NOT changed in this pass: files are stored
 * unencrypted in IndexedDB and there is no per-client isolation — any client
 * the policy allows to use files.* can list every attached file. Adding
 * encryption or per-client scoping is a separate user decision; it would
 * also change what the files.* tools can return, so it is not smuggled in
 * here. Cap: 25 MiB per file (MAX_FILE_SIZE), enforced in putFile.
 *
 * The database name below is a persisted storage key, kept unchanged for
 * compatibility with existing installs even though new identifiers in this
 * codebase use the "muze" prefix; renaming it would orphan stored files.
 */
const DB_NAME = "uabb-files";
const STORE_NAME = "files";
const DB_VERSION = 1;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: ArrayBuffer;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putFile(file: StoredFile): Promise<void> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`);
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(file);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result as StoredFile | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function listFiles(): Promise<Array<Omit<StoredFile, "data">>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    // Cursor iteration, not getAll(): getAll materialised every file's
    // full ArrayBuffer at once and only then stripped `data` from the
    // returned metadata, so listing N files held N buffers in memory.
    // A cursor still reads each record's value as it advances, but the
    // buffer is dropped before moving on, so peak memory is one file,
    // not the whole store. (A metadata-only read would need a second
    // store or a schema bump; the cursor keeps the v1 schema intact.)
    const tx = db.transaction(STORE_NAME, "readonly");
    const items: Array<Omit<StoredFile, "data">> = [];
    const req = tx.objectStore(STORE_NAME).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        items.sort((a, b) => b.createdAt - a.createdAt);
        resolve(items);
        return;
      }
      const { data, ...rest } = cursor.value as StoredFile;
      void data;
      items.push(rest);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function removeFile(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

