import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// The published package is one file per entry with every dependency inlined,
// so a user installs nothing but this tarball: dist/bin.js, the command, and
// dist/lib.js, the library. Both sit in dist/, so code that finds the lenses,
// the toolchain table and the grammars one folder up from itself lands on the
// package root from either. The command's `#!` line is in bin.ts itself, so
// the library has none. Bundled CommonJS code that calls require() for Node
// built-ins needs a real require in ESM output, hence the shim.
//
// The library's declarations are one file with the workspace packages'
// types inlined: the published package ships none of @openqodex/*, so
// dist/lib.d.ts may import nothing but Node's own modules.
export default defineConfig({
  entry: { bin: "src/bin.ts", lib: "src/lib.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: [/.*/],
  splitting: false,
  dts: { entry: { lib: "src/lib.ts" }, resolve: [/^@openqodex\//] },
  clean: true,
  sourcemap: false,
  define: {
    __OPENQODEX_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      'import { createRequire as __openqodexCreateRequire } from "node:module";',
      "const require = __openqodexCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
