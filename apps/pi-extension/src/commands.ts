import type {
  ExtensionAPI,
  InputEvent,
  InputEventResult,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { BrokerRequest, BrokerResponse, ObjectDigest, RunId, RunProjection, RunTransitionEvent } from "@pi-hec/contracts";
import type { ApprovalAction } from "./ui/approvals.js";
import {
  BrokerClient,
  BrokerProtocolError,
  connectLocalBrokerPipe,
  isTrustedView,
  newGeneralId,
  type BrokerPort,
  type BrokerTransport,
  processClaimOrInjected,
  type ProcessClaim,
  type ProcessTimesProbe,
  type TrustedView,
} from "./broker-client.js";
import {
  COMPATIBILITY_UNCONFINED,
  HEC_RUN_POINTER_TYPE,
  defaultConfinementProbe,
  emptyPointer,
  firstDigestForRole,
  isRunId,
  latestPointer,
  workspaceAliasFromCwd,
  type ConfinementAssessment,
  type HecRunPointer,
  type SecurityMode,
} from "./session-pointer.js";
import { formatApprovalPreview, renderApprovalPreview } from "./ui/approvals.js";
import { CONTEXT_TRUSTED_VIEW, contextViewNotice } from "./ui/context-view.js";
import { DIFF_TRUSTED_VIEW, diffViewNotice } from "./ui/diff-view.js";
import { createStatusEntryRenderer, renderTransitionEventLine } from "./ui/status-widget.js";
import {
  parseUsageScope,
  renderUsageView,
  USAGE_EXPORT_VIEW,
  type UsageProjection,
  type UsageScope,
} from "./ui/usage-view.js";

const APPROVAL_ACTIONS: readonly ApprovalAction[] = [
  "cloud-egress",
  "command",
  "workspace-promotion",
  "project-trust",
  "project-policy",
  "workspace-registration",
];

const VIEW_COMMANDS: Readonly<Record<string, TrustedView>> = {
  context: CONTEXT_TRUSTED_VIEW,
  diff: DIFF_TRUSTED_VIEW,
  verify: "VERIFICATION",
  inspect: "ARTIFACTS",
  export: USAGE_EXPORT_VIEW,
};

export type HecContext = {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager: {
    getEntries(): SessionEntry[];
  };
};

export type PiHost = Pick<ExtensionAPI, "registerCommand" | "registerEntryRenderer" | "on" | "appendEntry">;

export type HecExtensionOptions = {
  broker?: BrokerPort;
  transport?: BrokerTransport;
  confinement?: () => ConfinementAssessment;
  securityMode?: SecurityMode;
  workspaceAlias?: string;
  controlEndpointIdentity?: string;
  processClaim?: ProcessClaim;
  processTimes?: ProcessTimesProbe;
  usageProjection?: (input: { scope: UsageScope; run: RunProjection | undefined }) => UsageProjection | undefined;
};

export function parseApprovalAction(value: string): ApprovalAction | undefined {
  return APPROVAL_ACTIONS.find((action) => action === value);
}

export function inferApprovalAction(run: RunProjection): ApprovalAction | undefined {
  const promotion = firstDigestForRole(run, "verdict-report")
    ?? firstDigestForRole(run, "validated-changeset")
    ?? firstDigestForRole(run, "candidate-manifest");
  const egress = firstDigestForRole(run, "egress-manifest")
    ?? firstDigestForRole(run, "canonical-cloud-request");
  if (promotion !== undefined && egress !== undefined) {
    return undefined;
  }
  if (promotion !== undefined) {
    return "workspace-promotion";
  }
  if (egress !== undefined) {
    return "cloud-egress";
  }
  return undefined;
}

function requireRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error("run id missing");
  }
  return value;
}

