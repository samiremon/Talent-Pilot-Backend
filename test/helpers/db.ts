/**
 * Test helper: starts a throwaway in-memory MongoDB for one test file and wipes it
 * between tests. Call `useTestDatabase()` once at the top of a test file.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';

export function useTestDatabase(): void {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    // Build the unique indexes now: duplicate protection depends on them existing.
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
  });
}
