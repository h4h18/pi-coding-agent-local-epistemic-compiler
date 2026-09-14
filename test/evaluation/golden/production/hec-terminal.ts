import type { BrokerPort } from "../../../../client/apps/pi-extension/src/broker-client.js";
import type { FakePi } from "../../../../client/apps/pi-extension/test/harness.js";
import { pointerRunId } from "./control-broker.js";

export function installHumanHec(input: {
  readonly pi: FakePi;
  readonly broker: BrokerPort;
  readonly cwd: string;
}): void {
  input.pi.cwd = input.cwd;
  input.pi.install(input.broker, { securityMode: "compatibility" });
}

export async function humanHec(pi: FakePi, command: string): Promise<void> {
  await pi.runCommand(command);
}

export async function startTaskAsHuman(pi: FakePi, prompt: string): Promise<void> {
  await humanHec(pi, "mode on");
  await humanHec(pi, `task ${prompt}`);
}

export function requireActiveRunId(pi: FakePi) {
  return pointerRunId(pi.entries);
}
