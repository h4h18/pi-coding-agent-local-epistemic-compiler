import type { FastifyReply, FastifyRequest } from "fastify";
import { buildRunAgentsPage } from "../services/profile-runner.js";
import {
  mapStoreError,
  quotedEtag,
  requireScope,
  type AppContext,
} from "../orchestration/handlers.js";

export async function listRunAgents(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const run = ctx.store.getRun(projectScope, runId);
    const page = buildRunAgentsPage(ctx.store, projectScope, runId);
    const etag = quotedEtag(run.stateVersion);
    void reply.header("etag", etag).header("cache-control", "no-store");
    if (request.headers["if-none-match"] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply.code(200).send(page);
  } catch (error) {
    await mapStoreError(reply, error);
  }
}
