// The gin plugin's facts of one Go file: the same walk as the net/http
// plugin's (go-http/facts.ts), watching gin's own router calls. Nothing
// here knows which name is gin: that is decided in resolve, from the file's
// imports. A route's path, a group's prefix and the method `Handle` is given
// are kept by the one rule of shared/kept.ts; every other literal is not.
import type { Node } from "web-tree-sitter";
import type { GoHttpFact, ReadSpec } from "../go-http/facts.js";
import { readFactsWith } from "../go-http/facts.js";

export type GinFact = GoHttpFact;

// The methods a router registers one HTTP method with.
export const VERBS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

const SPEC: ReadSpec = {
  watched: new Set([...VERBS, "Any", "Handle", "Match", "Group", "Use"]),
  read: { ...Object.fromEntries(VERBS.map((v) => [v, ["path"]])), Any: ["path"], Handle: ["method", "path"], Match: [null, "path"], Group: ["path"] },
};

export function readFacts(root: Node): GinFact[] {
  return readFactsWith(root, SPEC);
}
