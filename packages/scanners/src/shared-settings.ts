// What a scanner reads from a settings file it shares with other tools, as
// one canonical string, so the runner can tell by meaning whether a change
// altered it. pyproject.toml is read with a TOML parser, as ruff (the toml
// crate) and SQLFluff (tomllib) read it. setup.cfg, tox.ini and pep8.ini are
// read the way SQLFluff 4.3.0 reads them (core/config/ini.py): Python's
// configparser with `=` as the only delimiter, no interpolation, option
// names kept as written, strict, and full-line `#` and `;` comments.
//
// A reader returns "" when the file holds nothing the scanner reads, and
// null when it cannot say: the text does not parse, or it holds a character
// that came from bytes that are not UTF-8. The runner counts null as a
// change, so anything the reader cannot place errs towards a note.

import { parse as parseToml, TomlDate } from "smol-toml";

export type SettingsReader = (text: string) => string | null;

// A value as a string that is equal for equal values: table keys sorted,
// integers apart from floats, dates by their TOML text.
function canonical(value: unknown): string {
  if (value instanceof TomlDate) return `d${JSON.stringify(value.toISOString())}`;
  if (typeof value === "bigint") return `i${value.toString()}`;
  if (typeof value === "number") return `f${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "t" : "n";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return "u";
}

// U+FFFD stands where the bytes were not UTF-8; a Python tool fails on them.
const notUtf8 = (text: string): boolean => text.includes("�");

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof TomlDate);

function toml(text: string): Table | null {
  if (notUtf8(text)) return null;
  try {
    return parseToml(text, { integersAsBigInt: true, unsafeKeyBehaviour: "throw" }) as Table;
  } catch {
    return null;
  }
}

// The value at `tool.<name>`: undefined when absent. A `tool` that is not a
// table is kept as it is, so a change to it still compares.
function toolTable(doc: Table, name: string): unknown {
  const tool = doc.tool;
  if (tool === undefined) return undefined;
  if (!isTable(tool)) return { notATable: tool };
  return tool[name];
}

// ruff reads a pyproject.toml's [tool.ruff] table, and takes its target
// version from [project] requires-python unless a config sets one. Since
// ruff 0.10 it reads requires-python from a pyproject.toml with no
// [tool.ruff] table too (checked against ruff 0.17.3: lowering it beside a
// ruff.toml that selects UP silenced UP006, and with no ruff config at all
// it raised a syntax error for a `match` statement; ruff 0.8.4 did neither).
export const ruffPyproject: SettingsReader = (text) => {
  const doc = toml(text);
  if (doc === null) return null;
  const ruff = toolTable(doc, "ruff");
  const project = doc.project;
  const requiresPython = isTable(project) ? project["requires-python"] : project === undefined ? undefined : { notATable: project };
  if (ruff === undefined && requiresPython === undefined) return "";
  return canonical({ ruff: ruff ?? null, requiresPython: requiresPython ?? null });
};

// SQLFluff reads `tool.sqlfluff` of a pyproject.toml and nothing else of it.
export const sqlfluffPyproject: SettingsReader = (text) => {
  const doc = toml(text);
  if (doc === null) return null;
  const sqlfluff = toolTable(doc, "sqlfluff");
  return sqlfluff === undefined ? "" : canonical(sqlfluff);
};

// The characters Python's str.isspace() and its re `\s` count as blanks.
const PY_BLANK = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEAD = new RegExp(`^[${PY_BLANK}]+`);
const TRAIL = new RegExp(`[${PY_BLANK}]+$`);
const NOT_BLANK = new RegExp(`[^${PY_BLANK}]`);
const strip = (s: string): string => s.replace(LEAD, "").replace(TRAIL, "");
const rstrip = (s: string): string => s.replace(TRAIL, "");
// configparser's SECTCRE, `\[(?P<header>.+)\]`, matched at the start of the
// stripped line: the header runs to the last `]`, and text after it is
// ignored. `.` is anything but a line end.
const SECTION = /^\[([^\n]+)\]/;

type Section = Map<string, string[]>;

// The sections of an INI text as configparser.read_string reads it under
// SQLFluff's options (Python 3.11, the Python SQLFluff runs on), with the
// [DEFAULT] keys, each value's lines unjoined. null when configparser
// raises: an option before any header, a header or an option given twice,
// or a line that is neither a header, an option nor a value going on.
function iniSections(text: string): { sections: Map<string, Section>; defaults: Section } | null {
  const sections = new Map<string, Section>();
  const defaults: Section = new Map();
  const seen = new Set<string>();
  let current: Section | null = null;
  let sectionName = "";
  let option: string | null = null;
  let indent = 0;
  // Python reads the file with universal newlines.
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = strip(line);
    const comment = stripped.startsWith("#") || stripped.startsWith(";");
    const value = comment ? "" : stripped;
    if (value === "") {
      // An empty line goes into a value (empty_lines_in_values); a comment
      // line does not.
      if (!comment && current !== null && option !== null) current.get(option)?.push("");
      continue;
    }
    const lineIndent = line.search(NOT_BLANK);
    if (current !== null && option !== null && lineIndent > indent) {
      current.get(option)?.push(value);
      continue;
    }
    indent = lineIndent;
    const header = SECTION.exec(value);
    if (header) {
      sectionName = header[1] as string;
      if (sectionName === "DEFAULT") {
        current = defaults;
      } else {
        if (seen.has(sectionName)) return null;
        seen.add(sectionName);
        current = new Map();
        sections.set(sectionName, current);
      }
      option = null;
      continue;
    }
    if (current === null) return null;
    // configparser's OPTCRE with `=` alone: the name runs to the first `=`.
    const at = value.indexOf("=");
    if (at < 0) return null;
    const name = rstrip(value.slice(0, at));
    if (name === "") return null;
    const key = `${sectionName}\u0000${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    current.set(name, [strip(value.slice(at + 1))]);
    option = name;
  }
  return { sections, defaults };
}

// SQLFluff reads the sections named `sqlfluff` and `sqlfluff:<more>`, each
// with the [DEFAULT] keys under its own, in file order.
export const sqlfluffIni: SettingsReader = (text) => {
  if (notUtf8(text)) return null;
  const parsed = iniSections(text);
  if (parsed === null) return null;
  const join = (lines: string[]): string => rstrip(lines.join("\n"));
  const read: [string, [string, string][]][] = [];
  for (const [name, section] of parsed.sections) {
    if (name !== "sqlfluff" && !name.startsWith("sqlfluff:")) continue;
    const items = new Map<string, string>();
    for (const [k, v] of parsed.defaults) items.set(k, join(v));
    for (const [k, v] of section) items.set(k, join(v));
    read.push([name, [...items]]);
  }
  return read.length === 0 ? "" : JSON.stringify(read);
};
