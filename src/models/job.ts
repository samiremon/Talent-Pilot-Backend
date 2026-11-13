/**
 * Job = one role the recruiter is hiring for, e.g. "Senior React Developer".
 *
 * Created from a job description (JD): the AI extracts the fields below, the recruiter
 * checks them on a confirmation card, and only then is the job saved. Everything else
 * (candidates, emails, activity) belongs to a job via its id.
 *
 * Rule: we never invent data. If the JD doesn't say something (e.g. no salary), the
 * field stays empty (null) and the UI shows "Unknown".
 */
import { Schema, model, Types, type InferSchemaType } from 'mongoose';

export const REMOTE_POLICIES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export const JOB_STATUSES = ['active', 'paused', 'closed'] as const;

const jobSchema = new Schema(
  {
    // Short readable number shown as "JOB-0007" (see models/counter.ts). Recruiters and the
    // AI use it to refer to a job ("delete JOB-0007").
    jobNumber: { type: Number, default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, trim: true, maxlength: 200, default: null },

    // What the recruiter gave us: the pasted text and/or the link it came from.
    description: { type: String, required: true, maxlength: 50_000 },
    sourceUrl: { type: String, default: null },

    // Extracted by the AI, confirmed (and maybe edited) by the recruiter.
    mustHaveSkills: { type: [String], default: [] },
    niceToHaveSkills: { type: [String], default: [] },
    seniority: { type: String, trim: true, default: null }, // e.g. "Senior", "Mid-level"
    location: { type: String, trim: true, default: null },
    // Kept as written ("$90-110k", "BDT 2.5L/month") rather than guessing numbers.
    salary: { type: String, trim: true, default: null },
    remotePolicy: { type: String, enum: REMOTE_POLICIES, default: 'unknown' },

    status: { type: String, enum: JOB_STATUSES, default: 'active' },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },

    // Running total of AI tokens used for this job (the "token meter").
    // Updated with $inc after every AI call made for this job (see ai/usage.ts).
    // input = what we sent the AI, output = what it wrote back.
    aiUsage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      calls: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// Newest jobs first is the usual way to list them.
jobSchema.index({ createdAt: -1 });
// No two jobs share a number (jobs created before numbering existed are filled in at startup).
jobSchema.index({ jobNumber: 1 }, { unique: true, partialFilterExpression: { jobNumber: { $type: 'number' } } });

export type Job = InferSchemaType<typeof jobSchema>;
export const JobModel = model('Job', jobSchema);
