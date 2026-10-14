// The turn loop (SPEC §6, §17), with no screen in it: a reply streams, its tool
// calls are checked and asked about, their results go back to the model, until it
// answers without tools or is stopped. The UI subscribes to events and supplies
// the questions; tests drive it against the mock llama.cpp server.

import type { Decision } from './permissions.ts';
import type { ToolResult } from './tools.ts';
import type { Block, Event, Message, Usage } from '../providers/types.ts';
import { splitToolCalls } from './view.ts';

export type AgentEvent =
  | { type: 'start' } // a reply is requested
  | { type: 'id'; id: string } // the completion id (llama.cpp's reasoning_end)
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'draft'; name: string; args: string } // a tool call being written
  | { type: 'reply'; blocks: Block[]; usage: Usage | null; seq: number; stop: string } // a finished reply, stored at seq
  | { type: 'stopped'; usage: Usage | null; seq: number } // stopped part-way (its text kept at seq, or 0)
  | { type: 'failed'; error: Error } // the request failed; the user's message is taken back
  | { type: 'denied'; use: Block; why: string }
  | { type: 'declined'; use: Block }
  | { type: 'asked'; use: Block; answer: string | null } // the ask tool
  | { type: 'run'; use: Block; decision: Decision } // about to run
  | { type: 'ran'; use: Block; decision: Decision; result: ToolResult }
  | { type: 'held'; uses: Block[] } // a question in text, then tool calls: they wait
  | { type: 'end' }; // the streamed reply is over (ok or not)

export type Approval = 'yes' | 'stop' | { declined: string };
export type Store = {
  append(role: Message['role'], content: Block[], interrupted: boolean): number;
  update(seq: number, content: Block[], interrupted: boolean): void;
  remove(seq: number): void;
};

export type TurnHost = {
  messages: Message[];
  stream(signal: AbortSignal): AsyncIterable<Event>;
  store: Store;
  emit(e: AgentEvent): void;
  decide(use: Block): Decision;
  approve(use: Block, d: Decision, signal: AbortSignal): Promise<Approval>;
  question(q: string, options: { label: string; detail?: string }[], signal: AbortSignal): Promise<string | null>;
  run(use: Block, d: Decision, signal: AbortSignal): Promise<ToolResult>;
  optionsOf(raw: unknown): { label: string; detail?: string }[];
  queued?(): Promise<Block[]>; // messages you sent while it worked
  afterRound?(signal: AbortSignal): Promise<boolean>; // after each round of tool results: make room (token-kit); false stops the turn
  planNote?(): string; // added to a refusal in plan mode
  setLive?(live: { seq: number; text: () => string } | null): void; // the reply being streamed, for quitting mid-reply
  setLastUser?(seq: number): void; // the stored user message new words join
};

export const result = (id: unknown, content: string, error = false): Block => ({ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) });
const STOPPED = 'Not run: the user stopped Rime.';

// One streamed reply. `userSeq`: the stored user message to take back when nothing
// came of it (only on the first step; tool results always stay).
export async function streamReply(h: TurnHost, signal: AbortSignal, userSeq = 0): Promise<{ ok: boolean; blocks: Block[] }> {
  let blocks: Block[] = [], usage: Usage | null = null, stop = '', text = '';
  let live: { seq: number; text: () => string } | null = null;
  let flush: NodeJS.Timeout | null = null;
  const forget = () => {
    if (!userSeq) return;
    if (h.messages.at(-1)?.role === 'user') h.messages.pop();
    h.store.remove(userSeq);
    h.setLastUser?.(0);
  };
  h.emit({ type: 'start' });
  try {
    for await (const ev of h.stream(signal)) {
      if (ev.type === 'id') h.emit(ev);
      else if (ev.type === 'blocks') blocks = ev.blocks;
      else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'stop') stop = ev.reason;
      else if (ev.type === 'thinking') h.emit(ev);
      else if (ev.type === 'tool') h.emit({ type: 'draft', name: ev.name, args: ev.args });
      else if (ev.type === 'text') {
        // The reply is stored while it streams (about once a second), so quitting
        // mid-reply keeps it, marked interrupted.
        if (!live) {
          const seq = h.store.append('assistant', [{ type: 'text', text: ev.text }], true);
          if (seq) {
            live = { seq, text: () => text };
            h.setLive?.(live);
            flush = setInterval(() => h.store.update(seq, [{ type: 'text', text }], true), 1000);
          }
        }
        text += ev.text;
        h.emit(ev);
        // Qwen's own <tool_call> XML in the text (no native tools) is a draft too.
        const at = text.indexOf('<tool_call>');
        if (at >= 0) {
          const t = text.slice(at);
          h.emit({ type: 'draft', name: /<function=([^>\s]+)>/.exec(t)?.[1] ?? /"name"\s*:\s*"([^"]+)"/.exec(t)?.[1] ?? 'tool', args: t });
        }
      }
    }
    if (flush) clearInterval(flush);
    let seq = 0;
    if (blocks.length) {
      h.messages.push({ role: 'assistant', content: blocks });
      h.setLastUser?.(0);
      if (live) h.store.update(live.seq, blocks, false), (seq = live.seq);
      else seq = h.store.append('assistant', blocks, false);
    } else forget();
    h.emit({ type: 'reply', blocks, usage, seq, stop });
    return { ok: blocks.length > 0, blocks };
  } catch (e) {
    if (flush) clearInterval(flush);
    if (signal.aborted) {
      let seq = 0;
      if (text.trim()) {
        const content: Block[] = [{ type: 'text', text: text.trimEnd() }];
        h.messages.push({ role: 'assistant', content });
        h.setLastUser?.(0);
        if (live) h.store.update(live.seq, content, false), (seq = live.seq);
      } else forget();
      h.emit({ type: 'stopped', usage, seq });
    } else {
      if (live) h.store.remove(live.seq);
      forget();
      h.emit({ type: 'failed', error: e as Error });
    }
    return { ok: false, blocks: [] };
  } finally {
    if (flush) clearInterval(flush);
    h.setLive?.(null);
    h.emit({ type: 'end' });
  }
}

