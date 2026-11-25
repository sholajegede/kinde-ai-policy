import type { GatewayAdapter } from "./adapter.js";
import { attributionId, chatCompletionsAdapter, record, type ChatCompletionsOptions } from "./chat-completions.js";

export interface OpenRouterOptions extends Omit<ChatCompletionsOptions, "baseUrl"> {
  /** Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** Sent as `HTTP-Referer` and `X-Title`, which OpenRouter uses to show your app in its rankings. */
  app?: { url?: string; title?: string };
}

/**
 * OpenRouter's chat completions API. Fallbacks go in `models`, which OpenRouter tries in order after `model`,
 * and usage accounting is turned on so settle() charges the cost OpenRouter reports.
 */
export function openrouter(options: OpenRouterOptions = {}): GatewayAdapter {
  const headers = {
    ...(options.app?.url ? { "HTTP-Referer": options.app.url } : {}),
    ...(options.app?.title ? { "X-Title": options.app.title } : {}),
    ...options.headers,
  };
  return chatCompletionsAdapter("openrouter", { ...options, baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1", headers }, (body, input) => {
    if (input.fallbacks.length > 0) body.models = input.fallbacks;
    else delete body.models;
    body.usage = { ...record(body.usage), include: true };
    const user = attributionId(input);
    if (options.sendUser !== false && user) body.user = user;
  });
}
