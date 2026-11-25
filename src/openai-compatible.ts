import type { GatewayAdapter } from "./adapter.js";
import { attributionId, chatCompletionsAdapter, type ChatCompletionsOptions } from "./chat-completions.js";

export type OpenAICompatibleOptions = ChatCompletionsOptions;
export { readOpenAIUsage } from "./chat-completions.js";

/**
 * For any endpoint that speaks the OpenAI chat completions API.
 * The API has no fallback field, so fallbacks are not sent; use a gateway adapter for them.
 */
export function openaiCompatible(options: OpenAICompatibleOptions = {}): GatewayAdapter {
  return chatCompletionsAdapter("openai-compatible", options, (body, input) => {
    const user = attributionId(input);
    if (options.sendUser !== false && user) body.user = user;
  });
}
