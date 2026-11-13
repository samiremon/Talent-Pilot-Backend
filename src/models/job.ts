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

    // Running total of what the AI has cost for this job (the "cost meter").
    // Updated with $inc every time an AI call is made for this job.
    aiUsage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      costUsd: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// Newest jobs first is the usual way to list them.
jobSchema.index({ createdAt: -1 });

export type Job = InferSchemaType<typeof jobSchema>;
export const JobModel = model('Job', jobSchema);
