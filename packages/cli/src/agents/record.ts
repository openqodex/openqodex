// The installation record, <openqodex home>/install.json: what `init` and
// `hook install` wrote, so a later run changes or removes only what is still
// exactly as we wrote it. A developer's edit makes a thing theirs.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readText, writeAtomic } from "./files.js";

export type InstallRecord = {
  version: 1;
  // Whole files we created or replaced: skills, rules, the launcher, git hooks.
  files: { path: string; sha256: string; usesLauncher: boolean }[];
  // Hook groups merged into a JSON settings file, exactly as inserted.
  hooks: { path: string; entry: unknown; createdFile: boolean; usesLauncher: boolean }[];
  // Markdown sections between the openqodex markers, exactly as written.
  sections: { path: string; text: string; createdFile: boolean }[];
  // Lines we added to an exclude file; `repo` is the work tree that needs it.
  excludes: { file: string; line: string; repo: string }[];
  // Copies of files as they were before we changed them.
  backups: { path: string; of: string }[];
  // Runtime folders, as versions before 0.3 recorded them. Nothing reads
  // them now; uninstall clears them.
  runtimes: string[];
  // The answer to init's pre-push hook question, per repo work tree, so a
  // second init does not ask again.
  hookChoices: { repo: string; hook: "pre-push" | "none" }[];
  // Files we rewrote in place (the Day 0 .gitignore holding "*"): the
  // original bytes, and the sha256 of what we wrote, so uninstall restores them.
  migrations: { path: string; original: string; sha256: string }[];
  // The launcher's record files, as versions before 0.3 recorded them.
  // Nothing reads them now; uninstall clears them.
  pointers: string[];
  // The answer to init's team section question, per repo work tree.
  teamChoices: { repo: string; write: boolean }[];
  // Claude Code permission rules we added to a settings file's
  // permissions.allow; a rule that was there before is not listed.
  allowRules: { path: string; rule: string }[];
};

export function emptyRecord(): InstallRecord {
  return {
    version: 1,
    files: [],
    hooks: [],
    sections: [],
    excludes: [],
    backups: [],
    runtimes: [],
    hookChoices: [],
    migrations: [],
    pointers: [],
    teamChoices: [],
    allowRules: [],
  };
}

export function recordPath(home: string): string {
  return join(home, "install.json");
}

export function loadRecord(home: string): InstallRecord {
  const text = readText(recordPath(home));
  if (text === null) return emptyRecord();
  let parsed: Partial<InstallRecord>;
  try {
    parsed = JSON.parse(text) as Partial<InstallRecord>;
  } catch {
    throw new Error(`${recordPath(home)} does not parse; move it aside and run again`);
  }
  return { ...emptyRecord(), ...parsed, version: 1 };
}

export function isEmpty(record: InstallRecord): boolean {
  return (
    record.files.length +
      record.hooks.length +
      record.sections.length +
      record.excludes.length +
      record.backups.length +
      record.runtimes.length +
      record.hookChoices.length +
      record.migrations.length +
      record.pointers.length +
      record.teamChoices.length +
      record.allowRules.length ===
    0
  );
}

// Writes the record when it changed; removes it when nothing is recorded.
export function saveRecord(home: string, record: InstallRecord, before: string): void {
  const next = `${JSON.stringify(record, null, 2)}\n`;
  if (next === before) return;
  if (isEmpty(record)) rmSync(recordPath(home), { force: true });
  else writeAtomic(recordPath(home), next, 0o600);
}

export function serialize(record: InstallRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// JSON with object keys sorted, so equal values compare equal.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
