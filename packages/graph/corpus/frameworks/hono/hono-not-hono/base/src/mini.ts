import type { Context } from "hono";

// Routers of the repository's own, named like Hono's classes, with the same methods.
class Hono {
  get(_path: string, _handler: unknown): this {
    return this;
  }
  route(_path: string, _other: Hono): this {
    return this;
  }
  use(_path: string, _handler: unknown): this {
    return this;
  }
}

class OpenAPIHono extends Hono {
  openapi(_route: unknown, _handler: unknown): this {
    return this;
  }
}

// A function of the repository's own named like zod-openapi's.
function createRoute(o: { method: string; path: string }) {
  return o;
}

export function home(c: Context) {
  return c.text("home");
}

export const app = new Hono();
const api = new OpenAPIHono();
const listRoute = createRoute({ method: "get", path: "/list" });
api.openapi(listRoute, home);
app.use("*", home);
app.get("/", home);
app.route("/api", api);
const seen = new Map<string, unknown>();
seen.get("/x");
export const schema = { openapi(_name: string) { return this; } }.openapi("User");
