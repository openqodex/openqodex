import type { Context, Next } from "hono";

export function ping(c: Context) {
  return c.text("pong");
}

export async function timing(_c: Context, next: Next) {
  await next();
}
