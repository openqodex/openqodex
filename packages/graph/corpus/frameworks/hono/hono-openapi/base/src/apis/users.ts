import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { computedRoute, deleteUserRoute, getUserRoute, listUsersRoute } from "../routes/userRoutes";

export function listUsersHandler(c: Context) {
  return c.json([]);
}

export function createUsersRouter(deps: { name: string }) {
  const getUserHandler = (c: Context) => c.json({ name: deps.name });
  const router = new OpenAPIHono();
  router.openapi(listUsersRoute, listUsersHandler);
  router.openapi(getUserRoute, getUserHandler);
  router.openapi(deleteUserRoute, makeDelete(deps));
  router.openapi(computedRoute, listUsersHandler);
  return router;
}

function makeDelete(_deps: { name: string }) {
  return (c: Context) => c.body(null, 204);
}
