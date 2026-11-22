import { createRoute as defineRoute, z } from "@hono/zod-openapi";

export const listUsersRoute = defineRoute({
  method: "get",
  path: "/",
  responses: { 200: { description: "the users" } },
});

export const getUserRoute = defineRoute({
  method: "get",
  path: "/{user_id}",
  request: { params: z.object({ user_id: z.string() }) },
  responses: { 200: { description: "one user" } },
});

export const deleteUserRoute = defineRoute({
  method: "delete",
  path: "/{user_id}/sessions/{session_id}",
  responses: { 204: { description: "deleted" } },
});

const base = process.env.BASE ?? "/x";
export const computedRoute = defineRoute({
  method: "get",
  path: base,
  responses: { 200: { description: "computed" } },
});
