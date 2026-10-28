/**
 * Task persistence (Phase 0 task engine). One storage key only, following
 * the existing `muze.*` pattern in extension/src/storage.ts:
 *
 *   key   'muze.tasks'
 *   value { version: 1, tasks: TaskRecord[] }
 *
 * No other storage key is read or written here. The chrome adapter is for
 * the service worker; the in-memory adapter is exported for tests and for
 * any non-extension host that embeds the runner. Both expose the same
 * TaskStore surface the runner depends on, so the runner never sees
 * chrome APIs directly.
 */
import type { TaskRecord, TaskStore } from "./types.js";
import { cloneJson } from "./types.js";

/** The only storage key this module touches. */
export const TASKS_KEY = "muze.tasks";
export const TASKS_STORE_VERSION = 1;

export interface TasksFileShape {
  version: 1;
  tasks: TaskRecord[];
}

export function emptyTasksFile(): TasksFileShape {
  return { version: TASKS_STORE_VERSION, tasks: [] };
}

/** Normalise whatever is stored into a task list; anything else is treated as empty, never thrown over. */
export function parseTasksFile(value: unknown): TaskRecord[] {
  if (value && typeof value === "object") {
    const shape = value as Partial<TasksFileShape>;
    if (Array.isArray(shape.tasks)) return cloneJson(shape.tasks);
  }
  return [];
}

function wrap(tasks: TaskRecord[]): TasksFileShape {
  return { version: TASKS_STORE_VERSION, tasks: cloneJson(tasks) };
}

/**
 * chrome.storage.local adapter. Throws a clear error when chrome storage
 * is unavailable instead of silently dropping a checkpoint.
 */
export function createChromeTaskStore(): TaskStore {
  const local = globalThis.chrome?.storage?.local;
  if (!local) throw new Error("chrome.storage.local is not available");
  return {
    async load(): Promise<TaskRecord[]> {
      const stored = await local.get(TASKS_KEY);
      return parseTasksFile(stored[TASKS_KEY]);
    },
    async save(tasks: TaskRecord[]): Promise<void> {
      await local.set({ [TASKS_KEY]: wrap(tasks) });
    },
  };
}

/**
 * In-memory adapter. `seed` is cloned, so later mutations of the caller's
 * array cannot corrupt the store, and loads return clones, so a runner
 * mutating its working copy cannot corrupt the store without a save.
 * Exported for tests; the runner's checkpoint rule (persist after every
 * step) is what makes a restart safe, not this adapter.
 */
export function createMemoryTaskStore(seed: TaskRecord[] = []): TaskStore & { snapshot(): TaskRecord[] } {
  let tasks: TaskRecord[] = cloneJson(seed);
  return {
    async load(): Promise<TaskRecord[]> {
      return cloneJson(tasks);
    },
    async save(next: TaskRecord[]): Promise<void> {
      tasks = cloneJson(next);
    },
    snapshot(): TaskRecord[] {
      return cloneJson(tasks);
    },
  };
}
