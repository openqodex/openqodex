import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Synthetic fixture only, never a real key. Same shape as the demo's key.
export const FIXTURE_SECRET = "sk_" + "live_" + "GoldenFixture09AbCdEf12Z";

export function fixDemoSecret(demo) {
  const generated = readFileSync(join(demo, "app/config.py"), "utf8").match(/sk_live_[A-Za-z0-9]{24}/)?.[0];
  if (!generated) throw new Error("demo has no generated secret");
  const files = [];
  let replacements = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const raw = readFileSync(path, "utf8");
        const parts = raw.split(generated);
        if (parts.length === 1) continue;
        replacements += parts.length - 1;
        writeFileSync(path, parts.join(FIXTURE_SECRET));
        files.push(relative(demo, path));
      }
    }
  }
  walk(demo);
  return { files, replacements };
}
