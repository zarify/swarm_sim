import { createBlankProject, type SwarmProject } from './project';
import { deleteProject, listProjectSummaries, loadProject, saveProject } from './localProjectStore';

describe('local project store', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it('saves, lists, and loads a project from browser storage', () => {
    const project = makeProject('project-1', 'Swarm one', '2026-05-16T04:20:00.000Z');

    saveProject(storage, project);

    expect(listProjectSummaries(storage)).toEqual([
      {
        id: 'project-1',
        name: 'Swarm one',
        deviceCount: 1,
        artifactCount: 1,
        updatedAt: '2026-05-16T04:20:00.000Z',
      },
    ]);
    expect(loadProject(storage, 'project-1')).toEqual(project);
  });

  it('keeps the newest project first in the index', () => {
    saveProject(storage, makeProject('older', 'Older', '2026-05-16T04:20:00.000Z'));
    saveProject(storage, makeProject('newer', 'Newer', '2026-05-16T04:21:00.000Z'));

    expect(listProjectSummaries(storage).map((summary) => summary.id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('deletes stored projects and index entries', () => {
    saveProject(storage, makeProject('project-1', 'Swarm one', '2026-05-16T04:20:00.000Z'));

    deleteProject(storage, 'project-1');

    expect(listProjectSummaries(storage)).toEqual([]);
    expect(() => loadProject(storage, 'project-1')).toThrow('Project not found: project-1');
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

function makeProject(id: string, name: string, updatedAt: string): SwarmProject {
  return {
    ...createBlankProject({ id, name, now: updatedAt }),
    updatedAt,
    artifacts: [
      {
        id: `${id}-artifact`,
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: new Uint8Array([10, 20, 30]),
        createdAt: updatedAt,
      },
    ],
    devices: [
      {
        id: `${id}-device`,
        name: 'Beacon',
        position: { x: 10, y: 20 },
        programArtifactId: `${id}-artifact`,
      },
    ],
  };
}
