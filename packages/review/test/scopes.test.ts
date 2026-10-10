// The admission every part of a scoped review asks. The decisive fixture
// (scoped-review.test.ts) covers a root file, an excluded file inside the
// scope and a path that climbs out; these two cover what it cannot.
//
// Ways it could fail, written before the code:
//  1. The scope boundary is read as a text prefix or without case, so a
//     sibling folder ("services/api-old" for "services/api") or another
//     spelling ("Services/api") is admitted; or the tool's own folder
//     (.openqodex/), which the change never counts, is admitted.
//  2. A scope is taken as given when it climbs out, is absolute or names
//     the root, or an empty scope list silently admits nothing; or no scope
//     at all loses files that are not excluded.
import { describe, expect, it } from "vitest";
import { admitted } from "../src/scopes.js";

describe("admitted", () => {
  it("1. admits a folder by whole names and exact case, and never the tool's own folder", () => {
    const admit = admitted(["services/api"], []);
    expect(admit("services/api/x.ts")).toBe(true);
    for (const path of ["services/api-old/x.ts", "services/apix", "Services/api/x.ts", "services/API/x.ts", "services/api/"]) expect(admit(path), path).toBe(false);
    expect(admitted(undefined, [])(".openqodex/config.yaml")).toBe(false);
    expect(admitted(undefined, [])(".openqodex-other/x")).toBe(true);
  });

  it("2. refuses a scope that climbs out, is absolute or names the root, refuses an empty list, and with no scope admits all that is not excluded", () => {
    expect(admitted(["./services/api/", "web//app"], [])("web/app/x.ts")).toBe(true);
    for (const bad of ["../x", "a/../../b", "/etc", "a/./b", ".", "", "a\0b"]) expect(() => admitted([bad], []), bad).toThrow(/scope/);
    expect(() => admitted([], [])).toThrow(/leave scopes out to review the whole repository/);
    const all = admitted(undefined, ["**/generated/**"]);
    expect(all("canary.txt")).toBe(true);
    expect(all("services/api/generated/x.ts")).toBe(false);
  });
});
