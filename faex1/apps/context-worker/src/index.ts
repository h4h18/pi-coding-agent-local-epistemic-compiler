export const packageName = "@pi-hec/context-worker";

export {
  handleIncrementalIndex,
  handleRebuildIndex,
  handleSearchBm25,
  handleSearchVector,
} from "./index-handler.js";
export { handleExternalFetch } from "./fetch-handler.js";
export { handlePreflight } from "./preflight-handler.js";
export type { HandlePreflightInput, HandlePreflightResult } from "./preflight-handler.js";
export { handleCompileContext, handleContextFallback } from "./context-handler.js";
export { main, startContextWorker } from "./main.js";
export type { WorkerPoll } from "./main.js";