// Runs each tool call in order. Every call gets a result, also when it's
// refused, declined or stopped, so the history stays valid.
export async function runTools(h: TurnHost, uses: Block[], signal: AbortSignal): Promise<Block[]> {
  const out: Block[] = [];
  let skip = '';
  for (const u of uses) {
    const input = (u.input ?? {}) as Record<string, any>;
    if (signal.aborted) {
      out.push(result(u.id, STOPPED, true));
      continue;
    }
    if (skip) {
      out.push(result(u.id, skip, true));
      continue;
    }
    // A question for the user: the turn waits for the pick (or their own words).
    if (u.name === 'ask') {
      const options = h.optionsOf(input.options);
      const q = String(input.question ?? '').trim();
      if (!q || options.length < 2) {
        out.push(result(u.id, 'ask needs a question and 2-4 options.', true));
        continue;
      }
      const a = await h.question(q, options, signal);
      h.emit({ type: 'asked', use: u, answer: a });
      if (a === null) {
        out.push(result(u.id, 'Not answered: the user stopped Rime.', true));
        skip = STOPPED;
        continue;
      }
      out.push(result(u.id, `The user answered: ${a}`));
      continue;
    }
    const d = h.decide(u);
    if (d.verdict === 'deny') {
      h.emit({ type: 'denied', use: u, why: d.why });
      out.push(result(u.id, `Not run: ${d.why}.${h.planNote?.() ?? ''}`, true));
      continue;
    }
    if (d.verdict === 'ask') {
      const a = await h.approve(u, d, signal);
      if (a === 'stop') {
        out.push(result(u.id, STOPPED, true));
        skip = STOPPED;
        continue;
      }
      if (a !== 'yes') {
        h.emit({ type: 'declined', use: u });
        out.push(result(u.id, a.declined ? `The user declined this and said: ${a.declined}` : 'The user declined this.', true));
        skip = 'Not run: the user declined an earlier step.';
        continue;
      }
    }
    h.emit({ type: 'run', use: u, decision: d });
    let r: ToolResult;
    try {
      r = await h.run(u, d, signal);
    } catch (e) {
      r = { content: (e as Error).message, error: true, summary: (e as Error).message };
    }
    h.emit({ type: 'ran', use: u, decision: d, result: r });
    out.push(result(u.id, r.content, !!r.error));
  }
  return out;
}

// The whole turn, after the user's message is in `h.messages` (stored at
// `userSeq`). Returns the last reply's text, for the next-step suggestion.
export async function runTurn(h: TurnHost, signal: AbortSignal, userSeq = 0, maxSteps = 200): Promise<{ said: string }> {
  let said = '';
  for (let step = 0; step < maxSteps; step++) {
    const r = await streamReply(h, signal, step === 0 ? userSeq : 0);
    if (!r.ok) break;
    said = r.blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
    const uses = r.blocks.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;
    // A reply that asks something in text and then goes ahead anyway: the calls
    // wait for the answer ("not run" results keep the history valid, and the next
    // message goes with them).
    if (splitToolCalls(said).text.trim().endsWith('?') && !uses.some((u) => u.name === 'ask')) {
      h.messages.push({ role: 'user', content: uses.map((u) => result(u.id, 'Not run: you asked the user a question. Wait for their answer, and use the ask tool when they need to choose.', true)) });
      h.setLastUser?.(h.store.append('user', h.messages.at(-1)!.content as Block[], false));
      h.emit({ type: 'held', uses });
      break;
    }
    const results = await runTools(h, uses, signal);
    h.messages.push({ role: 'user', content: [...results, ...(signal.aborted || !h.queued ? [] : await h.queued())] });
    h.setLastUser?.(h.store.append('user', h.messages.at(-1)!.content as Block[], false));
    if (signal.aborted) break;
    // The context filling up: the host clears or compacts, or stops with the tool
    // results saved so "continue" picks up from here.
    if (h.afterRound && !(await h.afterRound(signal))) break;
  }
  return { said };
}
