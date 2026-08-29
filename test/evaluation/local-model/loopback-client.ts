export type ChatCompletionBody = {
  model: string;
  messages: readonly { role: string; content: string }[];
  extra_body?: Record<string, unknown>;
};

export type ChatCompletionResult =
  | {
      ok: true;
      content: string;
      usage?: { cached_tokens?: number };
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
      signal: input.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "transport-error";
    return { ok: false, reason };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed-json" };
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) {
    return { ok: false, reason: "missing-choices" };
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    return { ok: false, reason: "missing-choices" };
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return { ok: false, reason: "missing-message" };
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    return { ok: false, reason: "missing-content" };
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  let invokedCloudCompletion = false;
  let invokedRepositoryTool = false;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (typeof call !== "object" || call === null) {
        continue;
      }
      const fn = (call as { function?: { name?: unknown } }).function;
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (name === "completeOnce" || name === "cloud_complete" || name.includes("cloud")) {
        invokedCloudCompletion = true;
      }
      if (looksLikeRepositoryTool(name)) {
        invokedRepositoryTool = true;
      }
    }
  }
  const usageRaw = (parsed as { usage?: unknown }).usage;
  const usage =
    typeof usageRaw === "object" && usageRaw !== null
      ? {
          cached_tokens:
            typeof (usageRaw as { cached_tokens?: unknown }).cached_tokens === "number"
              ? (usageRaw as { cached_tokens: number }).cached_tokens
              : undefined,
        }
      : undefined;
  return {
    ok: true,
    content,
    usage,
    invokedCloudCompletion,
    invokedRepositoryTool,
  };
}
