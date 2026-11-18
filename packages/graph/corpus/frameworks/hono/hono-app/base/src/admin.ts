import { Hono } from "hono";
import { stats } from "./handlers";

export function buildAdmin() {
  const admin = new Hono().basePath("/v1");
  admin.get("/stats", stats);
  return admin;
}

export function pickAdmin(flag: boolean) {
  const a = new Hono();
  a.get("/a", stats);
  const b = new Hono();
  b.get("/b", stats);
  if (flag) return a;
  return b;
}
