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
import { UserModel } from '../models/user.js';
import { presentAction } from './actions.js';
import { runAgent } from './agent.js';

/**
 * CONTEXT-WINDOW BUDGET for the conversation the AI sees:
 *   - newest messages first, until about HISTORY_TOKEN_BUDGET tokens are used (≈4 chars/token)
 *   - never more than HISTORY_MAX_MESSAGES
 *   - long OLD messages (pasted job descriptions...) are shortened to a one-line note;
 *     the full text stays in the database and the JD tool still reads it
 */
const HISTORY_TOKEN_BUDGET = 3000;
const HISTORY_MAX_MESSAGES = 30;
const LONG_MESSAGE_CHARS = 600;

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

/** A long old message becomes a short note (saves thousands of tokens per turn). */
export function shortenForHistory(text: string): string {
  if (text.length <= LONG_MESSAGE_CHARS) return text;
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `[Long message shortened to save space: ${text.length} characters, starting "${preview}…"]`;
}

/**
 * Turns saved messages (oldest first) into what the AI model reads: cards described in
 * words, long messages shortened, and only as many recent messages as fit the budget.
 */
export async function toModelHistory(rows: StoredMessage[]): Promise<BaseMessage[]> {
  const actions = await PendingActionModel.find({ _id: { $in: rows.map((r) => r.actionId).filter(Boolean) } }).lean();
  const byId = new Map(actions.map((a) => [String(a._id), a]));

  const asText = rows.map((row) => {
    if (row.role === 'user') return { role: 'user' as const, text: shortenForHistory(row.text) };
    const action = row.actionId ? byId.get(String(row.actionId)) : undefined;
    const card = action
      ? `\n[Card: ${action.type} "${String((action.payload as { title?: string }).title ?? '')}", status: ${action.status}]`
      : '';
    return { role: 'assistant' as const, text: `${shortenForHistory(row.text)}${card}` };
  });

  // Walk back from the newest message, keeping messages while they fit the budget.
  const kept: typeof asText = [];
  let tokens = 0;
  for (let i = asText.length - 1; i >= 0 && kept.length < HISTORY_MAX_MESSAGES; i--) {
    const cost = Math.ceil(asText[i]!.text.length / 4);
    if (tokens + cost > HISTORY_TOKEN_BUDGET) break;
    tokens += cost;
    kept.unshift(asText[i]!);
  }
  // Start on a recruiter message: a reply without its question would confuse the model.
  while (kept.length && kept[0]!.role !== 'user') kept.shift();

  return kept.map((m) => (m.role === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)));
}

export async function sendMessage(ai: Ai, userId: string, text: string, jobId?: string) {
  const jobObjectId = jobId ? parseId(jobId) : null;
  if (jobObjectId && !(await JobModel.exists({ _id: jobObjectId }))) throw AppError.notFound('Job not found');
  const user = new Types.ObjectId(userId);

  // History BEFORE saving the new message, so it isn't sent twice.
  const earlier = (await ChatMessageModel.find({ userId: user }).sort({ createdAt: -1 }).limit(HISTORY_MAX_MESSAGES).lean()).reverse();
  const me = await UserModel.findById(user, { name: 1 }).lean();

  const userMessage = await ChatMessageModel.create({ userId: user, role: 'user', text, jobId: jobObjectId });

  const result = await runAgent({
    ai,
    userId,
    userName: me?.name ?? 'the recruiter',
    jobId: jobId ?? undefined,
    history: await toModelHistory(earlier),
    // Full, unshortened texts (newest first) for the job-description tool.
    recentUserTexts: earlier.filter((m) => m.role === 'user').map((m) => m.text).reverse(),
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
