import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import koffi from "koffi";
import {
  BrokerHelloSchema,
  BrokerRequestSchema,
  BrokerResponseSchema,
  PiClientHelloSchema,
  canonicalizeRfc8785,
  type BrokerHello,
  type BrokerRequest,
  type BrokerResponse,
  type MaybePromise,
  type PiClientHello,
} from "@pi-hec/contracts";
import { Compile } from "typebox/compile";

const execFileAsync = promisify(execFile);

export const PIPE_NAME_PREFIX = "\\\\.\\pipe\\pi-hec-v1-";
export const MAX_FRAME_BYTES = 1_048_576;
export const TRUSTED_VIEWS = ["CONTEXT", "DIFF", "VERIFICATION", "ARTIFACTS", "EXPORT"] as const;
export type TrustedView = (typeof TRUSTED_VIEWS)[number];

const HELLO = Compile(BrokerHelloSchema);
const CLIENT_HELLO = Compile(PiClientHelloSchema);
const REQUEST = Compile(BrokerRequestSchema);
const RESPONSE = Compile(BrokerResponseSchema);

export class BrokerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerProtocolError";
  }
}

export type BrokerTransport = {
  send(body: Uint8Array): MaybePromise<void>;
  receive(): MaybePromise<Uint8Array>;
  close(): MaybePromise<void>;
};

export type BrokerPort = {
  readonly brokerInstanceId: string;
  readonly connectionId: string;
  request(body: BrokerRequest): MaybePromise<BrokerResponse>;
  close(): MaybePromise<void>;
};

export type ProcessClaim = {
  claimedProcessId: number;
  claimedProcessCreationTime: string;
  clientInstanceId: string;
};

export function isTrustedView(value: string): value is TrustedView {
  return (TRUSTED_VIEWS as readonly string[]).includes(value);
}

export function encodeFrame(body: Uint8Array): Uint8Array {
  if (body.byteLength === 0) {
    throw new BrokerProtocolError("zero-length frame");
  }
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new BrokerProtocolError("frame exceeds 1 MiB");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

function socketClosed(socket: Socket): boolean {
  return socket.readableEnded || socket.destroyed;
}

async function waitForSocketData(socket: Socket): Promise<void> {
  if (socket.readableLength > 0) {
    return;
  }
  if (socketClosed(socket)) {
    throw new BrokerProtocolError("pipe closed");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.off("readable", onReadable);
      socket.off("end", onClosed);
      socket.off("close", onClosed);
      socket.off("error", onError);
      action();
    };
    const onReadable = (): void => {
      settle(() => {
        resolve();
      });
    };
    const onClosed = (): void => {
      settle(() => {
        reject(new BrokerProtocolError("pipe closed"));
      });
    };
    const onError = (error: Error): void => {
      settle(() => {
        reject(error);
      });
    };
    socket.once("readable", onReadable);
    socket.once("end", onClosed);
    socket.once("close", onClosed);
    socket.once("error", onError);
    if (socket.readableLength > 0) {
      settle(() => {
        resolve();
      });
      return;
    }
    if (socketClosed(socket)) {
      settle(() => {
        reject(new BrokerProtocolError("pipe closed"));
      });
    }
  });
}

export async function readExact(socket: Socket, byteLength: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = byteLength;
  while (remaining > 0) {
    const chunk: unknown = socket.read(remaining);
    if (Buffer.isBuffer(chunk) && chunk.byteLength > 0) {
      chunks.push(chunk);
      remaining -= chunk.byteLength;
      continue;
    }
    if (socketClosed(socket)) {
      throw new BrokerProtocolError("pipe closed");
    }
    await waitForSocketData(socket);
  }
  return Buffer.concat(chunks);
}

export async function readFramedBody(socket: Socket): Promise<Uint8Array> {
  const header = await readExact(socket, 4);
  const length = header.readUInt32BE(0);
  if (length === 0) {
    throw new BrokerProtocolError("zero-length frame");
  }
  if (length > MAX_FRAME_BYTES) {
    throw new BrokerProtocolError("frame exceeds 1 MiB");
  }
  return readExact(socket, length);
}

