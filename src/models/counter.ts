/**
 * Counters for short, readable ids like JOB-0001, JOB-0002, ...
 *
 * MongoDB's own ids (6af70df9c37293656ba5b8dd) are unique but hard to read or say out
 * loud. A counter document per sequence ("job") is increased atomically with $inc, so
 * two jobs created at the same moment can never get the same number.
 */
import { Schema, model } from 'mongoose';

const counterSchema = new Schema({
  _id: { type: String, required: true }, // the sequence name, e.g. "job"
  seq: { type: Number, default: 0 },
});

export const CounterModel = model('Counter', counterSchema);

/** Returns the next number in a sequence: 1, 2, 3, ... (atomic, safe under concurrency). */
export async function nextSequence(name: string): Promise<number> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }, // creates the counter the first time
  ).lean();
  return counter!.seq;
}

/** 7 -> "JOB-0007" (more digits once past 9999). */
export function jobCode(jobNumber: number | null | undefined): string | null {
  return typeof jobNumber === 'number' ? `JOB-${String(jobNumber).padStart(4, '0')}` : null;
}
