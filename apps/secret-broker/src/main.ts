import { createServer, type Server, type Socket } from "node:net";
import type { KeyObject } from "node:crypto";
import type { MaybePromise, SecretInjectionGrant } from "@pi-hec/contracts";
import { type SealedSecret } from "@pi-hec/sandbox";
import { verifyGrant, type GrantExpected } from "./grant-verifier.js";
import { sealAndZeroize } from "./sealed-injection.js";

export type InjectRequest = {
  grantEnvelope: unknown;
  targetRunnerId: string;
  targetProcessDigest: string;
  ephemeralX25519PublicKey: Uint8Array;
  permittedNetworkDestinations: readonly string[];
  projectId: string;
  runId: string;
  operationId: string;
  destination: SecretInjectionGrant["destination"];
};

export type InjectResult = { ok: true; sealed: SealedSecret } | { ok: false; reason: string };

export type SecretBrokerConfig = {
  endpoint: string;
  now: () => string;
  capabilityAuthorityPublicKey: KeyObject;
  secrets: Map<string, Buffer>;
};

export type InjectHandler = (request: InjectRequest) => MaybePromise<InjectResult>;

export type SecretBrokerHandle = {
  endpoint: string;
  inject: InjectHandler;
  close: () => Promise<void>;
};

function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDestination(value: unknown): value is SecretInjectionGrant["destination"] {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as { [key: string]: unknown };
  if (record.kind === "environment" && typeof record.name === "string") {
    return true;
  }
  return record.kind === "file" && typeof record.relativePath === "string" && record.mode === "0400";
}

function writeFrame(socket: Socket, value: InjectResult): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  socket.write(Buffer.concat([header, body]));
}

function attachInjectSocket(socket: Socket, inject: InjectHandler): void {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  const drain = async (): Promise<void> => {
    while (buffer.byteLength >= 4) {
      const size = buffer.readUInt32BE(0);
      if (buffer.byteLength < 4 + size) {
        return;
      }
      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(4 + size);
      const parsed = parseJsonUnknown(body.toString("utf8"));
      if (parsed === null || typeof parsed !== "object") {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      const record = parsed as { [key: string]: unknown };
      if (record.type !== "inject" || typeof record.targetRunnerId !== "string") {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      if (typeof record.targetProcessDigest !== "string" || typeof record.ephemeralX25519PublicKey !== "string") {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      if (!isStringArray(record.permittedNetworkDestinations)) {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      if (typeof record.projectId !== "string" || typeof record.runId !== "string" || typeof record.operationId !== "string") {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      if (!isDestination(record.destination)) {
        writeFrame(socket, { ok: false, reason: "schema-invalid" });
        continue;
      }
      const result = await inject({
        grantEnvelope: record.grantEnvelope,
        targetRunnerId: record.targetRunnerId,
        targetProcessDigest: record.targetProcessDigest,
        ephemeralX25519PublicKey: Buffer.from(record.ephemeralX25519PublicKey, "base64url"),
        permittedNetworkDestinations: record.permittedNetworkDestinations,
        projectId: record.projectId,
        runId: record.runId,
        operationId: record.operationId,
        destination: record.destination,
      });
      writeFrame(socket, result);
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    chain = chain.then(drain, drain);
  });
}

export async function startSecretBroker(config: SecretBrokerConfig): Promise<SecretBrokerHandle> {
  const consumedNonces = new Set<string>();
  const inject = (request: InjectRequest): InjectResult => {
    const expected: GrantExpected = {
      targetRunnerId: request.targetRunnerId,
      targetProcessDigest: request.targetProcessDigest,
      projectId: request.projectId,
      runId: request.runId,
      operationId: request.operationId,
      destination: request.destination,
      permittedNetworkDestinations: request.permittedNetworkDestinations,
    };
    const verified = verifyGrant({
      envelope: request.grantEnvelope,
      now: config.now(),
      capabilityAuthorityPublicKey: config.capabilityAuthorityPublicKey,
      consumedNonces,
      expected,
    });
    if (!verified.ok) {
      return { ok: false, reason: verified.reason };
    }
    const secret = config.secrets.get(verified.grant.secretHandle);
    if (secret === undefined) {
      return { ok: false, reason: "unknown-handle" };
    }
    const copy = Buffer.from(secret);
    const sealed = sealAndZeroize(copy, request.ephemeralX25519PublicKey);
    return { ok: true, sealed };
  };

  const server: Server = createServer((socket: Socket) => {
    attachInjectSocket(socket, inject);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    endpoint: config.endpoint,
    inject,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
