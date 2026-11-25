import type { GatewayAdapter, RenderInput, Rendered, Usage } from "./adapter.js";

export interface ChatCompletionsOptions {
  /** For example `https://api.openai.com/v1`. The adapter adds `/chat/completions`. */
  baseUrl?: string;
  apiKey?: string;
  /** Newer OpenAI models take `max_completion_tokens`. Defaults to `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Sends the user or agent ID to the gateway for attribution. Defaults to true. */
  sendUser?: boolean;
  headers?: Record<string, string>;
}

const num = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Reads `usage` from an OpenAI-style response or the last streamed chunk, including a cost the gateway reports. */
export function readOpenAIUsage(response: unknown): Usage | null {
  const r = record(response);
  const usage = record(r?.usage);
  if (!r || !usage) return null;
  const inputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  // Vercel AI Gateway puts its metadata on the message. gatewayCost is the total it debited, surcharges included.
  const message = record(record(Array.isArray(r.choices) ? r.choices[0] : undefined)?.message);
  const gateway = record(record(message?.provider_metadata ?? r.providerMetadata ?? r.provider_metadata)?.gateway);
  const costUsd = num(gateway?.gatewayCost) ?? num(gateway?.cost) ?? num(usage.cost);
  const served = record(gateway?.routing)?.canonicalSlug;
  return {
    inputTokens,
    outputTokens,
    ...(typeof served === "string" ? { model: served } : typeof r.model === "string" ? { model: r.model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Builds the OpenAI chat completions body that every adapter starts from. */
export function chatCompletionsAdapter(
  name: string,
  options: ChatCompletionsOptions,
  extend?: (body: Record<string, unknown>, input: RenderInput) => void,
): GatewayAdapter {
  const field = options.maxTokensField ?? "max_tokens";
  const other = field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  return {
    name,
    render(input): Rendered {
      const { request, model, maxOutputTokens } = input;
      const body: Record<string, unknown> = { ...request, model, [field]: maxOutputTokens };
      delete body[other];
      if (request.stream) body.stream_options = { ...record(request.stream_options), include_usage: true };
      extend?.(body, input);
      const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      return {
        ...(options.baseUrl ? { url: `${options.baseUrl.replace(/\/+$/, "")}/chat/completions` } : {}),
        headers,
        body,
      };
    },
    readUsage: readOpenAIUsage,
  };
}

export const attributionId = (input: RenderInput) => input.decision.attribution.user ?? input.decision.attribution.agent;

export function attributionTags(input: RenderInput): string[] {
  const a = input.decision.attribution;
  return [`plan:${a.plan}`, ...(a.org ? [`org:${a.org}`] : []), ...(a.agent ? [`agent:${a.agent}`] : [])];
}

export { record };
