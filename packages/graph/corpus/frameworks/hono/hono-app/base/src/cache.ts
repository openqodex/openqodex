import { health } from "./handlers";

// A router of the repository's own, named like Hono's class.
class Hono {
  get(_path: string, _handler: unknown): void {}
  route(_path: string, _other: Hono): void {}
}

export const fake = new Hono();
fake.get("/fake", health);
fake.route("/nested", new Hono());
const seen = new Map<string, unknown>();
seen.get("/health");
