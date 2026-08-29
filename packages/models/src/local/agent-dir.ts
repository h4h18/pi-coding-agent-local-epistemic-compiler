import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createEmptyAclRestrictedAgentDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hec-agent-"));
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Windows chmod is best-effort; callers assert emptiness and that this is not ~/.pi/agent.
  }
  return dir;
}
