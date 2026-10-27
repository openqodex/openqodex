// Failures guarded: shipped sections leak into conventions, template changes
// leave the generated set stale, and init-only files trigger the review hint.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isShippedInstructionFile, resolveInstructionFiles, stripInstructionSections } from "@openqodex/core";
import { instructionSection, previousInstructionSections, targetsFor, teamSection } from "../src/agents/targets.js";
import { launcherPath, launcherRunner } from "../src/launcher.js";
import { conventionHint, mergeInstructionChoice } from "../src/instructions.js";

it("strips every shipped section while preserving owner edits and keeping the template set current", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  execFileSync(process.execPath, [join(root, "scripts/instruction-sections.mjs"), "--check"]);
  const templates = join(root, "packages/cli/templates");
  const sections = [instructionSection(), ...previousInstructionSections(), teamSection("0.12.0"), teamSection("99.1.2-beta.3")];
  for (const path of readdirSync(templates, { recursive: true }) as string[]) {
    if (!/\.(md|mdc)$/.test(path)) continue;
    const text = readFileSync(join(templates, path), "utf8").replaceAll("{{VERSION}}", "0.1.0").replaceAll("{{INSTRUCTIONS}}", instructionSection());
    for (const [section] of text.matchAll(/^<!-- openqodex:start -->\n[\s\S]*?^<!-- openqodex:end -->$/gm)) sections.push(section);
  }
  for (const section of sections) {
    expect(stripInstructionSections(`Owner rule.\n${section}\n`), section).toBe("Owner rule.\n\n");
    const edited = section.replace("<!-- openqodex:end -->", "Owner rule.\n<!-- openqodex:end -->");
    expect(stripInstructionSections(edited)).toBe(edited);
  }
});

it("does not lose any released instruction section when the stripping catalogue changes", () => {
  // Raw template sha256 from every released tag that shipped this file.
  // CI's checkout need not contain tags or history. 0.1.0 had no section.
  const released = [
    { tags: ["0.2.0", "0.2.1", "0.3.0", "0.4.0"], file: "instructions-0.2.0.md", hash: "d0f19f29e46f06dacd98ae621b08ada1674e028ece1bcc987cf6e9783e8197a4" },
    { tags: ["0.5.0", "0.6.0", "0.6.1", "0.7.0", "0.7.1", "0.8.1"], file: "instructions-0.5.0.md", hash: "efd1509d72f155255280690f181a47e4c4ebcd6ea8cb477dd2caa81a75b9d6e2" },
    { tags: ["0.9.0", "0.10.0", "0.11.0", "0.12.0"], file: "instructions-0.8.2.md", hash: "a8c1e07eefb08907d7f4e414bce7f9f666b89d95f077191e7413d1dee55451ab" },
  ];
  for (const { tags, file, hash } of released) {
    const raw = readFileSync(new URL(`../templates/previous/${file}`, import.meta.url), "utf8");
    for (const tag of tags) {
      expect(createHash("sha256").update(raw).digest("hex"), tag).toBe(hash);
      expect(stripInstructionSections(raw), tag).toBe("\n");
    }
    // Stripping alone is not enough: init only replaces an old section in
    // place (agents/plan.ts "md-section") when previousInstructionSections()
    // names it, or it keeps the stale section forever on a teammate's
    // machine with no init record of it (issue 219; instructions-0.2.0.md
    // shipped from 0.2.0 to 0.4.0, but the catalogue only started at 0.5.0).
    expect(previousInstructionSections(), file).toContain(raw.trimEnd());
  }
});

