// token-kit (SPEC §12 Phase 6, token-saving-plan.md, providers.md §6): Pi-style
// compaction (keep the recent tail, summarise the rest) and clearing old tool
// output. Pure functions over the message list; the app runs the summary call.

import type { Block, Message } from '../../providers/types.ts';

// Rough size in tokens (4 characters each), for choosing what to keep.
export const tokensOf = (m: Message | Message[]) => Math.ceil(JSON.stringify(m).length / 4);

export const SUMMARY_HEAD = '[Rime: the conversation so far, summarised to save context]';
export const SUMMARY_SYSTEM =
  'You summarise a coding conversation so it can continue without the full history. Write plain text, under 600 words: ' +
  "the user's goal and requests, decisions made, files created or changed (paths), commands run and their outcome, errors still open, and what was about to happen next. " +
  'Keep exact names, paths and numbers. No preamble.';

// Where the kept tail starts: an assistant message, so the history stays valid as
// [summary from the user] [assistant …] … (a tool result always follows its call).
// About `keep` tokens are kept; 0 when there's nothing worth cutting.
export function cutPoint(messages: Message[], keep: number): number {
  let size = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    size += tokensOf(messages[i]);
    if (size < keep) continue;
    for (let j = i; j > 0; j--) if (messages[j].role === 'assistant') return j;
    return 0;
  }
  return 0;
}

// The part being summarised, as text: what was said, each tool call in one line,
// tool output cut short (the summary needs outcomes, not whole files).
export function transcript(messages: Message[], max = 400000): string {
  const out: string[] = [];
  const blocks = (c: string | Block[]): Block[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
  for (const m of messages) {
    if (m.role === 'system') continue;
    for (const b of blocks(m.content)) {
      if (b.type === 'text' && String(b.text).trim()) out.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${String(b.text).trim()}`);
      else if (b.type === 'tool_use') out.push(`[tool ${b.name}] ${JSON.stringify(b.input).slice(0, 300)}`);
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push(`[result${b.is_error ? ', error' : ''}] ${t.slice(0, 400)}${t.length > 400 ? ' …' : ''}`);
      }
    }
  }
  const all = out.join('\n');
  return all.length > max ? '… (start cut)\n' + all.slice(-max) : all;
}

// The new history: the summary as the user's message, then the kept tail.
export function compacted(messages: Message[], cut: number, summary: string): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text: `${SUMMARY_HEAD}\n${summary}` }] }, ...messages.slice(cut)];
}

export const CLEARED = '[old tool output cleared to save context; run the tool again if you need it]';

// Context editing (not on llama.cpp, where changing the middle of the prompt means
// reprocessing everything after it): every tool result older than the last
// `keepRounds` rounds and longer than `min` characters is replaced by a short
// note, all at once, so the cache is rewritten rarely. Returns characters freed.
export function clearOld(messages: Message[], keepRounds = 4, min = 600): number {
  const rounds = messages.map((m, i) => (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result') ? i : -1)).filter((i) => i >= 0);
  const before = rounds.slice(0, Math.max(0, rounds.length - keepRounds));
  let freed = 0;
  for (const i of before)
    for (const b of messages[i].content as Block[]) {
      if (b.type !== 'tool_result') continue;
      const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      if (t.length <= min || t === CLEARED) continue;
      freed += t.length - CLEARED.length;
      b.content = CLEARED;
    }
  return freed;
}
