/**
 * The files Isaac has opened, most recent first — the app bar's lens files and
 * the text panel's documents in one list, because they are one question ("what
 * have I had open?") and a file inspected in one is very often the file wanted
 * in the other. Each consumer filters the list to what *it* can open.
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
/**
 * What is *stored*, which is deliberately more than any menu shows. The list is
 * shared and each menu filters it, so a run of text files must not be able to
 * push every `.zmx` out of the app bar's ten.
 */
const LIMIT = 30;

/** What a menu *shows*: enough to be useful, few enough to scan without one. */
export const MENU_LIMIT = 10;

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

/**
 * The entries the app bar can act on. It loads a design, so a `.txt` the text
 * panel opened is not one of them — offering it would promise a lens file where
 * there is none, and the failure would arrive after the click.
 */
export function lensFileRecents(recents: readonly RecentFile[]): RecentFile[] {
  return recents.filter((one) => /\.zmx$/i.test(one.name)).slice(0, MENU_LIMIT);
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

/**
 * Which entries have a handle kept for them, in one read rather than one per
 * entry. A menu needs this *before* it is drawn: an entry with no handle cannot
 * reopen anything, and offering it as though it could turns a click into an
 * error message.
 */
export async function keysWithHandles(): Promise<ReadonlySet<string>> {
  const database = await openDatabase();
  if (database === undefined) {
    return new Set();
  }
  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      request.onsuccess = () => {
        database.close();
        resolve(new Set(request.result.map(String)));
      };
      request.onerror = () => {
        database.close();
        resolve(new Set());
      };
    } catch {
      database.close();
      resolve(new Set());
    }
  });
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
