// Folder scopes for the server review: the one decision every part of a
// scoped review asks of a repository path. A path is admitted when it lies
// inside one of the scope folders (none given: the whole repository) and
// review.paths.exclude does not name it. Everything that reads the code
// under review asks the same function: the change (a file outside is not in
// it; a file renamed from outside is a new file, its earlier version never
// read), the snapshot (only admitted files are written), the scanners (they
// run on that snapshot and the admitted change), the code graph (its
// inventory and its base reads), the reviewer's tools, the context items,
// the citations and the findings.
import { OpenQodexError, STATE_DIR, matchesGlob } from "@openqodex/core";

// Whether a repository path, as git spells it ("a/b.ts"), is admitted.
export type Admit = (path: string) => boolean;

// A repository path: relative, "/" between names, no empty, "." or ".."
// part, no NUL. Anything else names no file of the repository.
function plainPath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

// A scope folder in its plain form: "./services/api/" and "services//api"
// are "services/api". A scope that is absolute, climbs out, or names the
// root is refused: leave scopes out to review the whole repository.
function scopeFolder(scope: string): string {
  if (typeof scope !== "string" || scope.includes("\0") || scope.startsWith("/")) {
    throw new OpenQodexError(`the scope ${JSON.stringify(String(scope).slice(0, 200))} is not a folder of the repository; give folders relative to its root`);
  }
  const parts = scope.split("/").filter((part) => part !== "");
  while (parts[0] === ".") parts.shift();
  const folder = parts.join("/");
  if (!plainPath(folder)) {
    throw new OpenQodexError(`the scope ${JSON.stringify(scope.slice(0, 200))} is not a folder of the repository; give folders relative to its root, and leave scopes out to review the whole repository`);
  }
  return folder;
}

// The admission function of a review. `scopes`: the folders admitted, or
// undefined for the whole repository. `exclude`: review.paths.exclude. The
// tool's own folder (.openqodex/) is never admitted, as the change source
// never counts it. Paths are compared as git spells them, case included.
export function admitted(scopes: readonly string[] | undefined, exclude: readonly string[]): Admit {
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length === 0)) {
    throw new OpenQodexError("scopes must name at least one folder; leave scopes out to review the whole repository");
  }
  const folders = scopes === undefined ? null : [...new Set(scopes.map(scopeFolder))];
  const globs = [...exclude];
  return (path) => {
    if (typeof path !== "string" || !plainPath(path)) return false;
    if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) return false;
    if (folders !== null && !folders.some((f) => path === f || path.startsWith(`${f}/`))) return false;
    return !globs.some((g) => matchesGlob(path, g));
  };
}
