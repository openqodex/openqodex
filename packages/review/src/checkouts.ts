// <openqodex home>/checkouts: where the laptop's snapshot maker (the CLI's
// checkout.ts) makes the frozen copy each review reads. A reviewer program
// that resolves inside it is never run (agents/driver.ts findOnPath).
import { join } from "node:path";
import { openqodexHome } from "@openqodex/scanners";

export function checkoutsDir(): string {
  return join(openqodexHome(), "checkouts");
}
