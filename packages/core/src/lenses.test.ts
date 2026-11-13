// Ways the lens catalog and selector could fail:
// 1. A malformed lens (no frontmatter, no name, no description, empty body,
//    bad regex) is accepted instead of failing loudly.
// 2. A shipped lens does not parse, or two share a name.
// 3. The lens folder is looked up from the current directory, or a folder
//    with no markdown in it (the bundle's) is picked.
// 4. A lens fires when its file glob or its content regex does not match.
// 5. More than four lenses are selected, or the ranking is not most specific
//    first, then lowest floor, then name.
// 6. A shipped lens still carries an em dash or private wording.
// 7. A lens a scanner rule covers is still handed to the reviewer though the
//    rule ran on every changed file the lens matches; or it stands down when
//    the rule ran on only some of them, or not at all.
// 8. CRLF frontmatter fences reject a valid lens with mixed line endings.
// 9. A trigger glob over the limit is accepted and silently matches nothing.
// 10. A refusal does not name the lens file and escaped trigger glob.
// 11. A valid trigger glob of exactly 1,024 characters is refused.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultLensDir,
  loadLensCatalog,
  parseLens,
  selectLensesForDiff,
  type Lens,
} from "./lenses.js";

const FILE_DIFF = [
  "diff --git a/src/api/billing.ts b/src/api/billing.ts",
  "index 111..222 100644",
  "--- a/src/api/billing.ts",
  "+++ b/src/api/billing.ts",
  "@@ -1,3 +1,5 @@",
  ' import { db } from "./db";',
  "+",
  "+await db.users.upsert({ id, stage: 'active' });",
  " export const x = 1;",
].join("\n");

