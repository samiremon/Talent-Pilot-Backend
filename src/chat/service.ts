/**
 * Chat: saving messages, running the agent, and reading the conversation back.
 * One conversation per recruiter; each message remembers which job was open.
 */
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Types } from 'mongoose';
import type { Ai } from '../ai/client.js';
import { AppError } from '../errors.js';
import { parseId } from '../jobs/service.js';
import { ChatMessageModel, PendingActionModel } from '../models/chat.js';
import { JobModel } from '../models/job.js';
import { presentAction } from './actions.js';
import { runAgent } from './agent.js';

/** How many earlier messages the AI sees (keeps prompts small and the free quota safe). */
const HISTORY_SIZE = 16;

type StoredMessage = {
  _id: unknown;
  role: string;
  text: string;
  jobId?: unknown;
  actionId?: unknown;
  createdAt: Date;
};

/** Messages as the browser sees them, with their card (if any) attached. */
async function present(messages: StoredMessage[]) {
  const actionIds = messages.map((m) => m.actionId).filter(Boolean);
  const actions = await PendingActionModel.find({ _id: { $in: actionIds } }).lean();
  const byId = new Map(actions.map((a) => [String(a._id), presentAction(a)]));
  return messages.map((m) => ({
    id: String(m._id),
    role: m.role,
    text: m.text,
    jobId: m.jobId ? String(m.jobId) : null,
    card: m.actionId ? (byId.get(String(m.actionId)) ?? null) : null,
    createdAt: m.createdAt,
  }));
}

export async function listMessages(userId: string, limit = 100) {
  const rows = await ChatMessageModel.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  return present(rows.reverse());
}

/** Turns saved messages into what the AI model reads (cards described in words). */
async function toModelHistory(rows: StoredMessage[]): Promise<BaseMessage[]> {
  const actions = await PendingActionModel.find({ _id: { $in: rows.map((r) => r.actionId).filter(Boolean) } }).lean();
  const byId = new Map(actions.map((a) => [String(a._id), a]));
  return rows.map((row) => {
    if (row.role === 'user') return new HumanMessage(row.text);
    const action = row.actionId ? byId.get(String(row.actionId)) : undefined;
    const card = action
      ? `\n[Card: ${action.type} "${String((action.payload as { title?: string }).title ?? '')}", status: ${action.status}]`
      : '';
    return new AIMessage(`${row.text}${card}`);
  });
}

export async function sendMessage(ai: Ai, userId: string, text: string, jobId?: string) {
  const jobObjectId = jobId ? parseId(jobId) : null;
  if (jobObjectId && !(await JobModel.exists({ _id: jobObjectId }))) throw AppError.notFound('Job not found');
  const user = new Types.ObjectId(userId);

  // History BEFORE saving the new message, so it isn't sent twice.
  const earlier = (await ChatMessageModel.find({ userId: user }).sort({ createdAt: -1 }).limit(HISTORY_SIZE).lean()).reverse();

  const userMessage = await ChatMessageModel.create({ userId: user, role: 'user', text, jobId: jobObjectId });

  const result = await runAgent({
    ai,
    userId,
    jobId: jobId ?? undefined,
    history: await toModelHistory(earlier),
    text,
  });

  // One assistant bubble for the reply; if the AI proposed something, the card hangs off it
  // (several proposals -> one bubble per extra card).
  const [firstAction, ...moreActions] = result.actionIds;
  const replies = [
    await ChatMessageModel.create({ userId: user, role: 'assistant', text: result.reply, jobId: jobObjectId, actionId: firstAction ?? null }),
  ];
  for (const actionId of moreActions) {
    replies.push(await ChatMessageModel.create({ userId: user, role: 'assistant', text: '', jobId: jobObjectId, actionId }));
  }

  return { messages: await present([userMessage.toObject(), ...replies.map((r) => r.toObject())]), usage: result.usage };
}

/** After Confirm/Cancel, a short note in the chat so the conversation (and the AI) knows. */
export async function addSystemNote(userId: string, text: string, jobId?: string | null) {
  const row = await ChatMessageModel.create({
    userId: new Types.ObjectId(userId),
    role: 'assistant',
    text,
    jobId: jobId ? new Types.ObjectId(jobId) : null,
  });
  const [message] = await present([row.toObject()]);
  return message;
}
