import { expect, test } from "vitest";
import { createOneShotAdapter, envelopeDigest } from "@pi-hec/cloud-gateway";
import {
  TS,
  buildDispatch,
  countingFetch,
  openaiCapabilities,
} from "../../../packages/cloud-gateway/test/helpers.js";

test("ambiguous provider outcome does not create a second accepted completion", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{'),
            );
            controller.error(new Error("drop"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const first = await adapter.completeOnce(dispatch, new AbortController().signal);
  const second = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBeGreaterThanOrEqual(1);
  expect(first.state).toBe("accepted-outcome-unknown");
  expect(second.state).not.toBe("completed");
  const accepted = [first, second].filter(
    (result) => result.state === "completed" && result.receipt.outcome === "VALID_RESULT",
  );
  expect(accepted).toHaveLength(0);
});
