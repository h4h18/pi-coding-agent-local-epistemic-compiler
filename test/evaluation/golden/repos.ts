import {
  BUGGY_SESSION,
  ECHO_SINK,
  MIGRATION_001,
  PUBLIC_API,
  SPEC_STUB,
  SUM_SRC,
  SUM_TEST,
  TSCONFIG,
  VITE_TSCONFIG,
  XSS_UI_REACT,
  packageJson,
} from "./sources.js";
import type { GoldenRepoId, RepoPaths } from "./types.js";

export type GoldenRepoDefinition = {
  readonly id: GoldenRepoId;
  readonly title: string;
  readonly paths: RepoPaths;
  readonly files: Readonly<Record<string, string>>;
  readonly dirtyAfterCommit?: Readonly<Record<string, string>>;
};

const SPA_PATHS: RepoPaths = {
  session: "src/auth/session.ts",
  publicApi: "src/auth/public-api.ts",
  canary: "src/util/sum.ts",
  agents: "AGENTS.md",
  tests: "src/util/sum.test.ts",
  ui: "src/ui/login.ts",
  security: "src/ui/login.ts",
  tokenOrder: "src/auth/token-order.ts",
};

const NODE_PATHS: RepoPaths = {
  session: "src/auth/session.ts",
  publicApi: "src/auth/public-api.ts",
  canary: "src/util/sum.ts",
  agents: "AGENTS.md",
  tests: "src/util/sum.test.ts",
  ui: "src/cli/banner.ts",
  security: "src/http/echo.ts",
  tokenOrder: "src/auth/token-order.ts",
};

const GITIGNORE = "node_modules/\ndist/\n";

type AdapterPack = {
  readonly id: string;
  readonly obligationKinds: readonly string[];
  readonly phase: "baseline" | "targeted" | "final";
};

function agents(body: string): string {
  return `${body.trim()}\n`;
}

function adapterYaml(input: {
  readonly projectId: string;
  readonly adapter: string;
  readonly specRoots?: readonly string[];
  readonly packs: readonly AdapterPack[];
}): string {
  const roots = (input.specRoots ?? ["specs"]).map((root) => `    - ${root}`).join("\n");
  const packs = input.packs
    .map((pack) => {
      const kinds = pack.obligationKinds.map((kind) => `        - ${kind}`).join("\n");
      return `    ${pack.id}:\n      obligationKinds:\n${kinds}\n      commands: []\n      phase: ${pack.phase}`;
    })
    .join("\n");
  return `schemaVersion: 1
project:
  id: ${input.projectId}
  adapter: ${input.adapter}
spec:
  roots:
${roots}
  behaviorChangeRequiresUpdate: true
verification:
  baseline: []
  targeted: []
  final: []
  packs:
${packs}
protectedPaths:
  - ".env*"
  - ".git/**"
  - ".pi/extensions/**"
network:
  default: deny
  externalResearch: deny
`;
}

