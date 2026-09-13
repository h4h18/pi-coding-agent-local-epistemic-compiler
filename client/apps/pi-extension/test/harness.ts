import type { CustomEntry, EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { BrokerRequest, BrokerResponse, RunProjection } from "@pi-hec/contracts";
import {
  createHecExtension,
  type HecContext,
} from "../src/commands.js";
import type { BrokerPort, BrokerTransport } from "../src/broker-client.js";

export const RUN_ID = "run_01234567-89ab-7cde-8f01-23456789abcd" as const;
export const SNAP_ID = "snap_01234567-89ab-7cde-8f01-23456789abcd" as const;
export const DIGEST = `sha256:${"ab".repeat(32)}` as const;
export const TS = "2026-01-02T03:04:05.006Z";
export const OP_ID = "op_01234567-89ab-7cde-8f01-23456789abcd" as const;

export function sampleRun(overrides: Partial<RunProjection> = {}): RunProjection {
  return {
    schemaVersion: 1,
    projectId: "proj1",
    runId: RUN_ID,
    workspaceId: "ws1",
    state: "CREATED",
    stateVersion: 1,
    artifactRoles: [],
    updatedAt: TS,
    ...overrides,
  };
}

export class RecordingBroker implements BrokerPort {
  readonly brokerInstanceId = "broker-test";
  readonly connectionId = "conn-test";
  readonly calls: BrokerRequest[] = [];
  closed = false;
  run: RunProjection;
  pollEvents: BrokerResponse | undefined;

  constructor(run: RunProjection = sampleRun()) {
    this.run = run;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  request(body: BrokerRequest): BrokerResponse {
    this.calls.push(body);
    switch (body.method) {
      case "START_RUN":
      case "GET_RUN_STATUS":
      case "RESUME_RUN":
        return { requestId: body.requestId, outcome: "RUN", run: this.run };
      case "POLL_RUN_EVENTS":
        if (this.pollEvents !== undefined) {
          return { ...this.pollEvents, requestId: body.requestId };
        }
        return {
          requestId: body.requestId,
          outcome: "EVENTS",
          page: { schemaVersion: 1, events: [], nextAfter: null },
        };
      case "OPEN_TRUSTED_VIEW":
      case "OPEN_APPROVAL":
        return {
          requestId: body.requestId,
          outcome: "TRUSTED_UI_OPENED",
          trustedUiSessionId: "tui_1",
          nonce: "nonce-trusted-ui",
        };
      case "LIST_AGENTS":
        return {
          requestId: body.requestId,
          outcome: "AGENTS",
          agents: {
            schemaVersion: 1,
            runId: this.run.runId,
            state: this.run.state,
            agents: [],
          },
        };
      case "REQUEST_REPAIR":
      case "CANCEL_RUN":
      case "PROVIDE_INPUT":
        return {
          requestId: body.requestId,
          outcome: "OPERATION_ACCEPTED",
          operation: {
            schemaVersion: 1,
            projectId: "proj1",
            operationId: OP_ID,
            runId: this.run.runId,
            kind: "REQUEST_REPAIR",
            state: "ready",
            leaseGeneration: 0,
            updatedAt: TS,
          },
        };
      default: {
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

export class QueueTransport implements BrokerTransport {
  readonly sent: Uint8Array[] = [];
  readonly #incoming: Uint8Array[];

  constructor(incoming: readonly Uint8Array[]) {
    this.#incoming = [...incoming];
  }

  send(body: Uint8Array): void {
    this.sent.push(body);
  }

  receive(): Uint8Array {
    const next = this.#incoming.shift();
    if (next === undefined) {
      throw new Error("no queued frame");
    }
    return next;
  }

  close(): void {
    return;
  }
}

type CommandHandler = (args: string, ctx: HecContext) => Promise<void>;
type Listener = (event: never, ctx: never) => unknown;

export class FakePi {
  readonly commands = new Map<string, { description?: string; handler: CommandHandler }>();
  readonly listeners = new Map<string, Listener[]>();
  readonly entries: CustomEntry[] = [];
  readonly renderers = new Map<string, EntryRenderer<never>>();
  readonly notifications: string[] = [];
  promptCalls = 0;
  cwd = "C:\\Users\\Administrator\\demo-workspace";

  registerCommand(name: string, options: { description?: string; handler: CommandHandler }): void {
    this.commands.set(name, options);
  }

  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void {
    this.renderers.set(customType, renderer);
  }

  on(event: string, handler: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({
      type: "custom",
      customType,
      data,
      id: `entry_${String(this.entries.length)}`,
      parentId: null,
      timestamp: TS,
    });
  }

  prompt(): void {
    this.promptCalls += 1;
  }

  context(): HecContext {
    return {
      cwd: this.cwd,
      ui: {
        notify: (message: string) => {
          this.notifications.push(message);
        },
      },
      sessionManager: {
        getEntries: () => this.entries,
      },
    };
  }

  install(broker: BrokerPort, options: Parameters<typeof createHecExtension>[0] = {}): void {
    createHecExtension({ ...options, broker })(this);
  }

  async runCommand(args: string): Promise<void> {
    const command = this.commands.get("hec");
    if (command === undefined) {
      throw new Error("hec command not registered");
    }
    await command.handler(args, this.context());
  }

  async emit(event: string, payload: unknown): Promise<unknown> {
    let last: unknown;
    const ctx = this.context();
    for (const handler of this.listeners.get(event) ?? []) {
      last = await Reflect.apply(handler, undefined, [payload, ctx]);
    }
    return last;
  }

  async emitInput(text: string): Promise<unknown> {
    return this.emit("input", { type: "input", text, source: "interactive" });
  }
}
