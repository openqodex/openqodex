import type { Context, Next } from "hono";

export async function logger(_c: Context, next: Next) {
  await next();
}

export async function requireAuth(_c: Context, next: Next) {
  await next();
}
