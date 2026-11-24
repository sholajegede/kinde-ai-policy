import type { Pricing } from "./types.js";

/** Cost in millionths of a dollar. Prices are USD per million tokens, so the units cancel. */
export function costMicros(price: { input: number; output: number }, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * price.input + outputTokens * price.output);
}

/** The highest cost across the models, so a fallback never costs more than was reserved. */
export function worstCaseMicros(pricing: Pricing, models: string[], inputTokens: number, outputTokens: number): number {
  let worst = 0;
  for (const m of models) {
    const price = pricing[m];
    if (price) worst = Math.max(worst, costMicros(price, inputTokens, outputTokens));
  }
  return worst;
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce<number>((n, part) => n + textLength(part), 0);
  if (typeof content === "object" && content !== null) {
    const part = content as Record<string, unknown>;
    if (typeof part.text === "string") return part.text.length;
    if ("content" in part) return textLength(part.content);
  }
  return 0;
}

/**
 * A deliberately high estimate of input tokens: one token per 3 characters of text,
 * plus 4 per message. Settling corrects it to the real count.
 */
export function estimateInputTokens(request: { messages?: unknown[]; tools?: unknown }): number {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const chars = messages.reduce<number>((n, m) => n + textLength(m), 0) + (request.tools ? JSON.stringify(request.tools).length : 0);
  return Math.ceil(chars / 3) + messages.length * 4;
}