function notify(ctx: HecContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

function requestId(): string {
  return newGeneralId("req_");
}

export class HecRuntime {
  private pointer: HecRunPointer;
  private broker: BrokerPort | undefined;
  private lastRunProjection: RunProjection | undefined;
  private brokerClosed = false;
  private readonly confinement: () => ConfinementAssessment;
  private readonly securityMode: SecurityMode;
  private readonly workspaceAliasOverride: string | undefined;
  private readonly controlEndpointOverride: string | undefined;

  constructor(
    private readonly pi: PiHost,
    private readonly options: HecExtensionOptions,
  ) {
    this.confinement = options.confinement ?? defaultConfinementProbe;
    this.securityMode = options.securityMode ?? "production";
    this.workspaceAliasOverride = options.workspaceAlias;
    this.controlEndpointOverride = options.controlEndpointIdentity;
    this.broker = options.broker;
    this.pointer = emptyPointer({
      controlEndpointIdentity: options.controlEndpointIdentity ?? "unconnected",
      securityMode: this.securityMode,
      workspaceAlias: options.workspaceAlias ?? "workspace",
      confined: this.confinement().confined,
    });
    this.pi.registerEntryRenderer(HEC_RUN_POINTER_TYPE, createStatusEntryRenderer(() => this.lastRun));
  }

  get lastRun(): RunProjection | undefined {
    return this.lastRunProjection;
  }

  persist(): void {
    this.pi.appendEntry(HEC_RUN_POINTER_TYPE, this.pointer);
  }

  restoreFrom(ctx: HecContext): void {
    const restored = latestPointer(ctx.sessionManager.getEntries());
    if (restored !== undefined) {
      this.pointer = this.applyLiveConfinement(restored);
      this.persist();
    }
  }

  private applyLiveConfinement(pointer: HecRunPointer): HecRunPointer {
    const confined = this.confinement().confined;
    return {
      ...pointer,
      uiPreferences: {
        ...pointer.uiPreferences,
        securityMode: this.securityMode,
        roleIsolationClaimed: confined && this.securityMode === "production",
        confinementMark: confined ? null : COMPATIBILITY_UNCONFINED,
      },
    };
  }

  isHecModeEnabled(): boolean {
    return this.pointer.uiPreferences.hecModeEnabled;
  }

  async ensureBroker(): Promise<BrokerPort> {
    if (this.brokerClosed) {
      throw new BrokerProtocolError("broker port closed");
    }
    if (this.broker !== undefined) {
      return this.broker;
    }
    const claim = processClaimOrInjected(this.options.processClaim, this.options.processTimes);
    if (this.options.transport !== undefined) {
      this.broker = await BrokerClient.connect(this.options.transport, claim);
    } else {
      this.broker = await connectLocalBrokerPipe(claim);
    }
    this.pointer = {
      ...this.pointer,
      controlEndpointIdentity: this.controlEndpointOverride ?? this.broker.brokerInstanceId,
    };
    return this.broker;
  }

  async brokerCall(body: BrokerRequest): Promise<BrokerResponse> {
    const broker = await this.ensureBroker();
    return await broker.request(body);
  }

  async getRun(runId: RunId): Promise<RunProjection> {
    const response = await this.brokerCall({
      requestId: requestId(),
      method: "GET_RUN_STATUS",
      params: { runId },
    });
    if (response.outcome !== "RUN") {
      throw new Error(response.outcome === "ERROR" ? response.error.message : "GET_RUN_STATUS failed");
    }
    this.lastRunProjection = response.run;
    this.pointer = {
      ...this.pointer,
      activeRunId: requireRunId(response.run.runId),
    };
    this.persist();
    return response.run;
  }

  async startRun(ctx: HecContext, originalRequest: string): Promise<void> {
    if (!this.allowStart()) {
      notify(ctx, "HEC refused: production mode requires confined Pi", "error");
      return;
    }
    const alias = this.workspaceAliasOverride ?? this.pointer.uiPreferences.workspaceAlias;
    const response = await this.brokerCall({
      requestId: requestId(),
      method: "START_RUN",
      params: {
        workspaceAlias: alias,
        originalRequest,
        attachmentHandles: [],
      },
    });
    if (response.outcome !== "RUN") {
      notify(ctx, response.outcome === "ERROR" ? response.error.message : "START_RUN failed", "error");
      return;
    }
    this.lastRunProjection = response.run;
    this.pointer = {
      ...this.pointer,
      activeRunId: requireRunId(response.run.runId),
      controlEndpointIdentity: this.controlEndpointOverride ?? this.pointer.controlEndpointIdentity,
    };
    this.persist();
    notify(ctx, `HEC started ${response.run.runId}`);
  }

  allowStart(): boolean {
    const confined = this.confinement().confined;
    if (this.securityMode === "production" && !confined) {
      return false;
    }
    return true;
  }

  enableMode(ctx: HecContext): boolean {
    const confined = this.confinement().confined;
    if (this.securityMode === "production" && !confined) {
      notify(ctx, "HEC refused: production mode requires confined Pi", "error");
      return false;
    }
    this.pointer.uiPreferences.hecModeEnabled = true;
    this.pointer.uiPreferences.securityMode = this.securityMode;
    this.pointer.uiPreferences.workspaceAlias =
      this.workspaceAliasOverride ?? workspaceAliasFromCwd(ctx.cwd);
    this.pointer.uiPreferences.roleIsolationClaimed = confined && this.securityMode === "production";
    this.pointer.uiPreferences.confinementMark = confined ? null : COMPATIBILITY_UNCONFINED;
    this.persist();
    notify(ctx, confined ? "HEC mode on" : "HEC mode on (COMPATIBILITY_UNCONFINED)");
    return true;
  }

  disableMode(ctx: HecContext): void {
    this.pointer.uiPreferences.hecModeEnabled = false;
    this.persist();
    notify(ctx, "HEC mode off");
  }

  resolveRunId(token: string | undefined): RunId | undefined {
    if (token !== undefined && isRunId(token)) {
      return token;
    }
    return this.pointer.activeRunId ?? undefined;
  }

  async openTrusted(ctx: HecContext, runId: RunId, view: TrustedView, notice?: string): Promise<void> {
    if (!isTrustedView(view)) {
      notify(ctx, "unknown trusted view", "error");
      return;
    }
    const response = await this.brokerCall({
      requestId: requestId(),
      method: "OPEN_TRUSTED_VIEW",
      params: { runId, view },
    });
    if (response.outcome === "ERROR") {
      notify(ctx, response.error.message, "error");
      return;
    }
    notify(ctx, notice ?? `Opened ${view}`);
  }

  async openApproval(
    ctx: HecContext,
    runId: RunId,
    action: ApprovalAction,
    subjectObjectDigest: ObjectDigest,
  ): Promise<void> {
    const preview = renderApprovalPreview({ runId, action, subjectObjectDigest });
    for (const line of formatApprovalPreview(preview)) {
      notify(ctx, line, "warning");
    }
    const response = await this.brokerCall({
      requestId: requestId(),
      method: "OPEN_APPROVAL",
      params: { runId, action, subjectObjectDigest },
    });
    if (response.outcome === "ERROR") {
      notify(ctx, response.error.message, "error");
    }
  }

  async handleCommand(args: string, ctx: HecContext): Promise<void> {
    const trimmed = args.trim();
    const space = trimmed.indexOf(" ");
    const verb = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
    try {
      await this.dispatch(verb, rest, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : "HEC command failed";
      notify(ctx, message, "error");
    }
  }

  async onSessionStart(_event: SessionStartEvent, ctx: HecContext): Promise<void> {
    this.restoreFrom(ctx);
    const runId = this.pointer.activeRunId;
    if (runId === null) {
      return;
    }
    try {
      const run = await this.getRun(runId);
      const page = await this.brokerCall({
        requestId: requestId(),
        method: "POLL_RUN_EVENTS",
        params: {
          runId,
          afterSequence: this.pointer.lastDisplayedEventSequence,
          limit: 200,
        },
      });
      if (page.outcome === "EVENTS") {
        const displayed = this.handoffEventsToStatus(ctx, page.page.events);
        if (displayed !== undefined) {
          this.pointer = {
            ...this.pointer,
            lastDisplayedEventSequence: displayed,
          };
          this.persist();
        }
      }
      this.lastRunProjection = run;
    } catch (error) {
      const message = error instanceof Error ? error.message : "restore failed";
      notify(ctx, message, "error");
    }
  }

  async onInput(event: InputEvent, ctx: HecContext): Promise<InputEventResult | undefined> {
    if (!this.isHecModeEnabled()) {
      return undefined;
    }
    if (!this.allowStart()) {
      notify(ctx, "HEC refused: production mode requires confined Pi", "error");
      return { action: "handled" };
    }
    await this.startRun(ctx, event.text);
    return { action: "handled" };
  }

  onToolCall(): ToolCallEventResult | undefined {
    if (!this.isHecModeEnabled()) {
      return undefined;
    }
    return { block: true, terminate: true, reason: "HEC mode blocks ordinary Pi tools" };
  }

  async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
    switch (event.reason) {
      case "quit":
      case "reload":
      case "new":
      case "resume":
      case "fork":
        await this.closeBroker();
        return;
      default: {
        const exhaustive: never = event.reason;
        throw new Error(exhaustive);
      }
    }
  }

  onUserBash(): UserBashEventResult | undefined {
    if (!this.isHecModeEnabled()) {
      return undefined;
    }
    return {
      result: {
        output: "HEC mode blocks local shell execution",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  }

  async closeBroker(): Promise<void> {
    this.brokerClosed = true;
    const broker = this.broker;
    this.broker = undefined;
    if (broker !== undefined) {
      await broker.close();
    }
  }

  private handoffEventsToStatus(ctx: HecContext, events: readonly RunTransitionEvent[]): number | undefined {
    let displayed: number | undefined;
    for (const event of events) {
      notify(ctx, renderTransitionEventLine(event));
      displayed = displayed === undefined ? event.sequence : Math.max(displayed, event.sequence);
    }
    return displayed;
  }

  private async dispatch(verb: string, rest: string, ctx: HecContext): Promise<void> {
    switch (verb) {
      case "init":
        await this.ensureBroker();
        this.pointer.uiPreferences.workspaceAlias =
          this.workspaceAliasOverride ?? workspaceAliasFromCwd(ctx.cwd);
        this.persist();
        notify(ctx, `HEC init ${this.pointer.uiPreferences.workspaceAlias}`);
        return;
      case "mode":
        if (rest === "on") {
          this.enableMode(ctx);
          return;
        }
        if (rest === "off") {
          this.disableMode(ctx);
          return;
        }
        notify(ctx, "usage: /hec mode on|off", "error");
        return;
      case "task":
        if (rest.length === 0) {
          notify(ctx, "usage: /hec task <text>", "error");
          return;
        }
        if (!this.allowStart()) {
          notify(ctx, "HEC refused: production mode requires confined Pi", "error");
          return;
        }
        await this.startRun(ctx, rest);
        return;
      case "status": {
        const runId = this.resolveRunId(rest.length === 0 ? undefined : rest);
        if (runId === undefined) {
          notify(ctx, "no active run", "error");
          return;
        }
        const run = await this.getRun(runId);
        notify(ctx, `HEC ${run.runId} ${run.state}`);
        return;
      }
      case "context":
      case "diff":
      case "verify":
      case "inspect":
      case "export": {
        const runId = this.resolveRunId(rest);
        const view = VIEW_COMMANDS[verb];
        if (runId === undefined || view === undefined) {
          notify(ctx, `usage: /hec ${verb} <run-id>`, "error");
          return;
        }
        const notice =
          verb === "context" ? contextViewNotice(runId) : verb === "diff" ? diffViewNotice(runId) : undefined;
        await this.openTrusted(ctx, runId, view, notice);
        return;
      }
      case "usage": {
        const token = rest.length === 0 ? undefined : rest.split(/\s+/u)[0];
        const scoped = token === "session" || token === "day" || token === "project";
        const runId = scoped ? this.pointer.activeRunId ?? undefined : this.resolveRunId(token);
        const run = runId !== undefined ? await this.getRun(runId) : this.lastRun;
        const scope = parseUsageScope(scoped ? token : "run");
        const projection = this.options.usageProjection?.({ scope, run });
        for (const line of renderUsageView({
          scope,
          run,
          ...(projection === undefined ? {} : { projection }),
        })) {
          notify(ctx, line);
        }
        if (runId !== undefined) {
          await this.openTrusted(ctx, runId, USAGE_EXPORT_VIEW);
        }
        return;
      }
      case "approve":
      case "apply":
      case "reject":
        await this.handleApprovalVerb(verb, rest, ctx);
        return;
      case "repair": {
        const runId = this.resolveRunId(rest);
        if (runId === undefined) {
          notify(ctx, "usage: /hec repair <run-id>", "error");
          return;
        }
        const run = await this.getRun(runId);
        const verdict = firstDigestForRole(run, "verdict-report");
        if (verdict === undefined) {
          notify(ctx, "repair refused: verdict-report digest missing", "error");
          return;
        }
        const response = await this.brokerCall({
          requestId: requestId(),
          method: "REQUEST_REPAIR",
          params: {
            runId,
            expectedStateVersion: run.stateVersion,
            verdictReportObjectDigest: verdict,
          },
        });
        if (response.outcome === "ERROR") {
          notify(ctx, response.error.message, "error");
        }
        return;
      }
      case "cancel": {
        const runId = this.resolveRunId(rest);
        if (runId === undefined) {
          notify(ctx, "usage: /hec cancel <run-id>", "error");
          return;
        }
        const run = await this.getRun(runId);
        const response = await this.brokerCall({
          requestId: requestId(),
          method: "CANCEL_RUN",
          params: {
            runId,
            expectedStateVersion: run.stateVersion,
            reason: "user-cancel",
          },
        });
        if (response.outcome === "ERROR") {
          notify(ctx, response.error.message, "error");
        }
        return;
      }
      case "resume": {
        const runId = this.resolveRunId(rest);
        if (runId === undefined) {
          notify(ctx, "usage: /hec resume <run-id>", "error");
          return;
        }
        const response = await this.brokerCall({
          requestId: requestId(),
          method: "RESUME_RUN",
          params: { runId },
        });
        if (response.outcome === "ERROR") {
          notify(ctx, response.error.message, "error");
        }
        return;
      }
      default:
        notify(ctx, "unknown /hec command", "error");
        return;
    }
  }

  private async handleApprovalVerb(
    verb: "approve" | "apply" | "reject",
    rest: string,
    ctx: HecContext,
  ): Promise<void> {
    const parts = rest.split(/\s+/u).filter((part) => part.length > 0);
    const runToken = parts[0];
    if (runToken === undefined || !isRunId(runToken)) {
      notify(ctx, `usage: /hec ${verb} <run-id>${verb === "approve" ? " <action>" : verb === "reject" ? " <reason>" : ""}`, "error");
      return;
    }
    const run = await this.getRun(runToken);
    const subject = firstDigestForRole(run, "approval-subject");
    if (subject === undefined) {
      notify(ctx, `${verb} refused: approval-subject digest missing`, "error");
      return;
    }
    let action: ApprovalAction | undefined;
    switch (verb) {
      case "approve":
        action = parts[1] === undefined ? undefined : parseApprovalAction(parts[1]);
        break;
      case "apply":
        action = "workspace-promotion";
        break;
      case "reject":
        action = inferApprovalAction(run);
        break;
      default: {
        const exhaustive: never = verb;
        throw new Error(exhaustive);
      }
    }
    if (action === undefined) {
      notify(ctx, `${verb} refused: approval action unavailable`, "error");
      return;
    }
    await this.openApproval(ctx, runToken, action, subject);
  }
}
