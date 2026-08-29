import http from "node:http";
import type { AddressInfo } from "node:net";

export type AnalystMockServer = {
  port: number;
  baseUrl: string;
  requestCount: number;
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

function sseChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-hec-local",
    object: "chat.completion.chunk",
    created: 1,
    model: "hec-analyst",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function textSse(content: string): string {
  return [sseChunk({ role: "assistant", content }), sseChunk({}, "stop"), "data: [DONE]\n\n"].join("");
}

function toolCallSse(name: string, args: unknown): string {
  const encoded = JSON.stringify(args);
  return [
    sseChunk({ role: "assistant", content: "" }),
    sseChunk({
      tool_calls: [{ index: 0, id: "call_local_1", type: "function", function: { name, arguments: encoded } }],
    }),
    sseChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ].join("");
}

function lastUserText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return collectText(payload);
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    if ((message as { role?: unknown }).role === "user") {
      return collectText(message);
    }
  }
  return collectText(payload);
}

function hasToolResultAfterLastUser(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    if ((message as { role?: unknown }).role === "user") {
      lastUser = index;
    }
  }
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role === "tool" || role === "toolResult") {
      return true;
    }
  }
  return false;
}

function responseFor(payload: unknown): string {
  const last = lastUserText(payload);
  if (last.includes("TAINT_FIXTURE")) {
    return textSse(TAINTED_QUERY_JSON);
  }
  if (last.includes("HEC_LANE:LINK")) {
    return textSse(LINK_JSON);
  }
  if (last.includes("HEC_LANE:REVIEW")) {
    return textSse(REVIEW_JSON);
  }
  if (last.includes("HEC_LANE:QUERY")) {
    return textSse(QUERY_JSON);
  }
  if (last.includes("HEC_LANE:ACTIONS")) {
    if (hasToolResultAfterLastUser(payload)) {
      return textSse("lane complete");
    }
    return toolCallSse("evidence_submit_actions", actionArgs());
  }
  if (last.includes("HEC_LANE:AUDIT")) {
    if (hasToolResultAfterLastUser(payload)) {
      return textSse("lane complete");
    }
    return toolCallSse("evidence_submit_audit", auditArgs());
  }
  return textSse(QUERY_JSON);
}

function collectText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(collectText).join("\n");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as { text?: unknown; content?: unknown; messages?: unknown };
  const parts: string[] = [];
  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  if (record.content !== undefined) {
    parts.push(collectText(record.content));
  }
  if (record.messages !== undefined) {
    parts.push(collectText(record.messages));
  }
  return parts.join("\n");
}

const QUERY_JSON = JSON.stringify({
  schemaVersion: 1,
  queries: [
    {
      query: "symbol n definition",
      targetClaimIds: ["evidence_" + "a".repeat(52)],
      entityHints: ["n"],
      relationHints: ["DEFINES"],
    },
  ],
});

const TAINTED_QUERY_JSON = JSON.stringify({
  schemaVersion: 1,
  queries: [
    {
      query: "```ts\nexport const leaked = 1;\n```",
      targetClaimIds: ["evidence_" + "a".repeat(52)],
      entityHints: ["n"],
      relationHints: ["DEFINES"],
    },
  ],
});

const TAINTED_REPRO_QUERY = "```ts\nexport const leakedNested = 1;\n```";

const LINK_JSON = JSON.stringify({
  schemaVersion: 1,
  evidenceGraphObjectDigest: "sha256:" + "ab".repeat(32),
  proposedEvidence: [
    {
      proposalId: "unknown-1",
      kind: "unknown",
      statement: "missing runtime witness for n",
      citedSourceRefs: [],
      targetClaimIds: ["evidence_" + "a".repeat(52)],
      requestedReproductionActions: [
        {
          id: "action-1",
          channelId: "lexical",
          targetClaimIds: ["evidence_" + "a".repeat(52)],
          query: TAINTED_REPRO_QUERY,
          filters: {},
          expectedInformationGain: 0.4,
          expectedTrustGain: 0.3,
          estimatedLatencyMs: 10,
          estimatedPacketTokens: 32,
        },
      ],
    },
  ],
  proposedRelations: [],
});

const REVIEW_JSON = JSON.stringify({
  schemaVersion: 1,
  candidateId: "candidate_01234567-89ab-7cde-8f01-23456789abcd",
  candidateManifestObjectDigest: "sha256:" + "ab".repeat(32),
  findings: [
    {
      id: "finding-1",
      kind: "MISSING_EVIDENCE",
      statement: "open evidence obligation: runtime witness for n",
      sourceRefs: [],
      requirementIds: ["req_" + "a".repeat(52)],
      confidence: "MEDIUM",
    },
  ],
});

function actionArgs(): unknown {
  return {
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    actions: [
      {
        id: "action-1",
        channelId: "lexical",
        targetClaimIds: ["evidence_" + "a".repeat(52)],
        query: "symbol n",
        filters: {},
        expectedInformationGain: 0.4,
        expectedTrustGain: 0.3,
        estimatedLatencyMs: 10,
        estimatedPacketTokens: 32,
      },
    ],
  };
}

function auditArgs(): unknown {
  return {
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    unknowns: [
      {
        proposalId: "unknown-1",
        kind: "unknown",
        statement: "missing runtime witness for n",
        citedSourceRefs: [],
        targetClaimIds: ["evidence_" + "a".repeat(52)],
        requestedReproductionActions: [
          {
            id: "action-1",
            channelId: "lexical",
            targetClaimIds: ["evidence_" + "a".repeat(52)],
            query: TAINTED_REPRO_QUERY,
            filters: {},
            expectedInformationGain: 0.4,
            expectedTrustGain: 0.3,
            estimatedLatencyMs: 10,
            estimatedPacketTokens: 32,
          },
        ],
      },
    ],
    conflicts: [],
    saturationReasons: ["frontier-exhausted"],
  };
}

export async function startAnalystMockServer(): Promise<AnalystMockServer> {
  const state = { requestCount: 0 };
  const server = http.createServer((req, res) => {
    void (async () => {
      state.requestCount += 1;
      const url = req.url ?? "";
      if (req.method === "GET" && url.includes("/models")) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "hec-analyst", object: "model" }] }));
        return;
      }
      const text = await readBody(req);
      let payload: unknown = {};
      if (text.length > 0) {
        payload = JSON.parse(text) as unknown;
      }
      const stream =
        typeof payload === "object" && payload !== null && (payload as { stream?: unknown }).stream === false
          ? false
          : true;
      const body = responseFor(payload);
      if (stream) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.end(body);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-hec-local",
          object: "chat.completion",
          created: 1,
          model: "hec-analyst",
          choices: [{ index: 0, message: { role: "assistant", content: QUERY_JSON }, finish_reason: "stop" }],
        }),
      );
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
    port: address.port,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get requestCount() {
      return state.requestCount;
    },
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
