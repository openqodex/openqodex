import { OpenAPIHono } from "@hono/zod-openapi";
import { createUsersRouter } from "./users";

export function createSettingsRouter() {
  const router = new OpenAPIHono();
  router.route("/members", createUsersRouter({ name: "member" }));
  return router;
}
