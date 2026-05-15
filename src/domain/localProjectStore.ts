import type { ProjectSummary, SwarmProject } from './project';
import { deserializeProject, serializeProject } from './projectSerialization';
import { summarizeProject } from './project';

const PROJECT_INDEX_KEY = 'microbit-swarm:project-index';
const PROJECT_KEY_PREFIX = 'microbit-swarm:project:';

export function saveProject(storage: Storage, project: SwarmProject): void {
  storage.setItem(projectKey(project.id), serializeProject(project));
  const summaries = listProjectSummaries(storage).filter((summary) => summary.id !== project.id);
  summaries.push(summarizeProject(project));
  summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  storage.setItem(PROJECT_INDEX_KEY, JSON.stringify(summaries));
}

export function loadProject(storage: Storage, projectId: string): SwarmProject {
  const serialized = storage.getItem(projectKey(projectId));

  if (serialized === null) {
    throw new Error(`Project not found: ${projectId}`);
  }

  return deserializeProject(serialized);
}

export function listProjectSummaries(storage: Storage): ProjectSummary[] {
  const serialized = storage.getItem(PROJECT_INDEX_KEY);

  if (serialized === null) {
    return [];
  }

  const parsed: unknown = JSON.parse(serialized);

  if (!Array.isArray(parsed)) {
    throw new Error('Project index is invalid');
  }

  return parsed.map(parseProjectSummary);
}

export function deleteProject(storage: Storage, projectId: string): void {
  storage.removeItem(projectKey(projectId));
  const summaries = listProjectSummaries(storage).filter((summary) => summary.id !== projectId);
  storage.setItem(PROJECT_INDEX_KEY, JSON.stringify(summaries));
}

function parseProjectSummary(value: unknown): ProjectSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Project summary is invalid');
  }

  const summary = value as Record<string, unknown>;

  if (
    typeof summary.id !== 'string' ||
    typeof summary.name !== 'string' ||
    typeof summary.deviceCount !== 'number' ||
    typeof summary.artifactCount !== 'number' ||
    typeof summary.updatedAt !== 'string'
  ) {
    throw new Error('Project summary is invalid');
  }

  return {
    id: summary.id,
    name: summary.name,
    deviceCount: summary.deviceCount,
    artifactCount: summary.artifactCount,
    updatedAt: summary.updatedAt,
  };
}

function projectKey(projectId: string): string {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}
