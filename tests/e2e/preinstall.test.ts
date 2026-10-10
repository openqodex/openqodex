import "./global-setup.js";
import { afterAll, describe, expect, it } from "vitest";
import { root, run, toolsHome } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

// `doctor --install --all-scanners --require-all`: the image build's
// command. It installs every scanner as `--install --all-scanners` does,
// then fails when a scanner or its runtime is missing at the pinned version,
// or a tool does not report its check case's finding.
//
// The failure this guards: the command exits 0 while a scanner is missing
// (or not 0 while none is), or names a missing scanner on no stderr line or
// on several, so an image build passes without its scanners. Under CI,
// where every runtime is set up, none may be missing.
afterAll(removeTempDirs);

type Required = { ok: boolean; missing: string[]; tools: { scanner: string; version: string | null; ok: boolean; detail: string }[] };

describe("doctor --require-all", () => {
  it("exits 0 exactly when no scanner is missing, with one stderr line and one JSON entry per missing scanner", () => {
    if (process.env.OPENQODEX_E2E_OFFLINE === "1") return;
    const r = run("doctor-require-all", root, ["doctor", "--install", "--all-scanners", "--require-all", "--json"], { tools: toolsHome, timeout: 900_000 });
    const required = (JSON.parse(r.stdout) as { required: Required }).required;
    expect(r.status).toBe(required.missing.length === 0 ? 0 : 2);
    expect(required.ok).toBe(required.missing.length === 0);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("openqodex: missing: "));
    expect(lines).toEqual(required.missing.map((m) => `openqodex: missing: ${m}`));
    expect(required.tools.filter((t) => !t.ok).map((t) => `${t.scanner}: ${t.detail}`)).toEqual(required.missing);
    if (process.env.CI) expect(required.missing).toEqual([]);
  }, 900_000);
});
