import { createBlankProject, type SwarmProject } from './project';
import { createBrowserWorkingCopyStore } from './browserWorkingCopyStore';

describe('browserWorkingCopyStore fallback', () => {
  it('saves, loads, and clears a working copy via storage fallback', async () => {
    const store = createBrowserWorkingCopyStore({
      indexedDbFactory: undefined,
      storage: createMemoryStorage(),
    });
    const project = makeProject('working-copy-1', 'Working copy', '2026-06-06T01:00:00.000Z');

    await expect(store.load()).resolves.toBeUndefined();

    await store.save(project);
    await expect(store.load()).resolves.toEqual(project);

    await store.clear();
    await expect(store.load()).resolves.toBeUndefined();
  });
});

function createMemoryStorage(): Storage {
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

function makeProject(id: string, name: string, now: string): SwarmProject {
  return {
    ...createBlankProject({ id, name, now }),
    artifacts: [
      {
        id: `${id}-artifact`,
        name: 'sample.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: new Uint8Array([1, 2, 3]),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: `${id}-device`,
        name: 'Node',
        position: { x: 20, y: 30 },
        programArtifactId: `${id}-artifact`,
      },
    ],
  };
}
