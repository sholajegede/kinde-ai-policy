import type { GatewayAdapter, Usage } from "./adapter.js";

export interface OpenAICompatibleOptions {
  /** For example `https://api.openai.com/v1`. The adapter adds `/chat/completions`. */
  baseUrl?: string;
  apiKey?: string;
  /** Newer OpenAI models take `max_completion_tokens`. Defaults to `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Sends the user or agent ID in the `user` field. Defaults to true. */
  sendUser?: boolean;
  headers?: Record<string, string>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads `usage` from an OpenAI-style response or the last streamed chunk. */
export function readOpenAIUsage(response: unknown): Usage | null {
  if (typeof response !== "object" || response === null) return null;
  const r = response as { model?: unknown; usage?: Record<string, unknown> | null };
  const usage = r.usage;
  if (!usage) return null;
  const inputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const costUsd = num(usage.cost);
  return {
    inputTokens,
    outputTokens,
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * For any endpoint that speaks the OpenAI chat completions API.
 * The API has no fallback field, so fallbacks are not sent; use a gateway adapter for them.
 */
export function openaiCompatible(options: OpenAICompatibleOptions = {}): GatewayAdapter {
  const field = options.maxTokensField ?? "max_tokens";
  const other = field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  return {
    name: "openai-compatible",
    render({ decision, request, model, maxOutputTokens }) {
      const body: Record<string, unknown> = { ...request, model, [field]: maxOutputTokens };
      delete body[other];
      if (request.stream) body.stream_options = { ...(request.stream_options as object | undefined), include_usage: true };
      const user = decision.attribution.user ?? decision.attribution.agent;
      if (options.sendUser !== false && user) body.user = user;
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
