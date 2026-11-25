import type { Usage } from "./adapter.js";
import { attributionTags, record } from "./chat-completions.js";
import type { AiPolicyEngine, Reservation } from "./engine.js";
import { estimateInputTokens } from "./pricing.js";
import type { Decision, Denied } from "./types.js";

/** Thrown inside an AI SDK call that the policy refuses. Turn it into a response with `ai.toResponse(error.denied)`. */
export class PolicyDeniedError extends Error {
  readonly denied: Denied;

  constructor(denied: Denied) {
    super(denied.detail);
    this.name = "PolicyDeniedError";
    this.denied = denied;
  }
}

export interface AiSdkPolicyOptions<V extends "v3" | "v4" = "v4"> {
  /** `vercel` also sends the fallbacks in `providerOptions.gateway`. Defaults to `none`. */
  gateway?: "vercel" | "none";
  /** With `gateway: "vercel"`, also sends the user or agent ID as Vercel's `user`. Vercel charges for each reporting value. Defaults to false. */
  user?: boolean;
  /** With `gateway: "vercel"`, also sends `plan:`, `org:` and `agent:` reporting tags. Vercel charges for them. Defaults to false. */
  tags?: boolean;
  /** `v4` for AI SDK 7, `v3` for AI SDK 6. Defaults to `v4`. */
  specificationVersion?: V;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const tokens = (v: unknown) => num(v) ?? num(record(v)?.total);

/** Reads AI SDK usage, the model that answered, and a cost the gateway or OpenRouter reports. */
export function usageFromAiSdk(usage: unknown, modelId: string | undefined, providerMetadata: unknown): Usage | null {
  const u = record(usage);
  const inputTokens = tokens(u?.inputTokens);
  const outputTokens = tokens(u?.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const meta = record(providerMetadata);
  const gateway = record(meta?.gateway);
  const costUsd = num(gateway?.gatewayCost) ?? num(gateway?.cost) ?? num(record(record(meta?.openrouter)?.usage)?.cost);
  // The AI SDK reports the model that was asked for. After a fallback, the gateway's routing names the one that answered.
  const served = record(gateway?.routing)?.canonicalSlug;
  const model = typeof served === "string" ? served : modelId;
  return { inputTokens, outputTokens, ...(model ? { model } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AiPolicyMiddleware<V extends "v3" | "v4" = "v4"> {
  readonly specificationVersion: V;
  transformParams: (options: { type: "generate" | "stream"; params: any; model: any }) => PromiseLike<any>;
  wrapGenerate: (options: { doGenerate: () => PromiseLike<any>; doStream: () => PromiseLike<any>; params: any; model: any }) => PromiseLike<any>;
  wrapStream: (options: { doGenerate: () => PromiseLike<any>; doStream: () => PromiseLike<any>; params: any; model: any }) => PromiseLike<any>;
}

/**
 * Language model middleware for the AI SDK. Use it with `wrapLanguageModel()` for one decision:
 * it refuses a model the decision does not allow, caps `maxOutputTokens`, reserves budget before the call,
 * and settles it from the usage the call reports, for `generateText` and `streamText` alike.
 */
export function aiPolicyMiddleware<V extends "v3" | "v4" = "v4">(ai: AiPolicyEngine, decision: Decision, options: AiSdkPolicyOptions<V> = {}): AiPolicyMiddleware<V> {
  if (!decision.allowed) throw new PolicyDeniedError(decision);

  async function reserve(params: any, model: any): Promise<Reservation> {
    const reservation = await ai.reserve(decision, {
      model: model.modelId,
      inputTokens: estimateInputTokens({ messages: Array.isArray(params.prompt) ? params.prompt : [], tools: params.tools }),
      ...(typeof params.maxOutputTokens === "number" ? { maxOutputTokens: params.maxOutputTokens } : {}),
    });
    if (!reservation.allowed) throw new PolicyDeniedError(reservation);
    return reservation;
  }

  return {
    specificationVersion: (options.specificationVersion ?? "v4") as V,

    async transformParams({ params, model }) {
      if (!decision.allowed) return params;
      const asked = typeof params.maxOutputTokens === "number" && params.maxOutputTokens > 0 ? params.maxOutputTokens : decision.maxOutputTokens;
      const next = { ...params, maxOutputTokens: Math.min(asked, decision.maxOutputTokens) };
      if (options.gateway === "vercel") {
        const providerOptions = record(params.providerOptions) ?? {};
        const gateway: Record<string, unknown> = { ...record(providerOptions.gateway) };
        const fallbacks = decision.fallbacks.filter((f) => f !== model.modelId);
        if (fallbacks.length > 0) gateway.models = fallbacks;
        else delete gateway.models;
        const user = decision.attribution.user ?? decision.attribution.agent;
        if (options.user && user) gateway.user = user;
        if (options.tags) gateway.tags = [...new Set([...(Array.isArray(gateway.tags) ? gateway.tags : []), ...attributionTags({ decision } as never)])];
        next.providerOptions = { ...providerOptions, gateway };
      }
      return next;
    },

    async wrapGenerate({ doGenerate, params, model }) {
      const reservation = await reserve(params, model);
      let result: any;
      try {
        result = await doGenerate();
      } catch (error) {
        await reservation.release();
        throw error;
      }
      await reservation.settle(usageFromAiSdk(result.usage, result.response?.modelId, result.providerMetadata));
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const reservation = await reserve(params, model);
      let result: any;
      try {
        result = await doStream();
      } catch (error) {
        await reservation.release();
        throw error;
      }
      let modelId: string | undefined;
      let done = false;
      const stream = (result.stream as ReadableStream<any>).pipeThrough(
        new TransformStream<any, any>({
          async transform(part, controller) {
            if (part?.type === "response-metadata" && typeof part.modelId === "string") modelId = part.modelId;
            if (part?.type === "finish" && !done) {
              done = true;
              await reservation.settle(usageFromAiSdk(part.usage, modelId, part.providerMetadata));
            }
            controller.enqueue(part);
          },
          async flush() {
            if (!done) await reservation.release();
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
