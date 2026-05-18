import type { ProjectSummary, SwarmProject } from './project';
import { summarizeProject } from './project';
import { decodeProjectBundle, encodeProjectBundle } from './projectBundle';
import { deserializeProject } from './projectSerialization';
import {
  deleteProject as deleteProjectFromStorage,
  listProjectSummaries as listProjectSummariesFromStorage,
  loadProject as loadProjectFromStorage,
  saveProject as saveProjectToStorage,
} from './localProjectStore';

const DB_NAME = 'microbit-swarm-layouts';
const DB_VERSION = 1;
const PROJECTS_STORE = 'projects';
const SUMMARIES_STORE = 'summaries';

interface StoredProjectRecord {
  id: string;
  bundleBytes?: Uint8Array;
  serializedProject?: string;
  updatedAt: string;
}

export interface BrowserProjectStore {
  save(project: SwarmProject): Promise<void>;
  load(projectId: string): Promise<SwarmProject>;
  list(): Promise<ProjectSummary[]>;
  remove(projectId: string): Promise<void>;
}

interface CreateBrowserProjectStoreOptions {
  indexedDbFactory?: IDBFactory;
  storage?: Storage;
}

export function createBrowserProjectStore(
  options: CreateBrowserProjectStoreOptions = {},
): BrowserProjectStore {
  const indexedDbFactory =
    options.indexedDbFactory ??
    (typeof window !== 'undefined' ? window.indexedDB : undefined);
  const storageCandidate =
    options.storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  const storage = isStorageLike(storageCandidate)
    ? storageCandidate
    : createMemoryStorageFallback();

  if (indexedDbFactory) {
    return createIndexedDbStore(indexedDbFactory);
  }

  return {
    save: async (project) => saveProjectToStorage(storage, project),
    load: async (projectId) => loadProjectFromStorage(storage, projectId),
    list: async () => listProjectSummariesFromStorage(storage),
    remove: async (projectId) => deleteProjectFromStorage(storage, projectId),
  };
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

function createIndexedDbStore(indexedDbFactory: IDBFactory): BrowserProjectStore {
  return {
    save: async (project) => {
      const db = await openDb(indexedDbFactory);
      await runTransaction(db, [PROJECTS_STORE, SUMMARIES_STORE], 'readwrite', async (transaction) => {
        const projects = transaction.objectStore(PROJECTS_STORE);
        const summaries = transaction.objectStore(SUMMARIES_STORE);
        const bundleBytes = await encodeProjectBundle(project);
        const record: StoredProjectRecord = {
          id: project.id,
          bundleBytes,
          updatedAt: project.updatedAt,
        };
        projects.put(record);
        summaries.put(summarizeProject(project));
      });
    },

    load: async (projectId) => {
      const db = await openDb(indexedDbFactory);
      const record = await runTransaction(db, PROJECTS_STORE, 'readonly', (transaction) => {
        const projects = transaction.objectStore(PROJECTS_STORE);
        return requestToPromise<StoredProjectRecord | undefined>(projects.get(projectId));
      });

      if (!record) {
        throw new Error(`Project not found: ${projectId}`);
      }

      if (record.bundleBytes instanceof Uint8Array) {
        return decodeProjectBundle(record.bundleBytes);
      }
      if (record.serializedProject) {
        return deserializeProject(record.serializedProject);
      }

      throw new Error(`Stored project is invalid: ${projectId}`);
    },

    list: async () => {
      const db = await openDb(indexedDbFactory);
      const summaries = await runTransaction(db, SUMMARIES_STORE, 'readonly', (transaction) => {
        const summariesStore = transaction.objectStore(SUMMARIES_STORE);
        return requestToPromise<ProjectSummary[]>(
          summariesStore.getAll() as unknown as IDBRequest<ProjectSummary[]>,
        );
      });

      return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    remove: async (projectId) => {
      const db = await openDb(indexedDbFactory);
      await runTransaction(db, [PROJECTS_STORE, SUMMARIES_STORE], 'readwrite', async (transaction) => {
        transaction.objectStore(PROJECTS_STORE).delete(projectId);
        transaction.objectStore(SUMMARIES_STORE).delete(projectId);
      });
    },
  };
}

function openDb(indexedDbFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDbFactory.open(DB_NAME, DB_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SUMMARIES_STORE)) {
        db.createObjectStore(SUMMARIES_STORE, { keyPath: 'id' });
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('Unable to open IndexedDB')));
  });
}

function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  callback: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
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