export function userSidHash(sid: string): string {
  return createHash("sha256").update(sid, "utf8").digest("hex");
}

export function pipeNameForSid(sid: string): string {
  return `${PIPE_NAME_PREFIX}${userSidHash(sid)}`;
}

export async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"]);
  const match = /"(S-[0-9-]+)"/.exec(stdout);
  const sid = match?.[1];
  if (sid === undefined) {
    throw new BrokerProtocolError("unable to resolve user SID");
  }
  return sid;
}

export function newGeneralId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function newClientNonce(): string {
  return randomBytes(32).toString("base64url");
}

function utf8Bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function parseCanonical<T>(
  bytes: Uint8Array,
  check: (value: unknown) => value is T,
  label: string,
): T {
  const text = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BrokerProtocolError(`${label} is not JSON`);
  }
  if (!check(parsed)) {
    throw new BrokerProtocolError(`${label} failed schema`);
  }
  if (canonicalizeRfc8785(parsed) !== text) {
    throw new BrokerProtocolError(`${label} is not RFC8785`);
  }
  return parsed;
}

export class BrokerClient implements BrokerPort {
  readonly brokerInstanceId: string;
  readonly connectionId: string;
  private sequence = 1;

  private constructor(
    private readonly transport: BrokerTransport,
    hello: BrokerHello,
  ) {
    this.brokerInstanceId = hello.brokerInstanceId;
    this.connectionId = hello.connectionId;
  }

  static async connect(transport: BrokerTransport, claim: ProcessClaim): Promise<BrokerClient> {
    const helloBytes = await transport.receive();
    const hello = parseCanonical(
      helloBytes,
      (value): value is BrokerHello => HELLO.Check(value),
      "BrokerHello",
    );
    const clientHello: PiClientHello = {
      protocolVersion: 1,
      connectionId: hello.connectionId,
      clientInstanceId: claim.clientInstanceId,
      clientNonce: newClientNonce(),
      claimedProcessId: claim.claimedProcessId,
      claimedProcessCreationTime: claim.claimedProcessCreationTime,
    };
    if (!CLIENT_HELLO.Check(clientHello)) {
      throw new BrokerProtocolError("PiClientHello failed schema");
    }
    await transport.send(utf8Bytes(canonicalizeRfc8785(clientHello)));
    return new BrokerClient(transport, hello);
  }

