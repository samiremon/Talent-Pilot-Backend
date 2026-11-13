/**
 * The app's single live stream: one subscription gets the task updates of EVERY job
 * (so the browser needs only one connection, however many progress bars are on screen).
 */
import { describe, expect, it } from 'vitest';
import { ALL_JOBS, createMemoryEvents, type TaskEvent } from '../src/tasks/events.js';

describe('task events', () => {
  it('delivers each job\'s events to that job, and all of them to the "all jobs" stream', async () => {
    const events = createMemoryEvents();
    const all: string[] = [];
    const jobA: string[] = [];
    const stopAll = events.subscribe(ALL_JOBS, (e: TaskEvent) => all.push(e.jobId));
    events.subscribe('A', (e: TaskEvent) => jobA.push(e.jobId));
    await events.publish({ jobId: 'A', task: {} });
    await events.publish({ jobId: 'B', task: {} });
    expect(all).toEqual(['A', 'B']);
    expect(jobA).toEqual(['A']);
    stopAll();
    await events.publish({ jobId: 'C', task: {} });
    expect(all).toEqual(['A', 'B']); // stopped listening
  });
});
