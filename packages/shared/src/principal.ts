import { z } from "zod";

export const principalSchema = z.strictObject({
  authority: z.string().regex(/^(omega-key:|authority:iota:v1:)[a-f0-9]{64}$/),
  user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type Principal = z.infer<typeof principalSchema>;

export function encodePrincipal(value: Principal): string {
  const { authority, user_id } = principalSchema.parse(value);
  return JSON.stringify({ authority, user_id });
}

export function parsePrincipal(value: string): Principal {
  const principal = principalSchema.parse(JSON.parse(value));
  if (encodePrincipal(principal) !== value) {
    throw new Error("Noncanonical principal");
  }
  return principal;
}

export function deriveChatId(a: Principal, b: Principal): string {
  const first = principalSchema.parse(a);
  const second = principalSchema.parse(b);
  const order =
    first.authority < second.authority
      ? -1
      : first.authority > second.authority
        ? 1
        : first.user_id - second.user_id;
  if (order === 0) throw new Error("Conversation requires distinct principals");
  const pair = order < 0 ? [first, second] : [second, first];
  const json = `[${pair.map(encodePrincipal).join(",")}]`;
  return `principal:${btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
