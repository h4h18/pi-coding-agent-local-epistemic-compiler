const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

export function lexicalTokens(text: string): string[] {
  const folded = text.normalize("NFC");
  const tokens: string[] = [];
  const seen = new Set<string>();
  let match = TOKEN_RE.exec(folded);
  while (match !== null) {
    const token = match[0].toLocaleLowerCase("en-US");
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
    match = TOKEN_RE.exec(folded);
  }
  TOKEN_RE.lastIndex = 0;
  return tokens;
}

export function ftsQueryFromText(query: string): string {
  const tokens = lexicalTokens(query);
  if (tokens.length === 0) {
    return '""';
  }
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" AND ");
}
