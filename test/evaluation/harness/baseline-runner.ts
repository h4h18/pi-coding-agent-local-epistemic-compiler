import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export const ORDINARY_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const ORDINARY_PI_VERSION = "0.84.3";

export type BaselineSession = Pick<AgentSession, "prompt"> & {
  subscribe?: (listener: (event: { type: string }) => void) => () => void;
  messages?: readonly { role?: string }[];
  getSessionStats?: () => { assistantMessages: number };
};

export type BaselineSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<{ session: BaselineSession }>;

export type BaselineRunResult = {
  readonly promptTurns: number;
  readonly stoppedNaturally: boolean;
  readonly tools: readonly string[];
};

const ORDINARY_TOOLS = ["read", "bash", "edit", "write"] as const;

export function ordinaryPiSessionOptions(cwd: string): CreateAgentSessionOptions {
  return {
    cwd,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      defaultTools: [...ORDINARY_TOOLS],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      packages: [],
    }),
    tools: [...ORDINARY_TOOLS],
  };
}

export function countProviderAcceptedTurns(
  session: BaselineSession,
  events: readonly { type: string }[],
): number {
  const stats = session.getSessionStats?.();
  if (stats !== undefined) {
    return stats.assistantMessages;
  }
  const fromTurns = events.filter((event) => event.type === "turn_end").length;
  if (fromTurns > 0) {
    return fromTurns;
  }
  return (session.messages ?? []).filter((message) => message.role === "assistant").length;
}

export async function runOrdinaryPiBaseline(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly createSession?: BaselineSessionFactory;
}): Promise<BaselineRunResult> {
  const factory = input.createSession ?? createAgentSession;
  const { session } = await factory(ordinaryPiSessionOptions(input.cwd));
  const accepted: { type: string }[] = [];
  const unsubscribe = session.subscribe?.((event) => {
    accepted.push(event);
  });
  await session.prompt(input.prompt);
  unsubscribe?.();
  return {
    promptTurns: countProviderAcceptedTurns(session, accepted),
    stoppedNaturally: true,
    tools: [...ORDINARY_TOOLS],
  };
}
