import {
  PATH_MAX_UTF8_BYTES,
  PATH_SEGMENT_MAX_UTF8_BYTES,
  utf8ByteLength,
} from "@pi-hec/contracts";

const RESERVED_BASE = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM0",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT0",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "CONIN$",
  "CONOUT$",
]);

export type RelativePathRejectCode =
  | "PATH_TRAVERSAL"
  | "PATH_ABSOLUTE"
  | "PATH_DEVICE"
  | "PATH_ADS"
  | "PATH_RESERVED"
  | "PATH_PROTECTED"
  | "PATH_LENGTH"
  | "UNICODE_COLLISION";

export type ClassifyRelativePathOptions = {
  allowProtectedGit?: boolean;
};

export function caseFoldKey(text: string, caseSensitive: boolean): string {
  const nfc = text.normalize("NFC");
  return caseSensitive ? nfc : nfc.toUpperCase();
}

function isReservedComponent(name: string): boolean {
  const stem = name.split(".")[0] ?? name;
  return RESERVED_BASE.has(stem.toUpperCase());
}

function isEightDotThree(name: string): boolean {
  const upper = name.toUpperCase();
  const split = upper.split(".");
  const stem = split[0] ?? upper;
  const ext = split.length > 1 ? split.slice(1).join(".") : undefined;
  if (!stem.includes("~")) {
    return false;
  }
  const tilde = stem.indexOf("~");
  const left = stem.slice(0, tilde);
  const right = stem.slice(tilde + 1);
  if (left.length === 0 || left.length > 6) {
    return false;
  }
  if (right.length === 0 || !/^[0-9]+$/.test(right)) {
    return false;
  }
  if (ext !== undefined && ext.length > 3) {
    return false;
  }
  return true;
}

function isDriveRelative(path: string): boolean {
  if (path.length < 2) {
    return false;
  }
  const first = path.charCodeAt(0);
  const letter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!letter || path.charAt(1) !== ":") {
    return false;
  }
  if (path.length === 2) {
    return true;
  }
  const third = path.charAt(2);
  return third !== "/" && third !== "\\";
}

function isDeviceNamespace(path: string): boolean {
  const upper = path.replaceAll("/", "\\").toUpperCase();
  return (
    upper.startsWith("\\\\.\\") ||
    upper.startsWith("\\\\?\\") ||
    upper.startsWith("\\??\\") ||
    upper.startsWith("//./") ||
    upper.startsWith("//?/")
  );
}

function isProtectedGitSegment(segment: string): boolean {
  return caseFoldKey(segment, false) === ".GIT";
}

export function classifyRelativePath(
  path: string,
  options: ClassifyRelativePathOptions = {},
): RelativePathRejectCode | undefined {
  if (path.includes("\0")) {
    return "PATH_TRAVERSAL";
  }
  if (path.includes("\\") || path.startsWith("/") || path.startsWith("//")) {
    return "PATH_ABSOLUTE";
  }
  if (isDeviceNamespace(path) || isDriveRelative(path)) {
    return "PATH_DEVICE";
  }
  if (path.includes(":")) {
    return "PATH_ADS";
  }
  if (path.normalize("NFC") !== path) {
    return "UNICODE_COLLISION";
  }
  if (utf8ByteLength(path) > PATH_MAX_UTF8_BYTES) {
    return "PATH_LENGTH";
  }
  const segments = path.split("/");
  if (segments.length === 0) {
    return "PATH_TRAVERSAL";
  }
  const allowGit = options.allowProtectedGit === true;
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      utf8ByteLength(segment) > PATH_SEGMENT_MAX_UTF8_BYTES
    ) {
      return "PATH_TRAVERSAL";
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      return "PATH_RESERVED";
    }
    if (isReservedComponent(segment)) {
      return "PATH_RESERVED";
    }
    if (isEightDotThree(segment)) {
      return "PATH_RESERVED";
    }
    if (!allowGit && isProtectedGitSegment(segment)) {
      return "PATH_PROTECTED";
    }
  }
  return undefined;
}
