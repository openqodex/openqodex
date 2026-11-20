import type { Handler } from "./handler";

export function run(h: Handler): string {
  return h.handle("x");
}
