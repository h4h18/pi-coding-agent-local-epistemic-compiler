import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockServerOptions = {
  advertisedContextTokens: number;
  measuredContextTokens: number;
  advertiseCacheUsage?: boolean;
  stallMs?: number;
  disconnect?: boolean;
  malformedJson?: boolean;
};

export type MockServer = {
  baseUrl: string;
  requestCount: number;
  advertisedContextTokens: number;
  measuredContextTokens: number;
  close: () => Promise<void>;
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function userContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "";
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  const first: unknown = messages[0];
  if (typeof first !== "object" || first === null) {
    return "";
  }
  const content = (first as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function mergeExtraBody(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) {
    return payload;
  }
  if (!("extra_body" in payload)) {
    return payload;
  }
  const extra = (payload as { extra_body?: unknown }).extra_body;
  if (typeof extra !== "object" || extra === null) {
    return payload;
  }
  const copy = { ...(payload as Record<string, unknown>) };
  delete copy.extra_body;
  return { ...copy, ...(extra as Record<string, unknown>) };
}

function completionBody(content: string, cachedTokens: number | undefined): string {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model: "mock",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
      cached_tokens: cachedTokens,
    },
  });
}

export async function startMockOpenAiServer(options: MockServerOptions): Promise<MockServer> {
  const state = { requestCount: 0 };
  const server = http.createServer((req, res) => {
    void (async () => {
      state.requestCount += 1;
      if (options.disconnect === true) {
        req.socket.destroy();
        return;
      }
      const text = await readBody(req);
      if (options.stallMs !== undefined && options.stallMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, options.stallMs);
        });
      }
      if (options.malformedJson === true) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end('{"choices":');
        return;
      }
      let payload: unknown = {};
      if (text.length > 0) {
        payload = JSON.parse(text) as unknown;
      }
      const merged = mergeExtraBody(payload);
      const contentText = userContent(merged);
      let content = '{"answer":"unspecified"}';
      if (contentText.startsWith("schema-ok:")) {
        content = '{"answer":"pong"}';
      } else if (contentText.startsWith("schema-fail:")) {
        content = '{"not_answer":1}';
      } else if (contentText.startsWith("role-isolation:")) {
        content = '{"status":"local-only"}';
      }
      const cached = options.advertiseCacheUsage === true ? 3 : undefined;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(completionBody(content, cached));
    })().catch(() => {
      req.socket.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    get requestCount() {
      return state.requestCount;
    },
    advertisedContextTokens: options.advertisedContextTokens,
    measuredContextTokens: options.measuredContextTokens,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
