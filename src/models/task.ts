/**
 * Task = one piece of slow background work, e.g. "score the 23 new candidates of JOB-0002".
 *
 * The flow:
 *   1. The API creates a Task (status "queued") and puts a message on the BullMQ queue.
 *   2. The worker process picks it up ("running"), updates `progress` as it goes, and
 *      finishes with "done" (or "failed" after its retries ran out).
 *   3. Every update is also pushed to the browser live (see tasks/events.ts), so the job
 *      page and the chat show "Scoring… 15 of 23" without refreshing.
 *
 * Kept in MongoDB (not only in Redis) so the history survives restarts and pages can show
 * the latest task of a job at any time.
 */
import { Schema, model, Types, type InferSchemaType } from 'mongoose';

export const TASK_TYPES = ['score_candidates', 'source_candidates'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const taskSchema = new Schema(
  {
    jobId: { type: Types.ObjectId, ref: 'Job', required: true, index: true },
    type: { type: String, enum: TASK_TYPES, required: true },
    status: { type: String, enum: TASK_STATUSES, default: 'queued' },
    // Who started it (null = the system).
    userId: { type: Types.ObjectId, ref: 'User', default: null },
    // Counters shown to the recruiter. Not every task uses every counter.
    progress: {
      total: { type: Number, default: 0 }, // e.g. candidates to score
      done: { type: Number, default: 0 }, // e.g. candidates scored so far
      found: { type: Number, default: 0 }, // e.g. profiles found by the web search
      duplicates: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    // A short human sentence: "Scored 15 of 23", "Done: 23 candidates scored".
    message: { type: String, default: 'Waiting to start…' },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

taskSchema.index({ jobId: 1, createdAt: -1 });

export type Task = InferSchemaType<typeof taskSchema>;
export const TaskModel = model('Task', taskSchema);
