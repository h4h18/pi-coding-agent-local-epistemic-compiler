import { createAbiProducer } from "./abi.js";
import { createAndroidProducer } from "./android.js";
import { createCompilerDiagnosticsProducer } from "./compiler-diagnostics.js";
import { createCoverageProducer } from "./coverage.js";
import { createFilesystemProducer } from "./filesystem.js";
import { createGenericProcessProducer } from "./generic-process.js";
import { createGraphqlProducer } from "./graphql.js";
import { createJunitProducer } from "./junit.js";
import { createLocalSemanticProducer } from "./local-semantic.js";
import { createOpenApiProducer } from "./openapi.js";
import { createPlaywrightProducer } from "./playwright.js";
import { createProtobufProducer } from "./protobuf.js";
import { createSarifProducer } from "./sarif.js";
import { createSqlMigrationProducer } from "./sql-migration.js";
import { createTapProducer } from "./tap.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { createXcTestProducer } from "./xctest.js";

export function productionProducers(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): readonly EvidenceProducer[] {
  return [
    createGenericProcessProducer(host, artifacts, bindings),
    createFilesystemProducer(host, artifacts, bindings),
    createJunitProducer(host, artifacts, bindings),
    createTapProducer(host, artifacts, bindings),
    createSarifProducer(host, artifacts, bindings),
    createCoverageProducer(host, artifacts, bindings),
    createCompilerDiagnosticsProducer(host, artifacts, bindings),
    createOpenApiProducer(host, artifacts, bindings),
    createGraphqlProducer(host, artifacts, bindings),
    createProtobufProducer(host, artifacts, bindings),
    createAbiProducer(host, artifacts, bindings),
    createSqlMigrationProducer(host, artifacts, bindings),
    createPlaywrightProducer(host, artifacts, bindings),
    createAndroidProducer(host, artifacts, bindings),
    createXcTestProducer(host, artifacts, bindings),
    createLocalSemanticProducer(host, artifacts, bindings),
  ];
}
