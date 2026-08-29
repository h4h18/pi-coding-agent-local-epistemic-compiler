export const SNAPSHOT_ID = "snap_01234567-89ab-7cde-8f01-23456789abcd";

export function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

export function file(
  path: string,
  content: string,
): { path: string; kind: "file"; bytes: Uint8Array } {
  return { path, kind: "file", bytes: utf8(content) };
}

export function directory(path: string): { path: string; kind: "directory" } {
  return { path, kind: "directory" };
}

export function symlink(
  path: string,
  target: string,
): { path: string; kind: "symlink"; target: string } {
  return { path, kind: "symlink", target };
}

export function skillMarkdown(name: string, description: string, body = "Follow the steps."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
