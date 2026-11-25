import type { GatewayAdapter } from "./adapter.js";
import { attributionId, attributionTags, chatCompletionsAdapter, record, type ChatCompletionsOptions } from "./chat-completions.js";

export interface VercelGatewayOptions extends Omit<ChatCompletionsOptions, "baseUrl" | "sendUser"> {
  /** Defaults to `https://ai-gateway.vercel.sh/v1`. */
  baseUrl?: string;
  /**
   * Sends the user or agent ID as Vercel's `user`, so spend reports can group by it. Off by default: Vercel charges
   * for each reporting value it records, and in testing each one cost more than the inference of a short call.
   */
  sendUser?: boolean;
  /**
   * Adds `plan:<plan>`, `org:<org>` and `agent:<client ID>` tags, so Vercel's spend reports group by them.
   * Off by default, for the same reason as `sendUser`.
   */
  sendTags?: boolean;
}

/**
 * Vercel AI Gateway's chat completions API. Fallbacks, the user and tags go in `providerOptions.gateway`.
 * Vercel's own budgets cover keys and team members, not your customers, so the package's budgets do that.
 */
export function vercelGateway(options: VercelGatewayOptions = {}): GatewayAdapter {
  return chatCompletionsAdapter("vercel", { ...options, baseUrl: options.baseUrl ?? "https://ai-gateway.vercel.sh/v1" }, (body, input) => {
    const providerOptions = record(body.providerOptions) ?? {};
    const gateway: Record<string, unknown> = { ...record(providerOptions.gateway) };
    if (input.fallbacks.length > 0) gateway.models = input.fallbacks;
    else delete gateway.models;
    const user = attributionId(input);
    if (options.sendUser === true && user) gateway.user = user;
    if (options.sendTags === true) gateway.tags = [...new Set([...(Array.isArray(gateway.tags) ? (gateway.tags as string[]) : []), ...attributionTags(input)])];
    body.providerOptions = { ...providerOptions, gateway };
  });
}
