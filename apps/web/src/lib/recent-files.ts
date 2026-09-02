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

/** A failure, in the one line a caller can put in front of someone. */
function describe(error: unknown): string {
  return error instanceof DOMException || error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'an unknown error';
}

/**
 * Remembers a handle under a recent entry's key, so the entry can reopen the
 * file later. Resolves to `undefined` when it was stored, and to the **reason**
 * when it was not.
 *
 * It used to resolve to nothing either way, on the grounds that a recent list
 * which cannot reopen is a smaller loss than an error in front of someone who
 * only opened a file. The first half of that still holds — this must not raise
 * an alarm over a file that loaded perfectly — but reporting nothing at all is
 * what made an empty handle store indistinguishable from a browser that had
 * never been asked to store one. The caller decides how loudly to say it; this
 * only has to *know*.
 *
 * **Waiting for the transaction is the substantive fix.** `put` returning is not
 * the value being there: the write is real only once the transaction commits, so
 * a quota failure, a rejected structured clone or an aborted transaction all
 * used to happen after this function had already resolved and closed the
 * connection, with nowhere to report to.
 */
export async function rememberHandle(key: string, handle: unknown): Promise<string | undefined> {
  const database = await openDatabase();
  if (database === undefined) {
    return 'the handle store would not open';
  }
  return new Promise((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(handle, key);
    } catch (error) {
      // A store that is not there, or a handle this browser cannot clone.
      database.close();
      resolve(describe(error));
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(undefined);
    };
    transaction.onerror = () => {
      database.close();
      resolve(describe(transaction.error));
    };
    transaction.onabort = () => {
      database.close();
      resolve(describe(transaction.error));
    };
  });
}

/**
 * Which entries have a handle kept for them, and whether the answer can be
 * trusted.
 *
 * Read in one transaction rather than one per entry, and *before* the menu is
 * drawn: an entry with no handle cannot reopen anything, and offering it as
 * though it could turns a click into an error message.
 *
 * `problem` is the point of the shape. This used to answer an empty set for a
 * store that is missing, a read that failed and a list nothing has been added
 * to yet — three different facts, one indistinguishable answer, and every entry
 * ghosted with the same misleading reason ("this browser kept no handle").
 */
export interface HandleIndex {
  readonly keys: ReadonlySet<string>;
  /** Why the index could not be read. Absent when the answer is trustworthy. */
  readonly problem?: string;
}

export async function keysWithHandles(): Promise<HandleIndex> {
  const database = await openDatabase();
  if (database === undefined) {
    return { keys: new Set(), problem: 'the handle store would not open' };
  }
  return new Promise((resolve) => {
    let request: IDBRequest<IDBValidKey[]>;
    try {
      request = database.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    } catch (error) {
      database.close();
      resolve({ keys: new Set(), problem: describe(error) });
      return;
    }
    request.onsuccess = () => {
      database.close();
      resolve({ keys: new Set(request.result.map(String)) });
    };
    request.onerror = () => {
      database.close();
      resolve({ keys: new Set(), problem: describe(request.error) });
    };
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
