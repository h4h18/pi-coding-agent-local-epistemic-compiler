export type HeaderPair = {
  nameLowercase: string;
  value: string;
};

export function parseRawHeaders(raw: readonly string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name === undefined || value === undefined) {
      continue;
    }
    pairs.push({ nameLowercase: name.toLowerCase(), value });
  }
  return pairs;
}

export function headerValues(pairs: readonly HeaderPair[], nameLowercase: string): string[] {
  return pairs.filter((pair) => pair.nameLowercase === nameLowercase).map((pair) => pair.value);
}

export function firstHeader(pairs: readonly HeaderPair[], nameLowercase: string): string | undefined {
  return headerValues(pairs, nameLowercase)[0];
}

export function contentTypeMedia(pairs: readonly HeaderPair[]): string | undefined {
  const raw = firstHeader(pairs, "content-type");
  if (raw === undefined) {
    return undefined;
  }
  return raw.split(";")[0]?.trim().toLowerCase();
}
