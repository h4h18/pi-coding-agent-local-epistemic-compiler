const PRETINY =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export const PI_HEC_CLOUD_TOKENIZER_REVISION = "pi-hec-conservative-v1";

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff)
  );
}

export function countCloudTokens(text: string, tokenizerRevision: string): number | undefined {
  if (tokenizerRevision !== PI_HEC_CLOUD_TOKENIZER_REVISION) {
    return undefined;
  }
  const normalized = text.normalize("NFC");
  if (normalized.length === 0) {
    return 0;
  }
  PRETINY.lastIndex = 0;
  let tokens = 0;
  let match = PRETINY.exec(normalized);
  while (match !== null) {
    const piece = match[0];
    const bytes = Buffer.byteLength(piece, "utf8");
    let cjk = 0;
    for (const char of piece) {
      const code = char.codePointAt(0);
      if (code !== undefined && isCjk(code)) {
        cjk += 1;
      }
    }
    const latinBytes = Math.max(0, bytes - cjk * 3);
    tokens += cjk + Math.max(1, Math.ceil(latinBytes / 3));
    if (PRETINY.lastIndex === match.index) {
      PRETINY.lastIndex += 1;
    }
    match = PRETINY.exec(normalized);
  }
  return tokens;
}
