import { type HttpOperationSpec } from "./schemas/http.js";
import { HTTP_OPERATIONS } from "./schemas/http-operations.js";
import { jsonSchemaFromTypeBox, OPENAPI_COMPONENT_SCHEMAS } from "./openapi-schemas.js";

export type OpenApiParameter = {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: Record<string, unknown>;
};

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string };
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema";
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    headers: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

export type OpenApiOperation = {
  operationId: string;
  security: readonly Record<string, readonly string[]>[];
  parameters: readonly OpenApiParameter[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, Record<string, unknown>>;
};

function pathParameters(path: string): OpenApiParameter[] {
  const names = [...path.matchAll(/\{([A-Za-z]+)\}/g)]
    .map((match) => match[1])
    .filter((name) => name !== undefined);
  return names.map((name) => ({
    name,
    in: "path" as const,
    required: true,
    schema: { type: "string" },
  }));
}

function queryParameters(schemaName: string): OpenApiParameter[] {
  const schema = OPENAPI_COMPONENT_SCHEMAS[schemaName];
  if (schema === undefined) {
    throw new Error(`missing OpenAPI query schema ${schemaName}`);
  }
  const jsonSchema = jsonSchemaFromTypeBox(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
  };
  const required = new Set(jsonSchema.required ?? []);
  return Object.entries(jsonSchema.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query" as const,
    required: required.has(name),
    schema: unwrapNullUnion(property),
  }));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapNullUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const anyOf = schema.anyOf;
  if (!Array.isArray(anyOf)) {
    return schema;
  }
  const nonNull: Record<string, unknown>[] = [];
  for (const item of anyOf) {
    if (!isJsonRecord(item) || item.type === "null") {
      continue;
    }
    nonNull.push(item);
  }
  const only = nonNull[0];
  if (nonNull.length === 1 && only !== undefined) {
    return only;
  }
  return schema;
}

function errorStatuses(profile: string): number[] {
  const statuses = new Set<number>();
  if (profile.includes("R")) {
    for (const status of [401, 404, 500, 503]) {
      statuses.add(status);
    }
  }
  if (profile.includes("J")) {
    for (const status of [400, 413, 415, 422]) {
      statuses.add(status);
    }
  }
  if (profile.includes("I") || profile.includes("409")) {
    statuses.add(409);
  }
  if (profile.includes("P")) {
    statuses.add(412);
    statuses.add(428);
  }
  if (profile.includes("L") || profile.includes("423")) {
    statuses.add(409);
    statuses.add(423);
  }
  if (profile.includes("400")) {
    statuses.add(400);
  }
  if (profile.includes("410")) {
    statuses.add(410);
  }
  if (profile.includes("416")) {
    statuses.add(416);
  }
  const listed = profile.match(/\d{3}/g) ?? [];
  for (const code of listed) {
    statuses.add(Number.parseInt(code, 10));
  }
  return [...statuses].sort((left, right) => left - right);
}

function securityFor(operation: HttpOperationSpec): Record<string, readonly string[]>[] {
  if (operation.audiences.includes("bootstrap")) {
    return [{ bootstrapSecret: [] }];
  }
  return [{ mtls: [...operation.audiences] }];
}

function componentSchemas(): Record<string, Record<string, unknown>> {
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(OPENAPI_COMPONENT_SCHEMAS)) {
    schemas[name] = jsonSchemaFromTypeBox(schema) as Record<string, unknown>;
  }
  return schemas;
}

export function generateOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const operation of HTTP_OPERATIONS) {
    const item = paths[operation.path] ?? {};
    const responses: Record<string, Record<string, unknown>> = {};
    for (const success of operation.success) {
      responses[String(success.status)] = {
        description: success.schemaName ?? "empty",
        headers: Object.fromEntries(
          operation.responseHeaders.map((name) => [name, { schema: { type: "string" } }]),
        ),
        ...(success.schemaName === null
          ? {}
          : {
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${success.schemaName}` },
                },
              },
            }),
      };
    }
    for (const status of errorStatuses(operation.errorProfile)) {
      responses[String(status)] = {
        description: "ApiError",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
        },
      };
    }
    const parameters = [
      ...pathParameters(operation.path),
      ...(operation.method === "GET" && operation.requestSchemaName !== null
        ? queryParameters(operation.requestSchemaName)
        : []),
    ];
    item[operation.method.toLowerCase()] = {
      operationId: operation.operationId,
      security: securityFor(operation),
      parameters,
      ...(operation.requestSchemaName === null || operation.method === "GET"
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${operation.requestSchemaName}` },
                },
              },
            },
          }),
      responses,
    };
    paths[operation.path] = item;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Pi Hybrid Epistemic Compiler", version: "1" },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    paths,
    components: {
      securitySchemes: {
        mtls: { type: "mutualTLS" },
        bootstrapSecret: { type: "http", scheme: "bearer" },
      },
      headers: {
        "Operation-Id": { schema: { type: "string" } },
        ETag: { schema: { type: "string" } },
        "Content-Digest": { schema: { type: "string" } },
        "Repr-Digest": { schema: { type: "string" } },
        "Cache-Control": { schema: { type: "string", const: "no-store" } },
        Location: { schema: { type: "string" } },
      },
      schemas: componentSchemas(),
    },
  };
}
