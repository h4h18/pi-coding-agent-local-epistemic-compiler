import { type TSchema } from "typebox";
import { ArtifactEnvelopeSchema } from "./ids.js";
import {
  ApiErrorSchema,
  ApprovalChallengeRequestSchema,
  ApprovalChallengeSchema,
  CancelRunRequestSchema,
  CommitApprovalRequestSchema,
  CommitApprovalResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateRunRequestSchema,
  CreateRunnerEnrollmentChallengeRequestSchema,
  CreateWorkspaceRequestSchema,
  EnrollRunnerRequestSchema,
  HttpArtifactsQuerySchema,
  HttpEventsQuerySchema,
  MissingBlobsRequestSchema,
  MissingBlobsResponseSchema,
  OperationHeartbeatRequestSchema,
  OperationHeartbeatResponseSchema,
  OperationProjectionSchema,
  OperationResultRequestSchema,
  ProjectProjectionSchema,
  ProvideInputRequestSchema,
  RequestRepairRequestSchema,
  RevokeRunnerRequestSchema,
  RotateRunnerCertificateRequestSchema,
  RunArtifactPageSchema,
  RunEventPageSchema,
  RunProjectionSchema,
  RunnerEnrollmentChallengeSchema,
  RunnerIdentityResponseSchema,
  RunnerLeaseRequestSchema,
  RunnerLeaseResponseSchema,
  SetProjectTrustRequestSchema,
  SnapshotCommitRequestSchema,
  SnapshotProjectionSchema,
  UpdateProjectPolicyRequestSchema,
  WorkspaceProjectionSchema,
} from "./schemas/http.js";

export const OPENAPI_COMPONENT_SCHEMAS: Readonly<Record<string, TSchema>> = {
  ApiError: ApiErrorSchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  CreateProjectResponse: CreateProjectResponseSchema,
  ProjectProjection: ProjectProjectionSchema,
  UpdateProjectPolicyRequest: UpdateProjectPolicyRequestSchema,
  SetProjectTrustRequest: SetProjectTrustRequestSchema,
  ApprovalChallengeRequest: ApprovalChallengeRequestSchema,
  ArtifactEnvelopeApprovalChallenge: ArtifactEnvelopeSchema(ApprovalChallengeSchema),
  CommitApprovalRequest: CommitApprovalRequestSchema,
  CommitApprovalResponse: CommitApprovalResponseSchema,
  CreateWorkspaceRequest: CreateWorkspaceRequestSchema,
  WorkspaceProjection: WorkspaceProjectionSchema,
  CreateRunRequest: CreateRunRequestSchema,
  RunProjection: RunProjectionSchema,
  HttpEventsQuery: HttpEventsQuerySchema,
  HttpArtifactsQuery: HttpArtifactsQuerySchema,
  RunEventPage: RunEventPageSchema,
  RunArtifactPage: RunArtifactPageSchema,
  ProvideInputRequest: ProvideInputRequestSchema,
  RequestRepairRequest: RequestRepairRequestSchema,
  CancelRunRequest: CancelRunRequestSchema,
  OperationProjection: OperationProjectionSchema,
  MissingBlobsRequest: MissingBlobsRequestSchema,
  MissingBlobsResponse: MissingBlobsResponseSchema,
  SnapshotCommitRequest: SnapshotCommitRequestSchema,
  SnapshotProjection: SnapshotProjectionSchema,
  CreateRunnerEnrollmentChallengeRequest: CreateRunnerEnrollmentChallengeRequestSchema,
  RunnerEnrollmentChallenge: RunnerEnrollmentChallengeSchema,
  RevokeRunnerRequest: RevokeRunnerRequestSchema,
  EnrollRunnerRequest: EnrollRunnerRequestSchema,
  RunnerIdentityResponse: RunnerIdentityResponseSchema,
  RotateRunnerCertificateRequest: RotateRunnerCertificateRequestSchema,
  RunnerLeaseRequest: RunnerLeaseRequestSchema,
  RunnerLeaseResponse: RunnerLeaseResponseSchema,
  OperationHeartbeatRequest: OperationHeartbeatRequestSchema,
  OperationHeartbeatResponse: OperationHeartbeatResponseSchema,
  OperationResultRequest: OperationResultRequestSchema,
};

export function jsonSchemaFromTypeBox(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => jsonSchemaFromTypeBox(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      if (key.startsWith("~")) {
        continue;
      }
      result[key] = jsonSchemaFromTypeBox(nested);
    }
    return result;
  }
  return value;
}
