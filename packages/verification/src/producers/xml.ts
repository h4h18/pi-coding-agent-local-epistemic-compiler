export type XmlElement = {
  name: string;
  attrs: Readonly<Record<string, string>>;
  body: string;
};

export function xmlElements(xml: string, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const pattern = new RegExp(
    `<${name}\\b([^>]*)/>|<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`,
    "gi",
  );
  let match = pattern.exec(xml);
  while (match !== null) {
    const selfAttrs = match[1];
    const openAttrs = match[2];
    const body = match[3];
    if (selfAttrs !== undefined) {
      out.push({ name, attrs: xmlAttrs(selfAttrs), body: "" });
    } else {
      out.push({ name, attrs: xmlAttrs(openAttrs ?? ""), body: body ?? "" });
    }
    match = pattern.exec(xml);
  }
  return out;
}

export function xmlAttrs(raw: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      attrs[key] = value;
    }
    match = pattern.exec(raw);
  }
  return attrs;
}

export function xmlAttr(element: XmlElement, name: string): string | undefined {
  return element.attrs[name];
}
