// Bundles child-entry.ts with esbuild (the bundler tsup uses for the CLI) into
// one temp .mjs file a child `node` process can import. The code is this
// repo's own, unchanged; only the packaging differs from the CLI bundle.
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const version = (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;

export async function bundleChildEntry(): Promise<string> {
  const require = createRequire(import.meta.url);
  const tsup = dirname(require.resolve("tsup/package.json"));
  const esbuild = createRequire(join(tsup, "package.json"))("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
  const outfile = join(mkdtempSync(join(tmpdir(), "oq-child-")), "child.mjs");
  await esbuild.build({
    entryPoints: [join(here, "child-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
    define: { __OPENQODEX_VERSION__: JSON.stringify(version) },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  return outfile;
}
