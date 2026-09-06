import { expect, test } from "vitest";
import { IdempotencyConflictError, ReconcileRequiredError } from "../src/index.js";
import { LATER, NOW, bootstrapTrustedWorld, openTempStore, principalScope } from "./helpers.js";

test("API idempotency replays the same ciphertext payload and rejects digest mismatch", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-idem");
    const headers = Buffer.from('{"content-type":"application/json"}');
    const body = Buffer.from('{"ok":true}');
    const reserved = opened.store.reserveApiIdempotency(world.scope, {
      operationId: "op-create-run",
      scopeKey: `project:${world.projectId}`,
      method: "POST",
      targetUri: "/runs",
      semanticRequestDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: NOW,
      expiresAt: LATER,
    });
    expect(reserved).toEqual({ state: "reserved" });
    opened.store.completeApiIdempotency(world.scope, {
      operationId: "op-create-run",
      scopeKey: `project:${world.projectId}`,
      semanticRequestDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      responseStatus: 201,
      headers,
      body,
      updatedAt: NOW,
    });
    const replay = opened.store.reserveApiIdempotency(world.scope, {
      operationId: "op-create-run",
      scopeKey: `project:${world.projectId}`,
      method: "POST",
      targetUri: "/runs",
      semanticRequestDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: NOW,
      expiresAt: LATER,
    });
    expect(replay.state).toBe("completed");
    if (replay.state !== "completed") {
      throw new Error("expected completed replay");
    }
    expect(replay.responseStatus).toBe(201);
    expect(Buffer.from(replay.headers).equals(headers)).toBe(true);
    expect(Buffer.from(replay.body).equals(body)).toBe(true);
    expect(() =>
      opened.store.reserveApiIdempotency(world.scope, {
        operationId: "op-create-run",
        scopeKey: `project:${world.projectId}`,
        method: "POST",
        targetUri: "/runs",
        semanticRequestDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: NOW,
        expiresAt: LATER,
      }),
    ).toThrow(IdempotencyConflictError);
  } finally {
    opened.close();
  }
});

test("reconcile-required is never blindly replayed and is separate from run operations", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-recon");
    opened.store.reserveApiIdempotency(world.scope, {
      operationId: "op-external",
      scopeKey: `project:${world.projectId}`,
      method: "POST",
      targetUri: "/cloud",
      semanticRequestDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      createdAt: NOW,
      expiresAt: LATER,
    });
    opened.store.markApiIdempotencyReconcileRequired(world.scope, {
      operationId: "op-external",
      updatedAt: NOW,
    });
    expect(() =>
      opened.store.reserveApiIdempotency(world.scope, {
        operationId: "op-external",
        scopeKey: `project:${world.projectId}`,
        method: "POST",
        targetUri: "/cloud",
        semanticRequestDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        createdAt: NOW,
        expiresAt: LATER,
      }),
    ).toThrow(ReconcileRequiredError);
    const other = principalScope([world.projectId], "admin-2");
    opened.store.reserveApiIdempotency(other, {
      operationId: "op-external",
      scopeKey: `project:${world.projectId}`,
      method: "POST",
      targetUri: "/cloud",
      semanticRequestDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      createdAt: NOW,
      expiresAt: LATER,
    });
  } finally {
    opened.close();
  }
});
