import { z } from "zod";
import { parse } from "lossless-json";

export const principalSchema = z.strictObject({
  authority: z.string().regex(/^(omega-key:|authority:iota:v1:)[a-f0-9]{64}$/),
  user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type Principal = z.infer<typeof principalSchema>;

export const wirePrincipalSchema = z.strictObject({
  authority: principalSchema.shape.authority,
  user_id: z
    .union([principalSchema.shape.user_id, z.bigint()])
    .transform(BigInt)
    .pipe(
      z
        .bigint()
        .min(1n)
        .max((1n << 63n) - 1n),
    ),
});

export type WirePrincipal = z.output<typeof wirePrincipalSchema>;

export function encodePrincipal(value: Principal | WirePrincipal): string {
  const { authority, user_id } = wirePrincipalSchema.parse(value);
  return `{"authority":${JSON.stringify(authority)},"user_id":${user_id}}`;
}

export function parseWirePrincipal(value: string): WirePrincipal {
  const principal = wirePrincipalSchema.parse(
    parse(value, undefined, { parseNumber: BigInt }),
  );
  if (encodePrincipal(principal) !== value)
    throw new Error("Noncanonical principal");
  return principal;
}

export function parsePrincipal(value: string): Principal {
  const { authority, user_id } = parseWirePrincipal(value);
  return principalSchema.parse({ authority, user_id: Number(user_id) });
}

export function deriveChatId(
  a: Principal | WirePrincipal,
  b: Principal | WirePrincipal,
): string {
  const first = wirePrincipalSchema.parse(a);
  const second = wirePrincipalSchema.parse(b);
  const order =
    first.authority < second.authority
      ? -1
      : first.authority > second.authority
        ? 1
        : first.user_id < second.user_id
          ? -1
          : first.user_id > second.user_id
            ? 1
            : 0;
  if (order === 0) throw new Error("Conversation requires distinct principals");
  const pair = order < 0 ? [first, second] : [second, first];
  const json = `[${pair.map(encodePrincipal).join(",")}]`;
  return `principal:${btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
