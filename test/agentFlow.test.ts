/**
 * How the chat agent uses its AI calls (with a scripted fake AI, no Groq needed):
 *   - after a card tool, it STOPS: one AI call, reply = the tool's intro + the footer
 *     (no second call that would re-send the whole prompt just to say the same thing)
 *   - after a lookup tool, the AI gets the result and writes the answer (two calls)
 *   - a card tool that couldn't make a card ("which one?") also goes back to the AI
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { Ai } from '../src/ai/client.js';
import { DELETE_CARD_FOOTER, runAgent } from '../src/chat/agent.js';
import { CandidateModel } from '../src/models/candidate.js';
import { JobModel } from '../src/models/job.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

/** A fake AI that answers with the scripted messages in order, and remembers what it was sent. */
function scriptedAi(script: AIMessage[]) {
  const seen: BaseMessage[][] = [];
  const model = {
    bindTools: () => ({
      invoke: async (messages: BaseMessage[]) => {
        seen.push(messages);
        const next = script.shift();
        if (!next) throw new Error('The fake AI was called more times than scripted');
        return next;
      },
    }),
  };
  const ai = { mode: 'live', models: { agent: 'fake', bulk: 'fake', safety: 'fake' }, chatModel: () => model } as unknown as Ai;
  return { ai, seen };
}

const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id: `call_${name}`, type: 'tool_call' }] });

async function setup() {
  const job = await JobModel.create({ title: 'Dev', description: 'x'.repeat(40), createdBy: new Types.ObjectId(), jobNumber: 1, mustHaveSkills: ['React'] });
  await CandidateModel.insertMany([
    { jobId: job._id, source: 'manual', name: 'Sara Ahmed', email: 'sara@example.com', score: 90, scoreReason: 'Great' },
    { jobId: job._id, source: 'manual', name: 'Sara Khan', email: 'khan@example.com', score: 70, scoreReason: 'Good' },
    { jobId: job._id, source: 'manual', name: 'Rafi Karim', email: 'rafi@example.com', score: 50, scoreReason: 'Ok' },
  ]);
  return { job, userId: String(new Types.ObjectId()) };
}

describe('chat agent: AI calls per message', () => {
  it('makes ONE call when a card is proposed, and replies with the card intro', async () => {
    const { job, userId } = await setup();
    const { ai, seen } = scriptedAi([call('propose_candidate_delete', { name: 'Rafi Karim' })]);
    const result = await runAgent({ ai, userId, userName: 'Rina', jobId: String(job._id), history: [], text: 'remove Rafi' });
    expect(seen).toHaveLength(1);
    expect(result.actionIds).toHaveLength(1);
    expect(result.reply).toBe(`Here's a card to remove Rafi Karim (score 50) from JOB-0001.\n\n${DELETE_CARD_FOOTER}`);
  });

  it('makes a second call after a lookup, so the AI can answer with the result', async () => {
    const { job, userId } = await setup();
    const { ai, seen } = scriptedAi([call('find_candidate', { name: 'Rafi' }), new AIMessage('Rafi Karim scored 50 and ranks #3 of 3.')]);
    const result = await runAgent({ ai, userId, userName: 'Rina', jobId: String(job._id), history: [], text: "Rafi's score?" });
    expect(seen).toHaveLength(2);
    const toolResult = seen[1]!.find((m) => m instanceof ToolMessage);
    expect(String(toolResult?.content)).toMatch(/#3 of 3 \| Rafi Karim \| score 50/);
    expect(result.reply).toBe('Rafi Karim scored 50 and ranks #3 of 3.');
    expect(result.actionIds).toHaveLength(0);
  });

  it('goes back to the AI when a card tool needs to ask "which one?"', async () => {
    const { job, userId } = await setup();
    const { ai, seen } = scriptedAi([call('propose_candidate_delete', { name: 'Sara' }), new AIMessage('There are two: Sara Ahmed and Sara Khan. Which one?')]);
    const result = await runAgent({ ai, userId, userName: 'Rina', jobId: String(job._id), history: [], text: 'remove Sara' });
    expect(seen).toHaveLength(2);
    expect(String(seen[1]!.find((m) => m instanceof ToolMessage)?.content)).toMatch(/Several candidates/);
    expect(result.actionIds).toHaveLength(0);
    expect(result.reply).toMatch(/Which one\?/);
  });
});
