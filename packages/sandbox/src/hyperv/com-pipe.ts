import net from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const RESULT_RE = /HEC_RESULT ({[^\r\n]*})/;
const READY_RE = /HEC_READY/;

export type GuestFrame = {
  ec: number;
  term: "EXITED" | "SIGNALLED" | "SAFETY_LIMIT";
  out: string;
  err: string;
  nproc: number;
  wrote: number;
  priv: number;
  ns: number;
  ulimit: number;
};

export type ComPipeWaiter = {
  waitReady(timeoutMs: number): Promise<boolean>;
  sendInject(text: string): boolean;
  wait(timeoutMs: number): Promise<GuestFrame | undefined>;
  close(): Promise<void>;
  captured(): string;
  serialLogPath: string;
};

function isGuestFrame(value: unknown): value is GuestFrame {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as { [key: string]: unknown };
  return (
    typeof record.ec === "number" &&
    (record.term === "EXITED" || record.term === "SIGNALLED" || record.term === "SAFETY_LIMIT") &&
    typeof record.out === "string" &&
    typeof record.err === "string"
  );
}

export function parseGuestFrame(json: string): GuestFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isGuestFrame(parsed)) {
      return undefined;
    }
    const rec = parsed as { nproc?: unknown; wrote?: unknown; priv?: unknown; ns?: unknown; ulimit?: unknown };
    return {
      ...parsed,
      nproc: typeof rec.nproc === "number" ? rec.nproc : 0,
      wrote: typeof rec.wrote === "number" ? rec.wrote : 0,
      priv: typeof rec.priv === "number" ? rec.priv : 0,
      ns: typeof rec.ns === "number" ? rec.ns : 0,
      ulimit: typeof rec.ulimit === "number" ? rec.ulimit : 0,
    };
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function serialLogPathFor(vmName: string): string {
  return path.join(tmpdir(), `${vmName}.serial.log`);
}

export async function listenComPipe(pipePath: string, vmName: string): Promise<ComPipeWaiter> {
  let buffer = "";
  let frame: GuestFrame | undefined;
  let ready = false;
  let readySocket: net.Socket | undefined;
  const sockets: net.Socket[] = [];
  const serialLogPath = serialLogPathFor(vmName);
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!ready && READY_RE.test(buffer)) {
        ready = true;
        readySocket = socket;
      }
      const match = RESULT_RE.exec(buffer);
      if (match?.[1] !== undefined && frame === undefined) {
        const parsedFrame = parseGuestFrame(match[1]);
        if (parsedFrame !== undefined) {
          frame = parsedFrame;
        } else {
          buffer = buffer.slice(-1_000_000);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      resolve();
    });
  });
  return {
    serialLogPath,
    captured: () => buffer,
    async waitReady(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ready) {
          return true;
        }
        await sleep(200);
      }
      return ready;
    },
    sendInject(text) {
      const targets = readySocket !== undefined && !readySocket.destroyed ? [readySocket] : sockets.filter((socket) => !socket.destroyed);
      if (targets.length === 0) {
        return false;
      }
      for (const socket of targets) {
        socket.write(text);
      }
      return true;
    },
    async wait(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (frame !== undefined) {
          return frame;
        }
        await sleep(200);
      }
      return frame;
    },
    async close() {
      await writeFile(serialLogPath, buffer, "utf8").catch(() => undefined);
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
