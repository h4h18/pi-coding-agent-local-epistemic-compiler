import { isJsonObject, toJsonValue, type JsonValue } from "@pi-hec/contracts";

export type ChatCompletionBody = {
  model: string;
  messages: readonly { role: string; content: string }[];
  extra_body?: Record<string, unknown>;
};

export type ChatCompletionUsage = { cached_tokens?: number };

export type ChatCompletionResult =
  | {
      ok: true;
      content: string;
      usage?: ChatCompletionUsage;
      invokedCloudCompletion: boolean;
      invokedRepositoryTool: boolean;
    }
  | { ok: false; reason: string };

function isLoopbackUrl(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

function looksLikeRepositoryTool(name: string): boolean {
  return (
    name.includes("repository") ||
    name.includes("git_") ||
    name === "search_code" ||
    name === "read_file"
  );
}

export async function postChatCompletion(input: {
  baseUrl: string;
  body: ChatCompletionBody;
  signal?: AbortSignal;
}): Promise<ChatCompletionResult> {
  if (!isLoopbackUrl(input.baseUrl)) {
    throw new Error("loopback-only inference client: base URL must be 127.0.0.1");
  }
  const payload: Record<string, unknown> = {
    model: input.body.model,
    messages: input.body.messages,
  };
  if (input.body.extra_body !== undefined) {
    for (const [key, value] of Object.entries(input.body.extra_body)) {
      payload[key] = value;
    }
  }
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "transport-error";
    return { ok: false, reason };
  }
  const text = await response.text();
  let parsed: JsonValue;
  try {
    parsed = toJsonValue(JSON.parse(text));
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, reason: "malformed-json" };
  }
  const choices = parsed.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  if (!isJsonObject(first)) {
    return { ok: false, reason: "missing-choices" };
  }
  const message = first.message;
  if (!isJsonObject(message)) {
    return { ok: false, reason: "missing-message" };
  }
  const content = message.content;
  if (typeof content !== "string") {
    return { ok: false, reason: "missing-content" };
  }
  const toolCalls = message.tool_calls;
  let invokedCloudCompletion = false;
  let invokedRepositoryTool = false;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isJsonObject(call)) {
        continue;
      }
      const fn = call.function;
      const name = isJsonObject(fn) && typeof fn.name === "string" ? fn.name : "";
      if (name === "completeOnce" || name === "cloud_complete" || name.includes("cloud")) {
        invokedCloudCompletion = true;
      }
      if (looksLikeRepositoryTool(name)) {
        invokedRepositoryTool = true;
      }
    }
  }
  const usageRaw = parsed.usage;
  const cachedTokens = isJsonObject(usageRaw) ? usageRaw.cached_tokens : undefined;
  const usage: ChatCompletionUsage | undefined = isJsonObject(usageRaw)
    ? typeof cachedTokens === "number"
      ? { cached_tokens: cachedTokens }
      : {}
    : undefined;
  return {
    ok: true,
    content,
    ...(usage === undefined ? {} : { usage }),
    invokedCloudCompletion,
    invokedRepositoryTool,
  };
}
