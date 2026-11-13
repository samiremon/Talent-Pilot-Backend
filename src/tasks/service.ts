/**
 * Creating tasks, reporting their progress, and reading them back.
 * Every change is saved to MongoDB AND announced live (tasks/events.ts).
 */
import { Types } from 'mongoose';
import { TaskModel, type TaskStatus, type TaskType } from '../models/task.js';
import type { TaskEvents } from './events.js';

type TaskDoc = {
  _id: unknown;
  jobId: unknown;
  type: string;
  status: string;
  progress?: { total?: number; done?: number; found?: number; duplicates?: number; failed?: number } | null;
  message: string;
  error?: string | null;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

/** The task as the browser sees it. */
export function presentTask(task: TaskDoc) {
  const p = task.progress ?? {};
  return {
    id: String(task._id),
    jobId: String(task.jobId),
    type: task.type,
    status: task.status,
    progress: { total: p.total ?? 0, done: p.done ?? 0, found: p.found ?? 0, duplicates: p.duplicates ?? 0, failed: p.failed ?? 0 },
    message: task.message,
    error: task.error ?? null,
    createdAt: task.createdAt ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
  };
}
export type PresentedTask = ReturnType<typeof presentTask>;

export async function createTask(
  events: TaskEvents,
  { jobId, type, userId, total = 0, message = 'Waiting to start…' }: { jobId: string; type: TaskType; userId?: string | null; total?: number; message?: string },
) {
  const task = await TaskModel.create({
    jobId: new Types.ObjectId(jobId),
    type,
    userId: userId ? new Types.ObjectId(userId) : null,
    progress: { total },
    message,
  });
  const presented = presentTask(task.toObject());
  await events.publish({ jobId, task: presented });
  return presented;
}

/** Updates a task (status / progress counters / message) and announces it. */
export async function updateTask(
  events: TaskEvents,
  taskId: string,
  changes: {
    status?: TaskStatus;
    message?: string;
    error?: string | null;
    progress?: Partial<{ total: number; done: number; found: number; duplicates: number; failed: number }>;
    attempts?: number;
  },
) {
  const set: Record<string, unknown> = {};
  if (changes.status) {
    set.status = changes.status;
    if (changes.status === 'running') set.startedAt = new Date();
    if (changes.status === 'done' || changes.status === 'failed') set.finishedAt = new Date();
  }
  if (changes.message !== undefined) set.message = changes.message;
  if (changes.error !== undefined) set.error = changes.error;
  if (changes.attempts !== undefined) set.attempts = changes.attempts;
  for (const [key, value] of Object.entries(changes.progress ?? {})) set[`progress.${key}`] = value;

  const task = await TaskModel.findByIdAndUpdate(taskId, { $set: set }, { new: true }).lean();
  if (!task) return null;
  const presented = presentTask(task);
  await events.publish({ jobId: presented.jobId, task: presented });
  return presented;
}

export async function listTasks(jobId: string, limit = 10) {
  const rows = await TaskModel.find({ jobId: new Types.ObjectId(jobId) }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map(presentTask);
}
