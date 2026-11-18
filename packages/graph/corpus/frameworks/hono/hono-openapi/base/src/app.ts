import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { createSettingsRouter } from "./apis/settings";
import { createUsersRouter } from "./apis/users";
import { requireAuth } from "./middleware";

function withAuth(router: OpenAPIHono, middleware: MiddlewareHandler): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use("*", middleware);
  shell.route("/", router);
  return shell;
}

function wrapOther(router: OpenAPIHono): OpenAPIHono {
  const fresh = new OpenAPIHono();
  void router;
  return fresh;
}

export function createServerApp() {
  const app = new OpenAPIHono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.route("/api/v1/users", withAuth(createUsersRouter({ name: "user" }), requireAuth));
  app.route("/api/v1/settings", withAuth(createSettingsRouter(), requireAuth));
  app.route("/api/v1/other", wrapOther(createUsersRouter({ name: "other" })));
  app.route("/api/v1/remote", loadRouter());
  return app;
}