  async request(body: BrokerRequest): Promise<BrokerResponse> {
    if (!REQUEST.Check(body)) {
      throw new BrokerProtocolError("BrokerRequest failed schema");
    }
    if (body.method === "OPEN_TRUSTED_VIEW" && !isTrustedView(body.params.view)) {
      throw new BrokerProtocolError("unknown trusted view");
    }
    const frame = {
      protocolVersion: 1 as const,
      connectionId: this.connectionId,
      sequence: this.sequence,
      body,
    };
    this.sequence += 1;
    await this.transport.send(utf8Bytes(canonicalizeRfc8785(frame)));
    const responseBytes = await this.transport.receive();
    const parsed = parseCanonical(
      responseBytes,
      (value): value is BrokerResponse => RESPONSE.Check(value),
      "BrokerResponse",
    );
    if (parsed.requestId !== body.requestId) {
      throw new BrokerProtocolError("requestId mismatch");
    }
    return parsed;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export async function connectNamedPipe(pipeName: string): Promise<BrokerTransport> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connected = createConnection(pipeName);
    const onError = (error: Error): void => {
      connected.off("connect", onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      connected.off("error", onError);
      resolve(connected);
    };
    connected.once("error", onError);
    connected.once("connect", onConnect);
  });
  socket.setNoDelay(true);
  return {
    async send(body: Uint8Array): Promise<void> {
      const framed = encodeFrame(body);
      await new Promise<void>((resolve, reject) => {
        socket.write(framed, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    receive(): Promise<Uint8Array> {
      return readFramedBody(socket);
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => {
          resolve();
        });
        socket.destroy();
      });
    },
  };
}

export async function connectLocalBrokerPipe(claim: ProcessClaim): Promise<BrokerClient> {
  const sid = await currentUserSid();
  const transport = await connectNamedPipe(pipeNameForSid(sid));
  return BrokerClient.connect(transport, claim);
}

const FILETIME_UNIX_EPOCH_TICKS = 116444736000000000n;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type FiletimeParts = {
  dwLowDateTime: number;
  dwHighDateTime: number;
};

export type ProcessTimesProbe = () => FiletimeParts | undefined;

type GetProcessTimesFn = (
  handle: unknown,
  creation: FiletimeParts,
  exit: FiletimeParts,
  kernel: FiletimeParts,
  user: FiletimeParts,
) => boolean;

type Kernel32Api = {
  GetCurrentProcess: () => unknown;
  GetProcessTimes: GetProcessTimesFn;
  CloseHandle: (handle: unknown) => boolean;
};

type Advapi32Api = {
  OpenProcessToken: (process: unknown, access: number, tokenOut: unknown[]) => boolean;
  GetTokenInformation: (
    token: unknown,
    infoClass: number,
    valueOut: unknown[],
    length: number,
    neededOut: unknown[],
  ) => boolean;
};

const TOKEN_QUERY = 0x0008;
const TOKEN_HAS_RESTRICTIONS = 21;
const TOKEN_IS_APP_CONTAINER = 29;

let memoizedCreationTime: string | undefined;
let kernel32Api: Kernel32Api | undefined;
let advapi32Api: Advapi32Api | undefined;

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

function civilFromUnix(secs: bigint): readonly [number, number, number, number, number, number] {
  const daySecs = 86400n;
  const days = secs / daySecs;
  const remnant = Number(secs % daySecs);
  const hour = Math.trunc(remnant / 3600);
  const minute = Math.trunc((remnant % 3600) / 60);
  const second = remnant % 60;
  const z = days + 719468n;
  const era = z / 146097n;
  const doe = Number(z % 146097n);
  const yoe = Math.trunc(
    (doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365,
  );
  const y = BigInt(yoe) + era * 400n;
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = Number(month <= 2 ? y + 1n : y);
  return [year, month, day, hour, minute, second];
}

export function unixMillisToRfc3339(ms: bigint | number): string {
  const total = typeof ms === "bigint" ? ms : BigInt(ms);
  if (total < 0n) {
    throw new Error("unix millis before epoch");
  }
  const secs = total / 1000n;
  const millis = Number(total % 1000n);
  const [year, month, day, hour, minute, second] = civilFromUnix(secs);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`;
}

export function filetimePartsToTicks(parts: FiletimeParts): bigint {
  return (BigInt(parts.dwHighDateTime >>> 0) << 32n) | BigInt(parts.dwLowDateTime >>> 0);
}

export function filetimePartsToRfc3339(parts: FiletimeParts): string {
  const ticks = filetimePartsToTicks(parts);
  const unixMs =
    ticks < FILETIME_UNIX_EPOCH_TICKS ? 0n : (ticks - FILETIME_UNIX_EPOCH_TICKS) / 10000n;
  return unixMillisToRfc3339(unixMs);
}

export function filetimeEpochParts(): FiletimeParts {
  return {
    dwLowDateTime: Number(FILETIME_UNIX_EPOCH_TICKS & 0xffffffffn),
    dwHighDateTime: Number(FILETIME_UNIX_EPOCH_TICKS >> 32n),
  };
}

function loadKernel32(): Kernel32Api {
  if (kernel32Api !== undefined) {
    return kernel32Api;
  }
  if (process.platform !== "win32") {
    throw new Error("GetProcessTimes requires win32");
  }
  const kernel32 = koffi.load("kernel32.dll");
  koffi.struct("FILETIME", {
    dwLowDateTime: "uint32",
    dwHighDateTime: "uint32",
  });
  const api: Kernel32Api = {
    GetCurrentProcess: kernel32.func(
      "void * __stdcall GetCurrentProcess()",
    ) as Kernel32Api["GetCurrentProcess"],
    GetProcessTimes: kernel32.func(
      "bool __stdcall GetProcessTimes(void *hProcess, _Out_ FILETIME *lpCreationTime, _Out_ FILETIME *lpExitTime, _Out_ FILETIME *lpKernelTime, _Out_ FILETIME *lpUserTime)",
    ) as GetProcessTimesFn,
    CloseHandle: kernel32.func(
      "bool __stdcall CloseHandle(void *hObject)",
    ) as Kernel32Api["CloseHandle"],
  };
  kernel32Api = api;
  return api;
}

function loadAdvapi32(): Advapi32Api {
  if (advapi32Api !== undefined) {
    return advapi32Api;
  }
  if (process.platform !== "win32") {
    throw new Error("token probe requires win32");
  }
  const advapi32 = koffi.load("advapi32.dll");
  const api: Advapi32Api = {
    OpenProcessToken: advapi32.func(
      "bool __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)",
    ) as Advapi32Api["OpenProcessToken"],
    GetTokenInformation: advapi32.func(
      "bool __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint32 *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)",
    ) as Advapi32Api["GetTokenInformation"],
  };
  advapi32Api = api;
  return api;
}

function tokenDword(token: unknown, infoClass: number): number | undefined {
  const advapi = loadAdvapi32();
  const value: unknown[] = [null];
  const needed: unknown[] = [null];
  const ok = advapi.GetTokenInformation(token, infoClass, value, 4, needed);
  if (!ok) {
    return undefined;
  }
  const dword = value[0];
  return typeof dword === "number" ? dword : undefined;
}

export function readCurrentProcessIsAppContainer(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const kernel = loadKernel32();
    const advapi = loadAdvapi32();
    const tokenOut: unknown[] = [null];
    const opened = advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_QUERY, tokenOut);
    const token = tokenOut[0];
    if (!opened || token === undefined || token === null) {
      return false;
    }
    try {
      const appContainer = tokenDword(token, TOKEN_IS_APP_CONTAINER);
      const restricted = tokenDword(token, TOKEN_HAS_RESTRICTIONS);
      return appContainer !== undefined && appContainer !== 0 && restricted !== undefined && restricted !== 0;
    } finally {
      kernel.CloseHandle(token);
    }
  } catch {
    return false;
  }
}

function nativeFiletime(): FiletimeParts | undefined {
  try {
    const api = loadKernel32();
    const creation: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const exit: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const kernel: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const user: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const ok = api.GetProcessTimes(api.GetCurrentProcess(), creation, exit, kernel, user);
    if (!ok) {
      return undefined;
    }
    if (creation.dwLowDateTime === 0 && creation.dwHighDateTime === 0) {
      return undefined;
    }
    return creation;
  } catch {
    return undefined;
  }
}

export function readProcessCreationTime(probe?: ProcessTimesProbe): string {
  if (memoizedCreationTime !== undefined && probe === undefined) {
    return memoizedCreationTime;
  }
  const parts = probe !== undefined ? probe() : nativeFiletime();
  if (parts === undefined) {
    throw new Error("GetProcessTimes failed");
  }
  const formatted = filetimePartsToRfc3339(parts);
  if (!RFC3339.test(formatted)) {
    throw new Error("GetProcessTimes failed");
  }
  if (probe === undefined) {
    memoizedCreationTime = formatted;
  }
  return formatted;
}

export function createProcessClaim(probe?: ProcessTimesProbe): ProcessClaim {
  return {
    claimedProcessId: process.pid,
    claimedProcessCreationTime: readProcessCreationTime(probe),
    clientInstanceId: newGeneralId("client_"),
  };
}

export function processClaimOrInjected(
  claim: ProcessClaim | undefined,
  probe?: ProcessTimesProbe,
): ProcessClaim {
  if (claim !== undefined) {
    return claim;
  }
  return createProcessClaim(probe);
}