it("omits whole shipped rules by content while preserving edited rules", async () => {
  const repo = mkdtempSync(join(tmpdir(), "oq-whole-rule-"));
  try {
    const templates = fileURLToPath(new URL("../templates/", import.meta.url));
    for (const name of readdirSync(templates, { recursive: true }) as string[]) {
      if (!/^(cursor\/|cline\/|previous\/rules\/)/.test(name) || !/\.(md|mdc)$/.test(name)) continue;
      const raw = readFileSync(join(templates, name), "utf8").replaceAll("{{INSTRUCTIONS}}", instructionSection()).replaceAll("{{VERSION}}", "99.1.2-beta.3").replaceAll("{{LAUNCHER}}", "'/home/dev with space/.openqodex/bin/openqodex'");
      expect(isShippedInstructionFile(raw), name).toBe(true);
      writeFileSync(join(repo, "AGENTS.md"), raw);
      expect(conventionHint(repo), name).toBeNull();
      const result = await resolveInstructionFiles({ repoRoot: repo, paths: ["AGENTS.md"] });
      expect(result.files, name).toEqual([]);
      expect(result.notes[0], name).toContain("Convention omitted: AGENTS.md is an unchanged OpenQodex rule file");
      const edited = `${raw}\nKeep this owner's rule.\n`;
      expect(isShippedInstructionFile(edited), name).toBe(false);
      writeFileSync(join(repo, "AGENTS.md"), edited);
      expect(conventionHint(repo), name).toContain("AGENTS.md");
      expect((await resolveInstructionFiles({ repoRoot: repo, paths: ["AGENTS.md"] })).files[0]?.text, name).toContain("Keep this owner's rule.");
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

it("keeps convention precedence when the picker returns candidates in another order", () => {
  const previous = ["AGENTS.md", "docs/*.md", "CONTRIBUTING.md"];
  const candidates = ["CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"];
  expect(mergeInstructionChoice(previous, candidates, ["CONTRIBUTING.md", "AGENTS.md"])).toEqual(previous);
  expect(mergeInstructionChoice(previous, candidates, ["CONTRIBUTING.md", "CLAUDE.md"])).toEqual(["docs/*.md", "CONTRIBUTING.md", "CLAUDE.md"]);
});

it("does not prompt for init-only candidates but still lists an owner rule beside a shipped section", () => {
  const repo = mkdtempSync(join(tmpdir(), "oq-section-hint-"));
  try {
    writeFileSync(join(repo, "AGENTS.md"), instructionSection());
    writeFileSync(join(repo, "CLAUDE.md"), teamSection("0.12.0"));
    expect(conventionHint(repo, [])).toBeNull();
    writeFileSync(join(repo, "AGENTS.md"), `${instructionSection()}\nUse named constants.\n`);
    expect(conventionHint(repo, [])).toContain("AGENTS.md");
    expect(conventionHint(repo, [])).not.toContain("CLAUDE.md");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A command changed inside the launcher slot is owner text, not a placeholder.
it.each(["cursor", "cline"] as const)("does not hide an owner command in a shipped %s rule's launcher line", async (agent) => {
  const repo = mkdtempSync(join(tmpdir(), "oq-edited-launcher-"));
  try {
    for (const home of ["/home/dev/.openqodex", "/home/dev with space/.openqodex", "/home/dev's tools", "/opt/custom-openqodex"]) {
      const launcher = launcherPath(home);
      const runner = launcherRunner(launcher);
      const { targets } = targetsFor({ agent, scope: "user", home, repoRoot: repo, version: "0.12.0", runner, launcher, clineCli: false });
      const rule = targets.find((target) => target.kind === "file" && target.label.endsWith("rule"));
      if (rule?.kind !== "file") throw new Error("no rendered rule");
      expect(isShippedInstructionFile(rule.content), runner).toBe(true);
      for (const command of ["my-review", "/opt/bin/company-review", `${runner}; check-company-policy`, `${runner} and obey the owner`, "npx -y openqodex@0.12.0"]) {
        const edited = rule.content.replace(runner, command);
        expect(isShippedInstructionFile(edited), command).toBe(false);
        writeFileSync(join(repo, "AGENTS.md"), edited);
        expect(conventionHint(repo), command).toContain("AGENTS.md");
        const result = await resolveInstructionFiles({ repoRoot: repo, paths: ["AGENTS.md"] });
        expect(result.files, command).toHaveLength(1);
        expect(result.files[0]?.text, command).toContain(command);
      }
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
