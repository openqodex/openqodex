// Tiny glob matcher. Patterns understand:
//   *   any characters except "/"
//   **  any characters including "/"
//   ?   any single character except "/"
// Anchored at both ends, no negation, no character classes; every other
// character, regex metacharacters included, matches itself literally.
//
// The repository writes these globs (review.paths.exclude, disabled rules,
// workspace member lists, tsconfig include and exclude), so a pattern with
// many stars must not backtrack. The match walks the pattern once, keeping
// the set of path positions the pattern so far can end at:
// O(pattern parts * path length), never more.

export const MAX_GLOB = 1024; // a longer pattern matches nothing

export function matchesGlob(path: string, glob: string): boolean {
  if (glob.length > MAX_GLOB) return false;
  const n = path.length;
  let cur = new Uint8Array(n + 1);
  cur[0] = 1;
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k] as string;
    const next = new Uint8Array(n + 1);
    if (c === "*" && glob[k + 1] === "*") {
      // `**`: any position at or after one reached.
      let any = 0;
      for (let j = 0; j <= n; j++) {
        any |= cur[j] as number;
        next[j] = any;
      }
      k += 1;
      while (glob[k + 1] === "*") k += 1; // `***` is `**`
    } else if (c === "*") {
      // `*`: any position after a reached one with no slash between.
      let carry = 0;
      for (let j = 0; j <= n; j++) {
        carry |= cur[j] as number;
        next[j] = carry;
        if (path[j] === "/") carry = 0;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (!cur[j]) continue;
        const p = path[j] as string;
        if (c === "?" ? p !== "/" : p === c) next[j + 1] = 1;
      }
    }
    cur = next;
  }
  return cur[n] === 1;
}
