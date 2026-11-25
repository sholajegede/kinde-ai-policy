import type { GatewayAdapter } from "./adapter.js";
import { attributionId, chatCompletionsAdapter, type ChatCompletionsOptions } from "./chat-completions.js";

export interface PortkeyOptions extends Omit<ChatCompletionsOptions, "baseUrl" | "apiKey"> {
  /** Defaults to Portkey's hosted gateway, `https://api.portkey.ai/v1`. Use your own for the open-source gateway. */
  baseUrl?: string;
  /** Your Portkey API key, sent as `x-portkey-api-key`. Not needed for the open-source gateway. */
  apiKey?: string;
  /**
   * How to reach each model, as a Portkey config target: for example `{ provider: "openai", api_key }`, or
   * `{ provider: "@openai-prod" }` for a Model Catalog provider. The adapter adds `override_params.model`.
   * Without it, the request goes out with only the model, and fallbacks are not sent.
   */
  target?: (model: string) => Record<string, unknown>;
  /** Status codes that move to the next model. Portkey's default is any error. */
  onStatusCodes?: number[];
  /** Sends `_user`, plan, org and agent in `x-portkey-metadata`, for Portkey's logs and usage-limit policies. Defaults to true. */
  sendMetadata?: boolean;
}

/**
 * Portkey's chat completions API, hosted or open source. With `target`, the model and its fallbacks go out as a
 * fallback config in the `x-portkey-config` header, one target per model, each with its `override_params.model`.
 */
export function portkey(options: PortkeyOptions = {}): GatewayAdapter {
  const base = chatCompletionsAdapter("portkey", { ...options, baseUrl: options.baseUrl ?? "https://api.portkey.ai/v1" });
  return {
    ...base,
    render(input) {
      const rendered = base.render(input);
      const headers = { ...rendered.headers };
      if (options.apiKey) headers["x-portkey-api-key"] = options.apiKey;
      if (options.target) {
        const targets = [input.model, ...input.fallbacks].map((model) => {
          const target = options.target!(model);
          const override = typeof target.override_params === "object" && target.override_params !== null ? target.override_params : {};
          return { ...target, override_params: { ...override, model } };
        });
        const config =
          targets.length === 1
            ? targets[0]
            : { strategy: { mode: "fallback", ...(options.onStatusCodes ? { on_status_codes: options.onStatusCodes } : {}) }, targets };
        headers["x-portkey-config"] = JSON.stringify(config);
      }
      if (options.sendMetadata !== false) {
        const a = input.decision.attribution;
        const user = attributionId(input);
        headers["x-portkey-metadata"] = JSON.stringify({
          ...(user ? { _user: user } : {}),
          plan: a.plan,
          ...(a.org ? { org: a.org } : {}),
          ...(a.agent ? { agent: a.agent } : {}),
        });
      }
      return { ...rendered, headers };
    },
  };
}
