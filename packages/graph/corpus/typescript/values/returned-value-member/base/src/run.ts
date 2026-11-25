import { makeHandler } from "./handler";

export function run(): void {
  const h = makeHandler();
  h.cancel();
}
