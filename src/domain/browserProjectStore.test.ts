import { createBlankProject, type SwarmProject } from './project';
import { createBrowserProjectStore } from './browserProjectStore';

describe('browserProjectStore fallback', () => {
  it('saves, lists, loads, and removes projects via storage fallback', async () => {
    const store = createBrowserProjectStore({
      indexedDbFactory: undefined,
      storage: createMemoryStorage(),
    });
    const project = makeProject('layout-1', 'Layout one', '2026-05-18T01:00:00.000Z');

    await store.save(project);
    const summaries = await store.list();
    expect(summaries).toEqual([
      {
        id: 'layout-1',
        name: 'Layout one',
        deviceCount: 1,
        artifactCount: 1,
        updatedAt: '2026-05-18T01:00:00.000Z',
      },
    ]);
    expect(await store.load('layout-1')).toEqual(project);

    await store.remove('layout-1');
    expect(await store.list()).toEqual([]);
  });

  it('preserves locked devices without editable source through storage fallback', async () => {
    const store = createBrowserProjectStore({
      indexedDbFactory: undefined,
      storage: createMemoryStorage(),
    });
    const project = makeProject('layout-locked', 'Locked layout', '2026-05-18T01:10:00.000Z', true);

    await store.save(project);

    await expect(store.load('layout-locked')).resolves.toMatchObject({
      devices: [
        {
          id: 'layout-locked-device',
          locked: true,
          positionLocked: true,
          programArtifactId: 'layout-locked-artifact',
        },
      ],
    });
  });

  it('preserves custom instructions through storage fallback', async () => {
    const store = createBrowserProjectStore({
      indexedDbFactory: undefined,
      storage: createMemoryStorage(),
    });
    const project = {
      ...makeProject('layout-instructions', 'Lesson layout', '2026-05-18T01:20:00.000Z'),
      instructionsMarkdown: '# Instructions\n\n- Step one',
    } satisfies SwarmProject;

    await store.save(project);

    await expect(store.load('layout-instructions')).resolves.toEqual(project);
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

function encodeBase64Text(value: string): string {
  return btoa(value);
}

function makeProject(id: string, name: string, now: string, locked = false): SwarmProject {
  return {
    ...createBlankProject({ id, name, now }),
    artifacts: [
      {
        id: `${id}-artifact`,
        name: 'sample.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        program: {
          runtimeSource: 'micropython',
          filesystemBase64: {
            'main.py': encodeBase64Text('display.scroll("ok")'),
          },
        },
        createdAt: now,
      },
    ],
    devices: [
      {
        id: `${id}-device`,
        name: 'Node',
        ...(locked ? { locked: true } : {}),
        ...(locked ? { positionLocked: true } : {}),
        position: { x: 20, y: 30 },
        programArtifactId: `${id}-artifact`,
      },
    ],
  };
}
