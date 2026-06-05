import type { SwarmProject } from './project';
import { decodeProjectBundle, encodeProjectBundle } from './projectBundle';
import { deserializeProject, serializeProject } from './projectSerialization';

const WORKING_COPY_STORAGE_KEY = 'microbit-swarm:working-copy';
const DB_NAME = 'microbit-swarm-working-copy';
const DB_VERSION = 1;
const WORKING_COPY_STORE = 'workingCopy';
const WORKING_COPY_SLOT = 'current';

interface StoredWorkingCopyRecord {
  slot: typeof WORKING_COPY_SLOT;
  bundleBytes?: Uint8Array;
  serializedProject?: string;
}

export interface BrowserWorkingCopyStore {
  save(project: SwarmProject): Promise<void>;
  load(): Promise<SwarmProject | undefined>;
  clear(): Promise<void>;
}

interface CreateBrowserWorkingCopyStoreOptions {
  indexedDbFactory?: IDBFactory;
  storage?: Storage;
}

export function createBrowserWorkingCopyStore(
  options: CreateBrowserWorkingCopyStoreOptions = {},
): BrowserWorkingCopyStore {
  const indexedDbFactory =
    options.indexedDbFactory ??
    (typeof window !== 'undefined' ? window.indexedDB : undefined);
  const storageCandidate =
    options.storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (indexedDbFactory) {
    return createIndexedDbStore(indexedDbFactory);
  }
  if (isStorageLike(storageCandidate)) {
    return createStorageStore(storageCandidate);
  }
  return createStorageStore(createMemoryStorageFallback());
}

function isStorageLike(value: unknown): value is Storage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Storage>;
  return (
    typeof candidate.getItem === 'function' &&
    typeof candidate.setItem === 'function' &&
    typeof candidate.removeItem === 'function'
  );
}

function createMemoryStorageFallback(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function createStorageStore(storage: Storage): BrowserWorkingCopyStore {
  return {
    save: async (project) => {
      storage.setItem(WORKING_COPY_STORAGE_KEY, serializeProject(project));
    },
    load: async () => {
      const serialized = storage.getItem(WORKING_COPY_STORAGE_KEY);
      return serialized === null ? undefined : deserializeProject(serialized);
    },
    clear: async () => {
      storage.removeItem(WORKING_COPY_STORAGE_KEY);
    },
  };
}

function createIndexedDbStore(indexedDbFactory: IDBFactory): BrowserWorkingCopyStore {
  return {
    save: async (project) => {
      const db = await openDb(indexedDbFactory);
      await runTransaction(db, WORKING_COPY_STORE, 'readwrite', async (transaction) => {
        const bundleBytes = await encodeProjectBundle(project);
        transaction.objectStore(WORKING_COPY_STORE).put({
          slot: WORKING_COPY_SLOT,
          bundleBytes,
        } satisfies StoredWorkingCopyRecord);
      });
    },
    load: async () => {
      const db = await openDb(indexedDbFactory);
      const record = await runTransaction(db, WORKING_COPY_STORE, 'readonly', (transaction) =>
        requestToPromise<StoredWorkingCopyRecord | undefined>(
          transaction.objectStore(WORKING_COPY_STORE).get(WORKING_COPY_SLOT),
        ),
      );

      if (!record) {
        return undefined;
      }
      if (record.bundleBytes instanceof Uint8Array) {
        return decodeProjectBundle(record.bundleBytes);
      }
      if (record.serializedProject) {
        return deserializeProject(record.serializedProject);
      }
      throw new Error('Stored working copy is invalid');
    },
    clear: async () => {
      const db = await openDb(indexedDbFactory);
      await runTransaction(db, WORKING_COPY_STORE, 'readwrite', async (transaction) => {
        transaction.objectStore(WORKING_COPY_STORE).delete(WORKING_COPY_SLOT);
      });
    },
  };
}

function openDb(indexedDbFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDbFactory.open(DB_NAME, DB_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORKING_COPY_STORE)) {
        db.createObjectStore(WORKING_COPY_STORE, { keyPath: 'slot' });
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('Unable to open IndexedDB')));
  });
}

function runTransaction<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  callback: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    let settled = false;
    let callbackResult: Promise<T>;

    try {
      callbackResult = Promise.resolve(callback(transaction));
    } catch (error) {
      settled = true;
      reject(error);
      return;
    }

    callbackResult
      .then((value) => {
        transaction.addEventListener('complete', () => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        });
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          reject(error);
          transaction.abort();
        }
      });

    transaction.addEventListener('abort', () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      }
    });
    transaction.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      }
    });
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')));
  });
}
