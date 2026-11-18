import type { Context } from "hono";

export function health(c: Context) {
  return c.text("ok");
}

export function getUser(c: Context) {
  return c.json({ id: c.req.param("id") });
}

export function listUsers(c: Context) {
  return c.json([]);
}

export function stats(c: Context) {
  return c.json({});
}