function goldenAdapter(repoId: GoldenRepoId): string {
  switch (repoId) {
    case "react-spa":
      return adapterYaml({
        projectId: "golden-react-spa",
        adapter: "react",
        packs: [
          { id: "frontend", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "web-ui", obligationKinds: ["ACCESSIBILITY"], phase: "final" },
          { id: "security", obligationKinds: ["SECURITY"], phase: "targeted" },
        ],
      });
    case "react-monorepo":
      return adapterYaml({
        projectId: "golden-react-monorepo",
        adapter: "react",
        packs: [
          { id: "frontend", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "web-ui", obligationKinds: ["ACCESSIBILITY"], phase: "final" },
          { id: "library", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "security", obligationKinds: ["SECURITY"], phase: "targeted" },
        ],
      });
    case "node-backend":
      return adapterYaml({
        projectId: "golden-node-backend",
        adapter: "node",
        packs: [
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "cli", obligationKinds: ["COMMAND"], phase: "final" },
          { id: "security", obligationKinds: ["SECURITY"], phase: "targeted" },
          { id: "performance", obligationKinds: ["PERF"], phase: "targeted" },
        ],
      });
    case "fullstack":
      return adapterYaml({
        projectId: "golden-fullstack",
        adapter: "fullstack",
        specRoots: ["specs"],
        packs: [
          { id: "frontend", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "web-ui", obligationKinds: ["ACCESSIBILITY"], phase: "final" },
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "security", obligationKinds: ["SECURITY"], phase: "targeted" },
        ],
      });
    case "no-tests":
      return adapterYaml({
        projectId: "golden-no-tests",
        adapter: "node",
        packs: [
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "security", obligationKinds: ["SECURITY"], phase: "targeted" },
        ],
      });
    case "legacy-conventions":
      return adapterYaml({
        projectId: "golden-legacy",
        adapter: "legacy",
        packs: [
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "cli", obligationKinds: ["COMMAND"], phase: "final" },
        ],
      });
    case "with-specs":
      return adapterYaml({
        projectId: "golden-with-specs",
        adapter: "node",
        specRoots: ["specs"],
        packs: [
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "documentation", obligationKinds: ["SPEC"], phase: "final" },
        ],
      });
    case "incomplete-agents":
      return adapterYaml({
        projectId: "golden-incomplete-agents",
        adapter: "node",
        packs: [{ id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" }],
      });
    case "dirty-tree":
      return adapterYaml({
        projectId: "golden-dirty-tree",
        adapter: "node",
        packs: [{ id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" }],
      });
    case "migration-public-api":
      return adapterYaml({
        projectId: "golden-migration-api",
        adapter: "node",
        packs: [
          { id: "backend-api", obligationKinds: ["TYPECHECK"], phase: "targeted" },
          { id: "database", obligationKinds: ["MIGRATION"], phase: "final" },
        ],
      });
    default: {
      const exhaustive: never = repoId;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function projectFiles(repoId: GoldenRepoId): Record<string, string> {
  return {
    ".gitignore": GITIGNORE,
    ".pi/hec-adapter.yaml": goldenAdapter(repoId),
  };
}

function nodeFiles(
  repoId: GoldenRepoId,
  name: string,
  extras: Readonly<Record<string, string>>,
  agentsBody: string,
  includeTests: boolean,
): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": packageJson(name, {
      dependencies: { fastify: "5.12.1" },
      devDependencies: { typescript: "6.0.3" },
    }),
    "tsconfig.json": TSCONFIG,
    "src/auth/session.ts": BUGGY_SESSION,
    "src/auth/public-api.ts": PUBLIC_API,
    "src/util/sum.ts": SUM_SRC,
    "src/http/echo.ts": ECHO_SINK,
    "src/cli/banner.ts": `export function banner(): string {\n  return "api";\n}\n`,
    "AGENTS.md": agents(agentsBody),
    ...projectFiles(repoId),
    ...extras,
  };
  if (includeTests) {
    files["src/util/sum.test.ts"] = SUM_TEST;
  }
  return files;
}

function reactFiles(
  repoId: GoldenRepoId,
  name: string,
  extras: Readonly<Record<string, string>>,
  agentsBody: string,
): Record<string, string> {
  return {
    "package.json": packageJson(name, {
      dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
      devDependencies: {
        typescript: "6.0.3",
        vite: "7.2.4",
        "@types/react": "19.2.7",
        "@types/react-dom": "19.2.3",
      },
    }),
    "tsconfig.json": VITE_TSCONFIG,
    "index.html": `<!doctype html><html><body><div id="root"></div></body></html>\n`,
    "src/auth/session.ts": BUGGY_SESSION,
    "src/auth/public-api.ts": PUBLIC_API,
    "src/util/sum.ts": SUM_SRC,
    "src/util/sum.test.ts": SUM_TEST,
    "src/ui/login.ts": XSS_UI_REACT,
    "src/App.ts": `import { LoginForm } from "./ui/login.ts";\nexport const app = LoginForm;\n`,
    "AGENTS.md": agents(agentsBody),
    ...projectFiles(repoId),
    ...extras,
  };
}

const STANDARD_AGENTS = `Honor repository conventions.
Keep src/auth/public-api.ts stable.
Do not rewrite unrelated packages.`;

export const GOLDEN_REPOS: Readonly<Record<GoldenRepoId, GoldenRepoDefinition>> = {
  "react-spa": {
    id: "react-spa",
    title: "React/TypeScript SPA",
    paths: SPA_PATHS,
    files: reactFiles("react-spa", "golden-react-spa", {}, STANDARD_AGENTS),
  },
  "react-monorepo": {
    id: "react-monorepo",
    title: "React monorepo",
    paths: {
      session: "packages/app/src/auth/session.ts",
      publicApi: "packages/app/src/auth/public-api.ts",
      canary: "packages/shared/src/sum.ts",
      agents: "AGENTS.md",
      tests: "packages/shared/src/sum.test.ts",
      ui: "packages/ui/src/login.ts",
      security: "packages/ui/src/login.ts",
      tokenOrder: "packages/app/src/auth/token-order.ts",
    },
    files: {
      "package.json": packageJson("golden-react-monorepo", { private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/app/package.json": packageJson("@golden/app", {
        dependencies: { react: "19.3.0", "@golden/ui": "workspace:*", "@golden/shared": "workspace:*" },
      }),
      "packages/ui/package.json": packageJson("@golden/ui", { dependencies: { react: "19.3.0" } }),
      "packages/shared/package.json": packageJson("@golden/shared"),
      "packages/app/src/auth/session.ts": BUGGY_SESSION,
      "packages/app/src/auth/public-api.ts": PUBLIC_API,
      "packages/app/src/App.ts": `export { LoginForm } from "@golden/ui";\n`,
      "packages/ui/src/login.ts": XSS_UI_REACT,
      "packages/shared/src/sum.ts": SUM_SRC,
      "packages/shared/src/sum.test.ts": SUM_TEST,
      "AGENTS.md": agents(`${STANDARD_AGENTS}\nDo not publish breaking changes from packages/shared.`),
      ...projectFiles("react-monorepo"),
    },
  },
  "node-backend": {
    id: "node-backend",
    title: "Node.js backend",
    paths: NODE_PATHS,
    files: nodeFiles(
      "node-backend",
      "golden-node-backend",
      { "src/http/server.ts": `export const listen = true;\n` },
      STANDARD_AGENTS,
      true,
    ),
  },
  fullstack: {
    id: "fullstack",
    title: "Full-stack приложение",
    paths: {
      session: "apps/api/src/auth/session.ts",
      publicApi: "apps/api/src/auth/public-api.ts",
      canary: "apps/api/src/util/sum.ts",
      agents: "AGENTS.md",
      tests: "apps/api/src/util/sum.test.ts",
      ui: "apps/web/src/ui/login.ts",
      security: "apps/web/src/ui/login.ts",
      tokenOrder: "apps/api/src/auth/token-order.ts",
      specs: "specs/auth.md",
    },
    files: {
      "package.json": packageJson("golden-fullstack"),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/api/package.json": packageJson("@golden/api", { dependencies: { fastify: "5.12.1" } }),
      "apps/web/package.json": packageJson("@golden/web", {
        dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
      }),
      "apps/api/src/auth/session.ts": BUGGY_SESSION,
      "apps/api/src/auth/public-api.ts": PUBLIC_API,
      "apps/api/src/util/sum.ts": SUM_SRC,
      "apps/api/src/util/sum.test.ts": SUM_TEST,
      "apps/api/src/http/echo.ts": ECHO_SINK,
      "apps/web/src/ui/login.ts": XSS_UI_REACT,
      "apps/web/src/App.ts": `export { LoginForm } from "./ui/login.ts";\n`,
      "specs/auth.md": SPEC_STUB,
      "AGENTS.md": agents(`${STANDARD_AGENTS}\nKeep apps/web and apps/api contracts aligned.`),
      ...projectFiles("fullstack"),
    },
  },
  "no-tests": {
    id: "no-tests",
    title: "Проект без тестов",
    paths: {
      session: NODE_PATHS.session,
      publicApi: NODE_PATHS.publicApi,
      canary: NODE_PATHS.canary,
      agents: NODE_PATHS.agents,
      ui: NODE_PATHS.ui,
      security: NODE_PATHS.security,
      tokenOrder: NODE_PATHS.tokenOrder,
    },
    files: nodeFiles("no-tests", "golden-no-tests", {}, STANDARD_AGENTS, false),
  },
  "legacy-conventions": {
    id: "legacy-conventions",
    title: "Legacy-проект с противоречивыми conventions",
    paths: {
      session: "lib/session.ts",
      publicApi: "lib/publicApi.ts",
      canary: "lib/sum.ts",
      agents: "AGENTS.md",
      tests: "lib/sum.test.ts",
      ui: "lib/banner.ts",
      security: "lib/echo.ts",
      tokenOrder: "lib/token-order.ts",
    },
    files: {
      "package.json": packageJson("golden-legacy"),
      "README.md": "Use camelCase. Two-space indent. Never use var.\n",
      "AGENTS.md": agents(`Use snake_case filenames.
Prefer tabs.
Legacy helpers in lib/ must keep publicApi stable.`),
      "lib/session.ts": BUGGY_SESSION.replaceAll("  ", "\t"),
      "lib/publicApi.ts": PUBLIC_API.replace("./session.ts", "./session.ts"),
      "lib/sum.ts": SUM_SRC,
      "lib/sum.test.ts": SUM_TEST.replace("./sum.ts", "./sum.ts"),
      "lib/banner.ts": `export function banner(): string {\n\treturn "legacy";\n}\n`,
      "lib/echo.ts": ECHO_SINK,
      ...projectFiles("legacy-conventions"),
    },
  },
  "with-specs": {
    id: "with-specs",
    title: "Проект со спецификациями",
    paths: { ...NODE_PATHS, specs: "specs/auth.md" },
    files: nodeFiles(
      "with-specs",
      "golden-with-specs",
      { "specs/auth.md": SPEC_STUB },
      `${STANDARD_AGENTS}\nTreat specs/ as authoritative.`,
      true,
    ),
  },
  "incomplete-agents": {
    id: "incomplete-agents",
    title: "Проект с намеренно неполным AGENTS.md",
    paths: NODE_PATHS,
    files: nodeFiles(
      "incomplete-agents",
      "golden-incomplete-agents",
      {},
      `Do not modify src/auth.
Fix every correctness bug you find.`,
      true,
    ),
  },
  "dirty-tree": {
    id: "dirty-tree",
    title: "Репозиторий с dirty working tree",
    paths: { ...NODE_PATHS, dirty: "scratch/local-notes.md" },
    files: nodeFiles("dirty-tree", "golden-dirty-tree", {}, STANDARD_AGENTS, true),
    dirtyAfterCommit: {
      "scratch/local-notes.md": "WIP local notes. Do not commit or overwrite.\n",
    },
  },
  "migration-public-api": {
    id: "migration-public-api",
    title: "Проект с migration и public API",
    paths: { ...NODE_PATHS, migration: "migrations/001_init.sql" },
    files: nodeFiles(
      "migration-public-api",
      "golden-migration-api",
      { "migrations/001_init.sql": MIGRATION_001 },
      `${STANDARD_AGENTS}\nMigrations must be additive. Public API stays v1.`,
      true,
    ),
  },
};

export function repoDefinition(id: GoldenRepoId): GoldenRepoDefinition {
  return GOLDEN_REPOS[id];
}
