import type { GatewayAdapter } from "./adapter.js";
import { attributionId, attributionTags, chatCompletionsAdapter, readOpenAIUsage, record, type ChatCompletionsOptions } from "./chat-completions.js";

export interface LiteLLMOptions extends Omit<ChatCompletionsOptions, "baseUrl"> {
  /** Your LiteLLM proxy, for example `http://localhost:4000`. The adapter adds `/chat/completions`. */
  baseUrl: string;
  /** Adds `plan:<plan>`, `org:<org>` and `agent:<client ID>` to `metadata.tags`, for LiteLLM's spend tracking and tag routing. Defaults to true. */
  sendTags?: boolean;
}

/**
 * The LiteLLM proxy's chat completions API. Fallbacks go in the `fallbacks` body field, which the proxy tries in
 * order when the model fails. The user goes in `user`, which LiteLLM tracks as the end user.
 * settle() charges the cost LiteLLM reports in the `x-litellm-response-cost` header when you pass the headers.
 */
export function litellm(options: LiteLLMOptions): GatewayAdapter {
  const adapter = chatCompletionsAdapter("litellm", options, (body, input) => {
    if (input.fallbacks.length > 0) body.fallbacks = input.fallbacks;
    else delete body.fallbacks;
    const user = attributionId(input);
    if (options.sendUser !== false && user) body.user = user;
    if (options.sendTags !== false) {
      const metadata = record(body.metadata) ?? {};
      const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
      body.metadata = { ...metadata, tags: [...new Set([...tags, ...attributionTags(input)])] };
    }
  });
  return {
    ...adapter,
    readUsage(response, headers) {
      const usage = readOpenAIUsage(response);
      if (!usage) return null;
      const header = headers?.get("x-litellm-response-cost");
      const cost = header !== null && header !== undefined && header.trim() !== "" ? Number(header) : NaN;
      return Number.isFinite(cost) ? { ...usage, costUsd: cost } : usage;
    },
  };
}
