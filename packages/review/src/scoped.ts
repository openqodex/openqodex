// The server review's scoped parts, put together for the review core: one
// admission (scopes.ts) decides every path; the change and the review's
// obligation come from the clone over the admitted paths (incremental.ts);
// the snapshot holds only the admitted regular files (materialize.ts); the
// graph builds from that snapshot's inventory and reads base versions only
// through the scope-checking reader, as do its packet and the scanners.
// `notes` says, one plain line each, what the review could not hold.
import type { Change } from "@openqodex/core";
import type { ListedFile } from "@openqodex/graph";
import type { IncrementalDecision } from "./incremental.js";
import { reviewChanges } from "./incremental.js";
import { materializedSnapshots, scopedBaseReader, snapshotInventory } from "./materialize.js";
import type { SnapshotMaker } from "./review-change.js";
import { admitted } from "./scopes.js";
import type { Admit } from "./scopes.js";

// What runReviewCore takes as `ReviewDeps.scoped`. Left out (the laptop),
// the change, the snapshot, the graph and the scanners are as before.
export type ScopedParts = {
  // The target's change over the admitted paths (what findings anchor on
  // and are checked against), and the review's obligation: the brief, the
  // scan and the coverage. The same change unless the review is a delta.
  change(target: { repoRoot: string; baseRef: string; baseSha: string; headSha: string; exclude: string[] }): Promise<{ full: Change; obligation: Change }>;
  // A base version of an admitted path, from the clone; any other is refused.
  readBase: (path: string, maxBytes: number) => Promise<Buffer | null>;
  // The graph's inventory of the snapshot whose tree is `tree`.
  inventory(tree: string): ListedFile[];
  // The review's one admission: the context items ask it too. The
  // reviewer's tools ask it, and log `inScope`, only when `folderScopes`:
  // with no folders given, an excluded file is simply not in the snapshot.
  admit: Admit;
  folderScopes: boolean;
};

export type ServerScope = {
  admit: Admit;
  snapshots: SnapshotMaker;
  scoped: ScopedParts;
  // What the review could not hold, one plain line each, once it ran.
  notes(): string[];
};

// The scoped parts of one server review of `clonePath`. `scopes`: the
// admitted folders (left out: the whole repository); `exclude`:
// review.paths.exclude; `decision`: the proved merge base and the delta or
// full decision (decideIncremental); `tempRoot`: where the change source
// makes its temporary folders (the review's scratch).
export function serverScope(args: { clonePath: string; workDir: string; scopes?: string[]; exclude: string[]; decision: Extract<IncrementalDecision, { ok: true }>; tempRoot?: string }): ServerScope {
  const admit = admitted(args.scopes, args.exclude);
  const maker = materializedSnapshots(args.workDir, admit);
  const refused = new Set<string>();
  const readBase = scopedBaseReader({ clonePath: args.clonePath, baseSha: args.decision.mergeBase.sha, admit, refused });
  const renamed: string[] = [];
  // Links and submodules left out of each snapshot, kept past its removal.
  const skipped = new Map<string, string>();
  const snapshots: SnapshotMaker = {
    ...maker,
    async make(repoRoot, sha, prefix, workingState) {
      const snapshot = await maker.make(repoRoot, sha, prefix, workingState);
      for (const s of maker.made.get(snapshot.tree)?.skipped ?? []) skipped.set(s.path, s.kind);
      return snapshot;
    },
  };
  return {
    admit,
    snapshots,
    scoped: {
      async change(target) {
        const got = await reviewChanges({ clonePath: target.repoRoot, baseRef: target.baseRef, mergeBaseSha: target.baseSha, headSha: target.headSha, admit, exclude: target.exclude, decision: args.decision, ...(args.tempRoot !== undefined ? { tempRoot: args.tempRoot } : {}) });
        renamed.push(...got.renamedIn);
        return { full: got.full, obligation: got.obligation };
      },
      readBase,
      inventory(tree) {
        const snap = maker.made.get(tree);
        return snap ? snapshotInventory(snap) : [];
      },
      admit,
      folderScopes: args.scopes !== undefined,
    },
    notes() {
      return [
        ...renamed.map((path) => `${path} was renamed in from a path outside the review's scopes: it is reviewed as a new file, and its earlier version is not read`),
        ...[...skipped].map(([path, kind]) => (kind === "link" ? `${path} is a link, which the snapshot does not hold` : `${path} is a submodule, which the snapshot does not hold`)),
        ...(refused.size > 0 ? [`${refused.size} base ${refused.size === 1 ? "version" : "versions"} outside the review's scopes ${refused.size === 1 ? "was" : "were"} asked for and not read`] : []),
      ];
    },
  };
}
