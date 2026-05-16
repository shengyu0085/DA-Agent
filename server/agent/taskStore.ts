import type { AgentEvent } from '../types/events';

export type TaskState = {
  id: string;
  uploadId: string;
  filePath: string;
  fileName: string;
  requirement: string;
  events: AgentEvent[];
  abortController?: AbortController;
  cancelled?: boolean;
  startedAt: number;
  finishedAt?: number;
};

const tasks = new Map<string, TaskState>();
const uploadPaths = new Map<string, { filePath: string; fileName: string }>();

export function rememberUpload(uploadId: string, filePath: string, fileName: string): void {
  uploadPaths.set(uploadId, { filePath, fileName });
}

export function getUpload(uploadId: string) {
  return uploadPaths.get(uploadId);
}

export function createTask(state: TaskState): void {
  tasks.set(state.id, state);
}

export function getTask(taskId: string): TaskState | undefined {
  return tasks.get(taskId);
}

export function cancelTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.finishedAt) return false;
  task.cancelled = true;
  task.abortController?.abort();
  return true;
}

export function pushTaskEvent(taskId: string, event: AgentEvent): void {
  const task = tasks.get(taskId);
  if (!task) return;
  task.events.push(event);
  if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
    task.finishedAt = Date.now();
  }
}
