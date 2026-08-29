import { createHash } from "node:crypto";
import { canonicalizeRfc8785, objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";
import { FetchError } from "./errors.js";

export const SANITIZER_ID = "pi-hec-external-sanitizer/v1";

const ALLOWED_MEDIA = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "text/xml",
  "text/csv",
  "text/css",
  "text/javascript",
  "text/yaml",
  "text/x-yaml",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/yaml",
  "application/toml",
]);

const REJECTED_MEDIA_PREFIX = ["image/", "audio/", "video/", "font/", "multipart/"];
const REJECTED_MEDIA = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/octet-stream",
  "application/pdf",
  "application/wasm",
]);

export function sanitizerVersionDigest(): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(canonicalizeRfc8785({ id: SANITIZER_ID }), "utf8"));
}

export function assertAllowedMedia(mediaType: string): void {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_MEDIA.has(base) || base.startsWith("text/")) {
    return;
  }
  if (REJECTED_MEDIA.has(base) || REJECTED_MEDIA_PREFIX.some((prefix) => base.startsWith(prefix))) {
    throw new FetchError("MEDIA", `unsupported media type ${base}`);
  }
  throw new FetchError("MEDIA", `unsupported media type ${base}`);
}

export function sanitizeFetchedText(mediaType: string, bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
  if (base.includes("xml")) {
    if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
      throw new FetchError("XXE", "XML external entities and DTDs are forbidden");
    }
    return text.replace(/<script[\s\S]*?<\/script>/gi, "");
  }
  if (base === "text/html" || base === "application/xhtml+xml") {
    return sanitizeHtml(text);
  }
  if (base === "application/json" || base === "application/ld+json") {
    const parsed: unknown = JSON.parse(text);
    return canonicalizeRfc8785(parsed);
  }
  return text;
}

function sanitizeHtml(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<(script|style|iframe|object|embed|link|meta)[^>]*>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "");
  out = out.replace(/javascript:/gi, "");
  out = out.replace(/<[^>]+>/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

export function observedVersionFrom(text: string, headers: readonly { nameLowercase: string; value: string }[]): string | undefined {
  const header = headers.find((item) => item.nameLowercase === "x-documentation-version")?.value;
  if (header !== undefined && header.length > 0) {
    return header;
  }
  const meta = /<meta[^>]+name=["']doc-version["'][^>]+content=["']([^"']+)["']/i.exec(text);
  return meta?.[1];
}

export function quoteDigestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
