import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface UpstreamRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * A small OpenAI-compatible provider for the gateways to call. A model whose name contains "broken" answers 500,
 * so a gateway's fallback is the only way the request can succeed.
 */
export async function startUpstream() {
  const requests: UpstreamRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const model = String(body.model ?? "");
      if (model.includes("broken")) {
        res.writeHead(500, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: "upstream is down", type: "server_error" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-local",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Starts a gateway process and waits until its URL answers. */
export async function startProcess(command: string, args: string[], readyUrl: string, timeoutMs = 120_000) {
  const child: ChildProcess = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`${command} exited with ${child.exitCode}:\n${output.slice(-3000)}`);
    try {
      const res = await fetch(readyUrl);
      if (res.status < 500) return { child, output: () => output, stop: () => void child.kill("SIGTERM") };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  throw new Error(`${command} did not start within ${timeoutMs} ms:\n${output.slice(-3000)}`);
}
