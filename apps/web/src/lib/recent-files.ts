/**
 * The files the text panel has been shown, most recent first.
 *
 * Two halves, because a browser gives them separately. The **list** is plain
 * data and goes in `localStorage`, so the names survive a reload. The **handles**
 * are `FileSystemFileHandle`s, which cannot be JSON but can be structured-cloned
 * into IndexedDB — and a handle is what makes an entry worth clicking, since it
 * reopens the file without a picker.
 *
 * Where the File System Access API is missing the handles are simply absent, and
 * the list becomes a history rather than a set of shortcuts. That is said in the
 * UI rather than hidden: an entry that cannot reopen is shown as what it is.
 */

const STORAGE_KEY = 'isaac.recentFiles.v1';
const DATABASE = 'isaac';
const STORE = 'recent-file-handles';
/** Enough to be useful, few enough to scan. */
const LIMIT = 12;

export interface RecentFile {
  /** The key a handle is stored under, and React's key. */
  readonly key: string;
  readonly name: string;
  /** Milliseconds since the epoch, so the list can be ordered and dated. */
  readonly openedAt: number;
}

export function readRecents(raw: string | null): RecentFile[] {
  if (raw === null || raw === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const kept: RecentFile[] = [];
  for (const entry of parsed) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as RecentFile).key === 'string' &&
      typeof (entry as RecentFile).name === 'string' &&
      typeof (entry as RecentFile).openedAt === 'number'
    ) {
      kept.push({
        key: (entry as RecentFile).key,
        name: (entry as RecentFile).name,
        openedAt: (entry as RecentFile).openedAt,
      });
    }
  }
  return kept.slice(0, LIMIT);
}

/**
 * The list with one file at the front.
 *
 * Keyed by **name**, so opening the same file twice moves it up rather than
 * listing it twice — which is what a "recent" list means, and what keeps a
 * handle from being orphaned in the database under a key nothing points at.
 */
export function withRecent(recents: readonly RecentFile[], name: string, at: number): RecentFile[] {
  const key = `file:${name}`;
  return [{ key, name, openedAt: at }, ...recents.filter((one) => one.key !== key)].slice(0, LIMIT);
}

export function loadRecents(): RecentFile[] {
  try {
    return readRecents(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveRecents(recents: readonly RecentFile[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    // Private window, quota, blocked storage: the session is unaffected.
  }
}

/** Opens (and upgrades) the handle store. Resolves to `undefined` where IndexedDB is not usable. */
function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = window.indexedDB.open(DATABASE, 1);
    } catch {
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

/**
 * Remembers a handle under a recent entry's key, so the entry can reopen the
 * file later. Silent on failure: a recent list that cannot reopen is a smaller
 * loss than an error in front of someone who only opened a file.
 */
export async function rememberHandle(key: string, handle: unknown): Promise<void> {
  const database = await openDatabase();
  if (database === undefined) {
    return;
  }
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(handle, key);
  } catch {
    // A handle that cannot be cloned — an older browser — is simply not kept.
  } finally {
    database.close();
  }
}

/** The handle for a recent entry, if one was kept and can still be read. */
export async function recallHandle(key: string): Promise<FileSystemFileHandle | undefined> {
  const database = await openDatabase();
  if (database === undefined) {
    return undefined;
  }
  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => {
        database.close();
        resolve((request.result as FileSystemFileHandle | undefined) ?? undefined);
      };
      request.onerror = () => {
        database.close();
        resolve(undefined);
      };
    } catch {
      database.close();
      resolve(undefined);
    }
  });
}

/**
 * Reads a remembered handle, asking for permission if the browser has forgotten
 * it. A handle stored yesterday needs the user's word again today, which is the
 * price of being able to reopen at all.
 */
export async function readHandle(handle: FileSystemFileHandle): Promise<File | undefined> {
  const permission = handle as unknown as {
    queryPermission?: (options: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (options: { mode: string }) => Promise<PermissionState>;
  };
  try {
    const already = await permission.queryPermission?.({ mode: 'read' });
    if (already !== 'granted') {
      const asked = await permission.requestPermission?.({ mode: 'read' });
      if (asked !== 'granted') {
        return undefined;
      }
    }
    return await handle.getFile();
  } catch {
    return undefined;
  }
}
