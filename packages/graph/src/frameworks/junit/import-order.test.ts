import { junit } from "./index.js";
import { PLUGINS } from "../registry.js";
import { expect, it } from "vitest";

it("loads JUnit first without an import cycle leaving an undefined registry entry", () => {
  expect(junit.id).toBe("junit");
  expect(PLUGINS).not.toContain(undefined);
  expect(PLUGINS).toContain(junit);
});
