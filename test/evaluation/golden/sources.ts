export const BUGGY_SESSION = `export type Token = {
  value: string;
  issuedAt: number;
};

export type TokenFetcher = () => Promise<Token>;

let current: Token | null = null;
let inFlight: Promise<Token> | null = null;

export function publicApiVersion(): "1" {
  return "1";
}

export async function refreshSession(fetchToken: TokenFetcher): Promise<Token> {
  if (inFlight !== null) {
    return inFlight;
  }
  inFlight = fetchToken()
    .then((token) => {
      current = token;
      return token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function currentToken(): Token | null {
  return current;
}

export function findExpired(sessions: readonly Token[], now: number): Token[] {
  const expired: Token[] = [];
  for (const left of sessions) {
    for (const right of sessions) {
      if (left.value === right.value && left.issuedAt < now) {
        expired.push(left);
        break;
      }
    }
  }
  return expired;
}
`;

export const GOLD_SESSION = `export type Token = {
  value: string;
  issuedAt: number;
};

export type TokenFetcher = () => Promise<Token>;

let current: Token | null = null;

export function publicApiVersion(): "1" {
  return "1";
}

export async function refreshSession(fetchToken: TokenFetcher): Promise<Token> {
  const token = await fetchToken();
  if (current === null || token.issuedAt >= current.issuedAt) {
    current = token;
  }
  return current;
}

export function currentToken(): Token | null {
  return current;
}

export function findExpired(sessions: readonly Token[], now: number): Token[] {
  return sessions.filter((session) => session.issuedAt < now);
}
`;

export const FEATURE_SESSION = `export type Token = {
  value: string;
  issuedAt: number;
};

export type TokenFetcher = () => Promise<Token>;

let current: Token | null = null;
let inFlight: Promise<Token> | null = null;
let remembered: Token | null = null;

export function publicApiVersion(): "1" {
  return "1";
}

export async function refreshSession(fetchToken: TokenFetcher): Promise<Token> {
  if (inFlight !== null) {
    return inFlight;
  }
  inFlight = fetchToken()
    .then((token) => {
      current = token;
      return token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function currentToken(): Token | null {
  return current;
}

export function rememberMe(token: Token): void {
  remembered = token;
}

export function restoreRemembered(): Token | null {
  if (remembered !== null) {
    current = remembered;
  }
  return remembered;
}

export function findExpired(sessions: readonly Token[], now: number): Token[] {
  const expired: Token[] = [];
  for (const left of sessions) {
    for (const right of sessions) {
      if (left.value === right.value && left.issuedAt < now) {
        expired.push(left);
        break;
      }
    }
  }
  return expired;
}
`;

export const SERIALIZED_SESSION = `export type Token = {
  value: string;
  issuedAt: number;
};

export type TokenFetcher = () => Promise<Token>;

let current: Token | null = null;
const globalQueue: Promise<unknown>[] = [];
let requestMutex = Promise.resolve();

export function publicApiVersion(): "1" {
  return "1";
}

export async function refreshSession(fetchToken: TokenFetcher): Promise<Token> {
  const run = requestMutex.then(async () => {
    const token = await fetchToken();
    current = token;
    return token;
  });
  requestMutex = run.then(
    () => undefined,
    () => undefined,
  );
  globalQueue.push(run);
  return run;
}

export function serializeAllRequests<T>(work: () => Promise<T>): Promise<T> {
  const run = requestMutex.then(work);
  requestMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function currentToken(): Token | null {
  return current;
}

export function findExpired(sessions: readonly Token[], now: number): Token[] {
  return sessions.filter((session) => session.issuedAt < now);
}
`;

export const REFACTOR_TOKEN_ORDER = `export function compareIssuedAt(
  left: { issuedAt: number },
  right: { issuedAt: number },
): number {
  return left.issuedAt - right.issuedAt;
}
`;

export const REFACTOR_SESSION = `import { compareIssuedAt } from "./token-order.ts";

export type Token = {
  value: string;
  issuedAt: number;
};

export type TokenFetcher = () => Promise<Token>;

let current: Token | null = null;
let inFlight: Promise<Token> | null = null;

export function publicApiVersion(): "1" {
  return "1";
}

export async function refreshSession(fetchToken: TokenFetcher): Promise<Token> {
  if (inFlight !== null) {
    return inFlight;
  }
  inFlight = fetchToken()
    .then((token) => {
      if (current === null || compareIssuedAt(token, current) >= 0) {
        current = token;
      }
      return token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function currentToken(): Token | null {
  return current;
}

export function findExpired(sessions: readonly Token[], now: number): Token[] {
  const expired: Token[] = [];
  for (const left of sessions) {
    for (const right of sessions) {
      if (left.value === right.value && left.issuedAt < now) {
        expired.push(left);
        break;
      }
    }
  }
  return expired;
}
`;

export const PUBLIC_API = `export { currentToken, publicApiVersion, refreshSession } from "./session.ts";

export const SESSION_PUBLIC_CONTRACT = {
  version: 1,
  methods: ["refreshSession", "currentToken", "publicApiVersion"],
} as const;
`;

export const SUM_SRC = `export function sum(left: number, right: number): number {
  return left + right;
}
`;

export const SUM_TEST = `import { sum } from "./sum.ts";

export function testSum(): void {
  if (sum(1, 2) !== 3) {
    throw new Error("sum regression");
  }
}
`;

export const PERFORMANCE_SESSION = GOLD_SESSION;

export const SAFE_UI = `export function LoginForm(html: string): string {
  const escaped = html
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return '<button type="button" aria-label="Sign in">' + escaped + "</button>";
}
`;

export const XSS_UI_REACT = `export function LoginForm({ html }: { html: string }): string {
  return html;
}
`;

export const SAFE_UI_REACT = `export function LoginForm({ name }: { name: string }): string {
  return '<button type="button" aria-label="Sign in">' + name + "</button>";
}
`;

export const ECHO_SINK = `export function echo(input: string): string {
  return "<script>" + input + "</script>";
}
`;

export const SAFE_ECHO = `export function echo(input: string): string {
  return JSON.stringify(input);
}
`;

export const MIGRATION_001 = `CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL
);
`;

export const MIGRATION_002 = `ALTER TABLE sessions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
`;

export const SPEC_STUB = `# Auth

Tokens exist.
`;

export const SPEC_AUTH = `# Auth

Session refresh must keep the newest token when two refreshes overlap.
Do not serialize unrelated requests globally.
`;

export const REGRESSION_TEST = `import { currentToken, refreshSession } from "./session.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function testNewestTokenWins(): Promise<void> {
  await Promise.all([
    refreshSession(async () => {
      await delay(40);
      return { value: "old", issuedAt: 1 };
    }),
    refreshSession(async () => {
      await delay(5);
      return { value: "new", issuedAt: 2 };
    }),
  ]);
  if (currentToken()?.value !== "new") {
    throw new Error("newest token was dropped");
  }
}
`;

export function packageJson(name: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      ...extra,
    },
    null,
    2,
  )}\n`;
}

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
`;

export const VITE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
`;
