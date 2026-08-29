import { ARTIFACT_ROLE_REGISTRY } from "./artifact-roles.js";
import { OPERATION_KINDS, RECLAIMABLE_OPERATION_KINDS, RUN_STATES } from "./run-states.js";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function runStateRegistrySql(): string {
  const values = RUN_STATES.map((state) => `  (${sqlString(state)})`).join(",\n");
  return `INSERT INTO run_state_registry(state) VALUES\n${values};\n`;
}

export function operationKindRegistrySql(): string {
  const values = OPERATION_KINDS.map(
    (kind) => `  (${sqlString(kind)}, ${RECLAIMABLE_OPERATION_KINDS.has(kind) ? "1" : "0"})`,
  ).join(",\n");
  return `INSERT INTO operation_kind_registry(operation_kind, reclaimable) VALUES\n${values};\n`;
}

export function artifactRoleRegistrySql(): string {
  const values = ARTIFACT_ROLE_REGISTRY.map((entry) => {
    const schema = entry.artifactSchemaName === null ? "NULL" : sqlString(entry.artifactSchemaName);
    return `  (${sqlString(entry.ownerKind)}, ${sqlString(entry.role)}, ${sqlString(entry.cardinality)}, ${schema})`;
  }).join(",\n");
  return `INSERT INTO artifact_role_registry(owner_kind, role, cardinality, artifact_schema_name) VALUES\n${values};\n`;
}
