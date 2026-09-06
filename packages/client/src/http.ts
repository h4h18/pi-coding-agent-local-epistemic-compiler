import { request as httpsRequest, type Agent, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { HTTP_OPERATIONS, type ApiOperationClass, type HttpOperationSpec } from "@pi-hec/contracts";
import { createMtlsAgent, createServerTlsAgent, type MtlsClientOptions } from "./mtls.js";
import { DEFAULT_READ_MAX_ATTEMPTS, retryDelayMs, shouldRetry, sleep } from "./retry-policy.js";

export type MutationSigner = (input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
}) => { headers: Record<string, string> };

export type ControlPlaneClientOptions = {
  baseUrl: string;
  enrollBaseUrl?: string;
  tls: MtlsClientOptions;
  enrollTls?: { ca: string | Buffer; servername?: string };
  signer?: MutationSigner;
  maxReadAttempts?: number;
  wait?: (ms: number) => Promise<void>;
};

export type ClientResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

function operationById(operationId: string): HttpOperationSpec {
  const found = HTTP_OPERATIONS.find((operation) => operation.operationId === operationId);
  if (found === undefined) {
    throw new Error(`unknown operation ${operationId}`);
  }
  return found;
}

function interpolatePath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replaceAll(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing path param ${name}`);
    }
    return encodeURIComponent(value);
  });
}

function headerMap(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value[0] !== undefined) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

function readBody(message: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    message.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    message.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    message.on("error", reject);
  });
}

function requestOnce(
  url: URL,
  options: RequestOptions,
  body: Uint8Array | undefined,
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, options, (res) => {
      void readBody(res)
        .then((buf) => {
          resolve({ status: res.statusCode ?? 0, headers: headerMap(res), body: buf });
        })
        .catch(reject);
    });
    req.on("error", reject);
    if (body !== undefined && body.byteLength > 0) {
      req.write(body);
    }
    req.end();
  });
}

export class ControlPlaneClient {
  readonly #baseUrl: string;
  readonly #enrollBaseUrl: string;
  readonly #mtls: Agent;
  readonly #enroll: Agent;
  readonly #signer: MutationSigner | undefined;
  readonly #maxReadAttempts: number;
  readonly #wait: (ms: number) => Promise<void>;

  constructor(options: ControlPlaneClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#enrollBaseUrl = (options.enrollBaseUrl ?? options.baseUrl).replace(/\/$/, "");
    this.#mtls = createMtlsAgent(options.tls);
    this.#enroll = createServerTlsAgent(
      options.enrollTls ?? {
        ca: options.tls.ca,
        ...(options.tls.servername === undefined ? {} : { servername: options.tls.servername }),
      },
    );
    this.#signer = options.signer;
    this.#maxReadAttempts = options.maxReadAttempts ?? DEFAULT_READ_MAX_ATTEMPTS;
    this.#wait = options.wait ?? ((ms) => sleep(ms));
  }

  close(): void {
    this.#mtls.destroy();
    this.#enroll.destroy();
  }

  async call(input: {
    operationId: string;
    pathParams?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string | number | undefined>>;
    body?: Uint8Array | string;
    headers?: Readonly<Record<string, string>>;
    range?: string;
  }): Promise<ClientResponse> {
    const spec = operationById(input.operationId);
    const path = interpolatePath(spec.path, input.pathParams ?? {});
    const origin = spec.operationId === "enrollRunner" ? this.#enrollBaseUrl : this.#baseUrl;
    const url = new URL(path, `${origin}/`);
    if (input.query !== undefined) {
      for (const [key, value] of Object.entries(input.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const bodyBuffer =
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? Buffer.from(input.body, "utf8")
          : Buffer.from(input.body);
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (input.range !== undefined) {
      headers.range = input.range;
    }
    if (
      this.#signer !== undefined &&
      spec.class !== "read" &&
      spec.operationId !== "enrollRunner"
    ) {
      const payload = bodyBuffer ?? Buffer.alloc(0);
      const signed = this.#signer({ method: spec.method, url, headers, body: payload });
      Object.assign(headers, signed.headers);
    }
    return this.#dispatch(
      spec.class,
      spec.method,
      url,
      headers,
      bodyBuffer,
      spec.operationId === "enrollRunner",
    );
  }

  async #dispatch(
    operationClass: ApiOperationClass,
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Buffer | undefined,
    enroll: boolean,
  ): Promise<ClientResponse> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await requestOnce(
          url,
          {
            method,
            headers,
            agent: enroll ? this.#enroll : this.#mtls,
            servername: url.hostname,
          },
          body,
        );
        if (
          shouldRetry({
            operationClass,
            attempt: attempt + 1,
            maxAttempts: this.#maxReadAttempts,
            error: { kind: "status", status: response.status },
          })
        ) {
          await this.#wait(retryDelayMs(attempt));
          attempt += 1;
          continue;
        }
        return response;
      } catch {
        if (
          shouldRetry({
            operationClass,
            attempt: attempt + 1,
            maxAttempts: this.#maxReadAttempts,
            error: { kind: "network" },
          })
        ) {
          await this.#wait(retryDelayMs(attempt));
          attempt += 1;
          continue;
        }
        throw new Error("control-plane request failed");
      }
    }
    throw new Error("control-plane request failed");
  }
}

export function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}
