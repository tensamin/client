import { expect, it } from "vitest";
import { parseExactJson, stringifyExactJson } from "./exactJson";

it("preserves exact signed and unsigned integer tokens and byte arrays", () => {
  const text = stringifyExactJson({
    id: 9223372036854775807n,
    bytes: new Uint8Array([0, 1, 255]),
  });
  expect(text).toBe('{"id":9223372036854775807,"bytes":[0,1,255]}');
  expect(parseExactJson(text)).toEqual({
    id: 9223372036854775807n,
    bytes: [0n, 1n, 255n],
  });
  expect(parseExactJson("18446744073709551615")).toBe(18446744073709551615n);
  for (const text of ["1.0", "1e3", "NaN", "undefined"])
    expect(() => parseExactJson(text)).toThrow();
});

it("rejects identical, different and escaped duplicate keys at every object depth", () => {
  for (const text of [
    '{"a":1,"a":1}',
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":1}',
    '[{"a":{"b":"same","b":"same"}}]',
    '{"a":[{"b":true,"b":true}]}',
    '{"constructor":1,"constructor":1}',
    '{"__proto__":{},"__proto__":{}}',
  ])
    expect(() => parseExactJson(text)).toThrow();
});

it("does not confuse escaped quotes, braces or field-like text inside strings for keys", () => {
  const value = {
    name: '"a": {"a":"b"}',
    nested: [{ name: "other" }, { name: "another" }],
    quote: '\\"',
  };
  expect(parseExactJson(JSON.stringify(value))).toEqual(value);
});
