import { listenControlPlane, type ListeningControlPlane } from "./app.js";
import type { ControlPlaneConfig } from "./config.js";
import type { AppContext } from "./orchestration/handlers.js";

export async function main(ctx: AppContext, config: ControlPlaneConfig): Promise<ListeningControlPlane> {
  const listening = await listenControlPlane(ctx, config);
  const shutdown = (): void => {
    void listening.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return listening;
}
