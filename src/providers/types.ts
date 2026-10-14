// Provider-neutral types (docs/providers.md §2). Rime's own message format stays
// the Anthropic content-block shape; adapters convert at the wire.

export type Block = { type: string; [k: string]: unknown };
export type Message = { role: 'user' | 'assistant' | 'system'; content: string | Block[]; [k: string]: unknown };

export type Wire = 'anthropic' | 'openai';
export type CacheMode = 'explicit' | 'auto' | 'passthrough' | 'slots';
export type Effort = 'low' | 'medium' | 'high' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];

export type Price = { in: number; read: number; write: number; out: number };

// What one connected provider resolves to for a request.
export type Conn = {
  name: string; // e.g. "gpubox"
  wire: Wire;
  base: string; // URL ending in /v1 for openai wires, the API root for anthropic
  key?: string;
  local?: boolean;
  cache?: CacheMode;
  llamacpp?: boolean;
  effortField?: 'reasoning_effort' | 'reasoning.effort' | 'think' | 'chat_template_kwargs'; // where effort goes on OpenAI-style hosts
  tools?: 'native' | 'text' | 'none'; // how the server's template handles tool calls (probed)
};

export type Model = {
  ref: string; // "provider/model-id"
  provider: string;
  id: string;
  label: string;
  context?: number;
  price?: Price; // $ per million tokens; unknown when missing, local = 0
  efforts?: Partial<Record<Effort | 'off', string>>; // neutral level -> value the model takes
  budgets?: Partial<Record<Effort, number>>;
  vision?: boolean; // can it see images? unknown when missing
};

// Rime's neutral controls (docs/providers.md §5).
export type Controls = { reasoning: boolean; effort?: Effort };

// Normalized usage for one response (docs/providers.md §2.1).
export type Usage = { input: number; cached: number; written: number; output: number; promptMs?: number; genMs?: number };

export type Event =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'id'; id: string } // completion id, for llama.cpp's reasoning_end control
  | { type: 'model'; id: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: string }
  | { type: 'tool'; name: string; args: string } // a tool call being written: its arguments so far
  | { type: 'blocks'; blocks: Block[] }; // the finished assistant turn, to store as-is

export type Request = {
  conn: Conn;
  model: Model;
  system: string;
  messages: Message[];
  controls: Controls;
  signal?: AbortSignal;
  maxTokens?: number;
  slot?: number; // llama.cpp: pin to this slot
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[]; // frozen for the session
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
