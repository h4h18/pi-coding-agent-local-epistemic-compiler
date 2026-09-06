function encodingsOf(secret: Uint8Array): Buffer[] {
  const utf8 = Buffer.from(secret);
  const text = utf8.toString("utf8");
  return [
    utf8,
    Buffer.from(utf8.toString("hex"), "utf8"),
    Buffer.from(utf8.toString("hex").toUpperCase(), "utf8"),
    Buffer.from(utf8.toString("base64"), "utf8"),
    Buffer.from(utf8.toString("base64url"), "utf8"),
    Buffer.from(encodeURIComponent(text), "utf8"),
  ];
}

export function redactSecretMaterial(
  input: Uint8Array,
  secrets: readonly Uint8Array[],
): Uint8Array {
  const replacement = Buffer.from("***REDACTED***", "utf8");
  let current = Buffer.from(input);
  for (const secret of secrets) {
    if (secret.byteLength === 0) {
      continue;
    }
    const needles = encodingsOf(secret).sort((left, right) => right.byteLength - left.byteLength);
    for (const needle of needles) {
      let next = Buffer.alloc(0);
      let offset = 0;
      while (offset < current.byteLength) {
        const found = current.subarray(offset).indexOf(needle);
        if (found < 0) {
          next = Buffer.concat([next, current.subarray(offset)]);
          break;
        }
        next = Buffer.concat([next, current.subarray(offset, offset + found), replacement]);
        offset = offset + found + needle.byteLength;
      }
      current = next;
    }
  }
  return current;
}
