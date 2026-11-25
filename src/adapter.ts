import type { Allowed } from "./types.js";

/** An OpenAI-style chat request. Other fields pass through unchanged. */
export interface ChatRequest {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  [field: string]: unknown;
}

export interface RenderInput {
  decision: Allowed;
  request: ChatRequest;
  model: string;
  fallbacks: string[];
  maxOutputTokens: number;
}

export interface Rendered {
  url?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface Usage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** The cost the gateway reported, when it reports one. */
  costUsd?: number;
}

/** Turns a decision into one gateway's request, and reads usage back from its response. */
export interface GatewayAdapter {
  readonly name: string;
  render(input: RenderInput): Rendered;
  /** Some gateways report cost in a header, so settle() passes the response headers when it has them. */
  readUsage(response: unknown, headers?: Headers): Usage | null;
}