describe("parseLens", () => {
  it("accepts CRLF fences with mixed line endings", () => {
    const lens = parseLens("---\r\nname: x\ndescription: y\r\n---\r\nbody\r\n");
    expect(lens.name).toBe("x");
    expect(lens.description).toBe("y");
    expect(lens.body).toBe("body");
  });

  it("throws when name or description is missing", () => {
    expect(() => parseLens(`---\ndescription: x\n---\nbody`)).toThrow(/name/);
    expect(() => parseLens(`---\nname: x\n---\nbody`)).toThrow(/description/);
  });

  it("throws when the hunk_regex is invalid", () => {
    expect(() => parseLens(`---\nname: bad\ndescription: bad\ntriggers:\n  hunk_regex: "[unclosed"\n---\nbody`)).toThrow(/regex/);
  });

  it("throws when body is empty", () => {
    expect(() => parseLens(`---\nname: a\ndescription: b\n---\n   `)).toThrow(/body/);
  });

  it("throws when frontmatter delimiters are missing", () => {
    expect(() => parseLens("no frontmatter")).toThrow(/frontmatter/);
  });

  it("refuses a trigger glob over the limit instead of silently matching nothing (9)", () => {
    const glob = "*".repeat(1025);
    expect(() => parseLens(`---\nname: long-glob\ndescription: d\ntriggers:\n  files: ["*.ts", "${glob}"]\n---\nbody`))
      .toThrow(`lens long-glob: trigger file glob exceeds 1024 characters: ${JSON.stringify(glob)}`);
  });

  it("names the lens file and escaped trigger glob in the refusal (10)", () => {
    const dir = mkdtempSync(join(tmpdir(), "openqodex-lens-"));
    const glob = '"\n' + "*".repeat(1025);
    try {
      writeFileSync(join(dir, "long-trigger.md"), `---\nname: long-glob\ndescription: d\ntriggers:\n  files: [${JSON.stringify(glob)}]\n---\nbody`);
      expect(() => loadLensCatalog(dir))
        .toThrow(`failed to parse lens long-trigger.md: lens long-glob: trigger file glob exceeds 1024 characters: ${JSON.stringify(glob)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a trigger glob of exactly 1024 characters (11)", () => {
    const glob = "*".repeat(1024);
    const lens = parseLens(`---\nname: limit-glob\ndescription: d\ntriggers:\n  files: ["${glob}"]\n---\nbody`);
    expect(lens.triggers.files).toEqual([glob]);
  });
});

function lens(name: string, triggers: Lens["triggers"], floor = 0.7): Lens {
  return { name, description: "d", triggers, confidenceFloor: floor, body: "b" };
}

describe("selectLensesForDiff without file globs", () => {
  it("matches and skips by hunk regex, case-insensitively", () => {
    const catalog = [lens("upsert", { hunkRegex: "\\bupsert\\b" })];
    expect(selectLensesForDiff({ diff: FILE_DIFF.replace("upsert", "UPSERT"), files: [], catalog })).toHaveLength(1);
    expect(selectLensesForDiff({ diff: FILE_DIFF.replace("upsert", "insert"), files: [], catalog })).toEqual([]);
  });

  it("caps the number of selected lenses at 4", () => {
    const catalog = ["l1", "l2", "l3", "l4", "l5", "l6"].map((n) => lens(n, {}));
    expect(selectLensesForDiff({ diff: "", files: [], catalog })).toHaveLength(4);
  });

  it("ranks a content-matched lens ahead of always-on ones", () => {
    const catalog = [lens("a-always", {}), lens("b-always", {}), lens("z-hunk", { hunkRegex: "upsert" })];
    const out = selectLensesForDiff({ diff: FILE_DIFF, files: [], catalog });
    expect(out.map((l) => l.name)).toEqual(["z-hunk", "a-always", "b-always"]);
  });

  it("breaks a specificity tie by lower confidence floor first", () => {
    const catalog = [lens("high", {}, 0.9), lens("low", {}, 0.6), lens("mid", {}, 0.75)];
    const out = selectLensesForDiff({ diff: "", files: [], catalog });
    expect(out.map((l) => l.name)).toEqual(["low", "mid", "high"]);
  });
});

describe("selectLensesForDiff with file globs", () => {
  it("skips a lens when no file matches the glob", () => {
    const py = lens("py-thing", { files: ["*.py", "**/*.py"] });
    expect(selectLensesForDiff({ diff: FILE_DIFF, files: ["src/api/billing.ts"], catalog: [py] })).toEqual([]);
  });

  it("ranks hunk-and-file, then file-only, then always-on", () => {
    const catalog = [
      lens("a-always", {}),
      lens("b-always", {}),
      lens("c-always", {}),
      lens("m-file", { files: ["*.ts", "**/*.ts"] }),
      lens("z-specific", { files: ["*.ts", "**/*.ts"], hunkRegex: "\\bupsert\\b" }),
    ];
    const out = selectLensesForDiff({ diff: FILE_DIFF, files: ["src/api/billing.ts"], catalog });
    expect(out.map((l) => l.name)).toEqual(["z-specific", "m-file", "a-always", "b-always"]);
  });

  it("selects the SQL lenses from the shipped catalog for Java and SQL changes", () => {
    const catalog = loadLensCatalog();
    const select = (diff: string, files: string[]) => selectLensesForDiff({ diff, files, catalog }).map((l) => l.name);
    const java = [
      "+++ b/src/main/java/com/example/EmployeeController.java",
      '+@PostMapping("/employees")',
      '+  String sql = "SELECT * FROM employees WHERE id = " + dto.getId();',
    ].join("\n");
    const picked = select(java, ["src/main/java/com/example/EmployeeController.java"]);
    expect(picked).toContain("sql-string-concatenation");
    expect(picked).toContain("auth-missing-on-state-change-route");

    const fn = `--- a/db/fn.sql\n+++ b/db/fn.sql\n@@\n+CREATE FUNCTION public.do_thing() RETURNS void\n+LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n`;
    expect(select(fn, ["db/fn.sql"])).toContain("supabase-security-definer-no-search-path");
    const migration = `--- /dev/null\n+++ b/migrations/20260610120000_x.sql\n@@\n+-- @include sql/functions/get_all_teams.sql\n`;
    expect(select(migration, ["migrations/20260610120000_x.sql"])).toContain("sql-migration-references-later-object");
    const ui = `--- a/ui/App.tsx\n+++ b/ui/App.tsx\n@@\n+const x = 1;\n`;
    expect(select(ui, ["ui/App.tsx"])).not.toContain("sql-migration-references-later-object");
  });
});

describe("a lens a scanner rule covers (7)", () => {
  const TSX_DIFF = "--- a/web/a.tsx\n+++ b/web/a.tsx\n@@\n+useEffect(() => load(id), []);\n";
  const catalog = () => loadLensCatalog().filter((l) => l.name === "react-use-effect-missing-deps");
  const ranOn = (files: string[]) => (token: string, file: string) => token === "oxlint:react-hooks/exhaustive-deps" && files.includes(file);

  it("stands down when oxlint's react rule ran on every changed file the lens matches", () => {
    const out = selectLensesForDiff({ diff: TSX_DIFF, files: ["web/a.tsx", "web/util.ts"], catalog: catalog(), covered: ranOn(["web/a.tsx"]) });
    expect(out).toEqual([]);
  });

  it("is kept when the rule ran on only some of them, or did not run", () => {
    const files = ["web/a.tsx", "legacy/b.jsx"];
    expect(selectLensesForDiff({ diff: TSX_DIFF, files, catalog: catalog(), covered: ranOn(["web/a.tsx"]) }).map((l) => l.name)).toEqual(["react-use-effect-missing-deps"]);
    expect(selectLensesForDiff({ diff: TSX_DIFF, files, catalog: catalog() }).map((l) => l.name)).toEqual(["react-use-effect-missing-deps"]);
  });
});

describe("the shipped catalog", () => {
  it("parses every lens, 49 of them, with unique names and usable bodies", () => {
    const catalog = loadLensCatalog();
    expect(catalog).toHaveLength(49);
    const names = catalog.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    for (const l of catalog) {
      expect(l.body.length).toBeGreaterThan(50);
      expect(l.confidenceFloor).toBeGreaterThan(0);
      expect(l.confidenceFloor).toBeLessThanOrEqual(1);
    }
  });

  it("carries no em dash and no provenance from another review product", () => {
    const dir = defaultLensDir();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toContain(String.fromCharCode(0x2014));
      expect(text, file).not.toMatch(/caught by|motivated this lens|qodex/i);
    }
  });
});
