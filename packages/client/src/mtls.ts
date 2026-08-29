import { Agent } from "node:https";
import type { Duplex } from "node:stream";

export type MtlsClientOptions = {
  ca: string | Buffer;
  cert: string | Buffer;
  key: string | Buffer;
  servername?: string;
};

export function createMtlsAgent(options: MtlsClientOptions): Agent {
  return new Agent({
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ...(options.servername === undefined ? {} : { servername: options.servername }),
  });
}

export function createServerTlsAgent(options: { ca: string | Buffer; servername?: string }): Agent {
  return new Agent({
    ca: options.ca,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ...(options.servername === undefined ? {} : { servername: options.servername }),
  });
}

export function destroyAgent(agent: Agent): void {
  agent.destroy();
}

export type TlsSocketLike = Duplex & { authorized?: boolean };
