import type { Context, Next } from "hono";

export async function requireAuth(_c: Context, next: Next) {
  await next();
}
