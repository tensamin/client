import { parse, stringify } from "lossless-json";

export function parseExactJson(text: string): unknown {
  const value: unknown = parse(text, undefined, { parseNumber: BigInt });
  // lossless-json permits duplicate keys with equal values. Scan complete string tokens after parsing so escaped quotes and braces inside values stay strings.
  const objects: Set<string>[] = [];

  for (const token of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}]/g)) {
    if (token[0] === "{") objects.push(new Set());
    else if (token[0] === "}") objects.pop();
    else if (token[2]) {
      const key = JSON.parse(token[1]) as string;
      const fields = objects[objects.length - 1];

      if (fields.has(key)) throw new Error("Duplicate JSON field");
      fields.add(key);
    }
  }

  return value;
}

export function stringifyExactJson(value: unknown): string {
  const text = stringify(value, (_key, item: unknown) =>
    item instanceof Uint8Array ? Array.from(item) : item,
  );

  if (text === undefined) throw new Error("Value is not JSON serializable");

  return text;
}
