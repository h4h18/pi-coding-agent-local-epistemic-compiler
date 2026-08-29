const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyw: "python",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  prisma: "prisma",
};

export function guessLanguage(path: string, text: string | undefined): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    const mapped = EXTENSION_LANGUAGE[ext];
    if (mapped !== undefined) {
      return mapped;
    }
    return ext;
  }
  if (text !== undefined && text.startsWith("#!")) {
    const line = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    if (line.includes("python")) {
      return "python";
    }
    if (line.includes("node") || line.includes("javascript")) {
      return "javascript";
    }
  }
  return "unknown";
}

export function isKnownLanguage(language: string): boolean {
  return language !== "unknown";
}
