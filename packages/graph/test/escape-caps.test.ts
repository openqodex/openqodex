// Every cap of the graph is backed by the escape corpus, so a new place
// where the graph gives up cannot come back silent. Ways it could fail,
// written before the code:
//  1. A new cap, depth limit or budget (a constant named like MAX_*,
//     *_CAP, *_BUDGET, *_LIMIT or *_STEPS in packages/graph/src) ships
//     with no corpus case that trips it and proves the hidden caller is
//     floored: no case of escape-corpus/ names it in `caps`, and it is not
//     listed below with the reason it needs none.
//  2. A constant is renamed or removed and a case or the list below still
//     names it, so the backing reads as present when it is not.
//  3. A constant is both tripped by a case and excused below, so the
//     excuse outlives the case.
//  4. An excuse that points at another test names a file that is gone.
//
// The list below is every cap that no corpus case trips, one line each:
// "no-caller", it cannot hide a caller of a `callers` answer; "elsewhere",
// another test trips it and proves the floor (the input is a clock, the
// heap, or too large for a case); "no-row", it may hide a caller and no
// test here proves the floor yet. A "no-row" entry is debt: it is listed so
// the debt is seen, and the next case that trips it moves it to `caps`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const corpus = join(here, "escape-corpus");

type Excuse = { kind: "no-caller" | "elsewhere" | "no-row"; why: string };
const EXCUSED: Record<string, Excuse> = {
  "build.ts#DEFAULT_BUDGET_MS": { kind: "elsewhere", why: "caps.test.ts (2): a build out of time reads no more files and is partial, which floors every answer; how far it gets is time, not input" },
  "build.ts#DEFAULT_MAX_HEAP_MB": { kind: "elsewhere", why: "caps.test.ts (3): a build past the memory bound reads no more files and is partial; the bound is the heap, not input" },
  "capture/capture.ts#MAX_CAPTURE_FILE_BYTES": { kind: "no-caller", why: "bounds the copy of a file kept for later reading; the graph reads the file itself, under DEFAULT_MAX_FILE_BYTES" },
  "discovery/projects.ts#MAX_REQUIREMENT_INCLUDES": { kind: "no-caller", why: "a requirements file past it only leaves a Python package undeclared, which hides no call (docs/graph.md, the metadata table)" },
  "extract.ts#LABEL_MAX": { kind: "no-caller", why: "shortens the label of a callback (`<on click>`); no call is dropped" },
  "extract.ts#MAX_LITERALS": { kind: "no-row", why: "object literals past it may fill a TypeScript interface; no small case found where the cut changes a callers answer" },
  "extract.ts#MAX_LITERAL_KEYS": { kind: "no-row", why: "the keys past it may fill a TypeScript interface; no small case found where the cut changes a callers answer" },
  "extract.ts#MAX_TYPE_NODES": { kind: "no-caller", why: "a type annotation holds no call: the cut hides type uses, read by `references`, never a caller" },
  "frameworks/django/facts.ts#MAX_ASSIGNED": { kind: "no-row", why: "a limit of the plugin's fact reader (2000): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/django/facts.ts#MAX_SETTINGS": { kind: "no-row", why: "a limit of the plugin's fact reader (400): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/django/resolve.ts#MAX_FAN_OUT": { kind: "no-row", why: "a cap a small case could trip (32); no corpus row yet" },
  "frameworks/django/resolve.ts#MAX_FIELD_CHAIN": { kind: "no-caller", why: "a model field's base chain: its gaps reach declares_field, which is data, never a call" },
  "frameworks/django/resolve.ts#MAX_REGISTRATIONS_PER_APP": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/django/resolve.ts#MAX_RESOLVE_STEPS": { kind: "no-row", why: "trips past 2_000_000 in one build; too large for a corpus case" },
  "frameworks/django/resolve.ts#MAX_WALK_STEPS": { kind: "no-row", why: "trips past 200_000 in one build; too large for a corpus case" },
  "frameworks/django/routes.ts#MAX_REQUEST": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/django/routes.ts#MAX_TOKENS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/express/facts.ts#MAX_SCOPE_CHAIN": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/facts.ts#MAX_SCOPE_NAMES": { kind: "no-row", why: "a limit of the plugin's fact reader (256): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/js.ts#MAX_DEPTH": { kind: "no-row", why: "a limit of the plugin's fact reader (6): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/js.ts#MAX_NAME_PARTS": { kind: "no-row", why: "a limit of the plugin's fact reader (16): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/js.ts#MAX_NODES": { kind: "no-row", why: "a limit of the plugin's fact reader (256): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/js.ts#MAX_PARTS": { kind: "no-row", why: "a limit of the plugin's fact reader (32): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/js.ts#MAX_SOURCE_BYTES": { kind: "no-row", why: "a file over 256 * 1024 is not read by the plugin; too large for a corpus case" },
  "frameworks/express/js.ts#MAX_STRING": { kind: "no-row", why: "a limit of the plugin's fact reader (2048): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/express/resolve.ts#LIMIT": { kind: "no-caller", why: "the table of this plugin's step budgets; each is listed here under its own MAX_ name" },
  "frameworks/express/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_FACTS_READ": { kind: "no-row", why: "trips past 400_000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 200_000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_MATCH_WORK": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/express/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 30_000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_MOUNTS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_PATTERN_SEGMENTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/express/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/express/resolve.ts#MAX_STRING_WRITES": { kind: "no-row", why: "a cap a small case could trip (32); no corpus row yet" },
  "frameworks/express/resolve.ts#MAX_TEST_LINKS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/express/resolve.ts#MAX_TEST_REQUESTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/express/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/facts.ts#MAX_PLUGIN_SOURCE_BYTES": { kind: "no-row", why: "a file over 1024 * 1024 is not read by the plugin; too large for a corpus case" },
  "frameworks/fastapi/facts.ts#MAX_PARAMS": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/facts.ts#MAX_SOURCE_BYTES": { kind: "no-row", why: "a file over 256 * 1024 is not read by the plugin; too large for a corpus case" },
  "frameworks/fastapi/py.ts#MAX_ARGS": { kind: "no-row", why: "a limit of the plugin's fact reader (24): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/py.ts#MAX_DEPTH": { kind: "no-row", why: "a limit of the plugin's fact reader (6): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/py.ts#MAX_EXPR_NODES": { kind: "no-row", why: "a limit of the plugin's fact reader (256): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/py.ts#MAX_LIST_ITEMS": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/py.ts#MAX_NAME_PARTS": { kind: "no-row", why: "a limit of the plugin's fact reader (16): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/py.ts#MAX_STRING_PIECES": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/fastapi/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_EDGES": { kind: "no-row", why: "trips past 60_000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 200_000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_MATCH_WORK": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/fastapi/resolve.ts#MAX_MIDDLEWARE_CHAIN": { kind: "no-row", why: "a cap a small case could trip (64); no corpus row yet" },
  "frameworks/fastapi/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 40_000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_MODEL_DEPTH": { kind: "no-row", why: "a cap a small case could trip (8); no corpus row yet" },
  "frameworks/fastapi/resolve.ts#MAX_MOUNTS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_PATTERN_SEGMENTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/fastapi/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/fastapi/resolve.ts#MAX_SEGMENT_CHARS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/fastapi/resolve.ts#MAX_TEST_REQUESTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/fastapi/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_EDGES": { kind: "no-row", why: "trips past 60_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 100_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_STEPS": { kind: "no-row", why: "trips past 1_000_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/gin/resolve.ts#MAX_VALUE_STEPS": { kind: "no-row", why: "a cap a small case could trip (8); no corpus row yet" },
  "frameworks/go-http/facts.ts#MAX_ARGS": { kind: "no-row", why: "a limit of the plugin's fact reader (24): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_EXPR_DEPTH": { kind: "no-row", why: "a limit of the plugin's fact reader (96): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_EXPR_NODES": { kind: "no-row", why: "a limit of the plugin's fact reader (256): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_NAME_PARTS": { kind: "no-row", why: "a limit of the plugin's fact reader (16): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_PARTS": { kind: "no-row", why: "a limit of the plugin's fact reader (32): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_SCOPES": { kind: "no-row", why: "a limit of the plugin's fact reader (16): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/facts.ts#MAX_SOURCE_BYTES": { kind: "no-row", why: "a file over 256 * 1024 is not read by the plugin; too large for a corpus case" },
  "frameworks/go-http/facts.ts#MAX_STRING": { kind: "no-row", why: "a limit of the plugin's fact reader (2048): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/go-http/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_COMPOSE_STEPS": { kind: "no-row", why: "trips past 1_000_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_EDGES": { kind: "no-row", why: "trips past 60_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 100_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_MATCH_WORK": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/go-http/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 30_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_MOUNTS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_PATTERN_SEGMENTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/go-http/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_TEST_LINKS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/go-http/resolve.ts#MAX_TEST_REQUESTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/go-http/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/go-http/resolve.ts#MAX_VALUE_STEPS": { kind: "no-row", why: "a cap a small case could trip (8); no corpus row yet" },
  "frameworks/hono/facts.ts#MAX_CHAIN": { kind: "no-row", why: "a limit of the plugin's fact reader (32): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/hono/facts.ts#MAX_SCOPE_CHAIN": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/hono/facts.ts#MAX_SCOPE_NAMES": { kind: "no-row", why: "a limit of the plugin's fact reader (256): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/hono/resolve.ts#LIMIT": { kind: "no-caller", why: "the table of this plugin's step budgets; each is listed here under its own MAX_ name" },
  "frameworks/hono/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_CALL_DEPTH": { kind: "no-row", why: "a cap a small case could trip (8); no corpus row yet" },
  "frameworks/hono/resolve.ts#MAX_FACTS_READ": { kind: "no-row", why: "trips past 400_000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 200_000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 30_000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_MOUNTS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_STEPS": { kind: "no-row", why: "trips past 1_000_000 in one build; too large for a corpus case" },
  "frameworks/hono/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/impact.ts#MAX_ROUTES": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/impact.ts#MAX_ROWS": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/impact.ts#MAX_SEEDS": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/impact.ts#MAX_TESTS": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/junit/facts.ts#MAX_ANNOTATIONS": { kind: "no-caller", why: "the junit plugin links tests to the code they test; its gaps reach `tests` only" },
  "frameworks/junit/facts.ts#MAX_NAME": { kind: "no-caller", why: "the junit plugin links tests to the code they test; its gaps reach `tests` only" },
  "frameworks/junit/facts.ts#MAX_NESTING": { kind: "no-caller", why: "the junit plugin links tests to the code they test; its gaps reach `tests` only" },
  "frameworks/junit/resolve.ts#MAX_HIERARCHY": { kind: "no-caller", why: "the junit plugin links tests to the code they test; its gaps reach `tests` only" },
  "frameworks/junit/resolve.ts#MAX_WORK": { kind: "no-caller", why: "the junit plugin links tests to the code they test; its gaps reach `tests` only" },
  "frameworks/nest/facts.ts#MAX_CONSTANT_STEPS": { kind: "no-row", why: "a limit of the plugin's fact reader (4): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_DEPTH": { kind: "no-row", why: "a limit of the plugin's fact reader (8): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_EXPORTED_CONSTANT": { kind: "no-row", why: "a limit of the plugin's fact reader (100): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_ITEMS": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_MEMBERS": { kind: "no-row", why: "a limit of the plugin's fact reader (500): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_NAMES": { kind: "no-row", why: "a limit of the plugin's fact reader (1000): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_SHADOW_STEPS": { kind: "no-row", why: "a limit of the plugin's fact reader (50_000): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nest/facts.ts#MAX_SOURCE_BYTES": { kind: "no-row", why: "a file over 256 * 1024 is not read by the plugin; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_APPS": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_LOOKUPS": { kind: "no-row", why: "trips past 200_000 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 30_000 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_MODULE_VISITS": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_PATHS_PER_ROUTE": { kind: "no-row", why: "a cap a small case could trip (64); no corpus row yet" },
  "frameworks/nest/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_ROUTE_TABLE": { kind: "no-row", why: "trips past 256 in one build; too large for a corpus case" },
  "frameworks/nest/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/nextjs/facts.ts#MAX_MATCHERS": { kind: "no-row", why: "a limit of the plugin's fact reader (64): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/nextjs/resolve.ts#LIMIT": { kind: "no-caller", why: "the table of this plugin's step budgets; each is listed here under its own MAX_ name" },
  "frameworks/nextjs/resolve.ts#MAX_FACTS_READ": { kind: "no-row", why: "trips past 400_000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_MATCH_WORK": { kind: "no-row", why: "trips past 4_000_000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_MIDDLEWARE_EDGES": { kind: "no-row", why: "trips past 30_000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_PATHS": { kind: "no-row", why: "trips past 1_000_000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_ROLES": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/nextjs/resolve.ts#MAX_UNKNOWNS": { kind: "no-row", why: "trips past 5000 in one build; too large for a corpus case" },
  "frameworks/plugin.ts#MAX_EDGES_PER_APP": { kind: "no-row", why: "trips past 100_000 in one build; too large for a corpus case" },
  "frameworks/plugin.ts#MAX_ENTITIES_PER_APP": { kind: "no-row", why: "trips past 20_000 in one build; too large for a corpus case" },
  "frameworks/plugin.ts#MAX_FACTS_PER_FILE": { kind: "no-row", why: "trips past 2000 in one build; too large for a corpus case" },
  "frameworks/rails/facts.ts#MAX_COLUMN_NODES": { kind: "no-row", why: "a limit of the plugin's fact reader (500): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/rails/facts.ts#MAX_HELPER": { kind: "no-row", why: "a limit of the plugin's fact reader (128): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/rails/facts.ts#MAX_NODE_DEPTH": { kind: "no-row", why: "a limit of the plugin's fact reader (200): past it a value is not read; not checked that this records a gap a caller floor reads" },
  "frameworks/rails/inflect.ts#MAX_NAME": { kind: "no-row", why: "a cap a small case could trip (128); no corpus row yet" },
  "frameworks/rails/match.ts#MAX_OPTIONAL_GROUPS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/rails/match.ts#MAX_PATTERN_SEGMENTS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/rails/match.ts#MAX_REQUEST_CHARS": { kind: "no-caller", why: "matches a test's request to a route; its gaps reach `tests` only" },
  "frameworks/rails/resolve.ts#MAX_SUBCLASSES": { kind: "no-row", why: "a cap a small case could trip (32); no corpus row yet" },
  "frameworks/rails/resolve.ts#MAX_THROUGH": { kind: "no-row", why: "a cap a small case could trip (4); no corpus row yet" },
  "frameworks/rails/resolve.ts#WORK_BUDGET": { kind: "no-row", why: "trips past 2_000_000 in one build; too large for a corpus case" },
  "frameworks/rails/routes.ts#MAX_REGISTRATIONS": { kind: "no-row", why: "trips past 10_000 in one build; too large for a corpus case" },
  "frameworks/rails/world.ts#MAX_CHAIN": { kind: "no-row", why: "a cap a small case could trip (8); no corpus row yet" },
  "frameworks/react/resolve.ts#LIMIT": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_CHAIN_DEPTH": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_FACTS_READ": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_LOOKUPS": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_RENDER_EDGES": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_ROLES": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_TEST_LINKS": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/react/resolve.ts#MAX_UNKNOWNS": { kind: "no-caller", why: "the react plugin's gaps reach renders and tests, which a caller floor reads as no call (query/frameworks.ts DATA_KINDS)" },
  "frameworks/render.ts#MAX_LITERAL": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/render.ts#MAX_ROWS": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "frameworks/shared/kept.ts#MAX_KEPT": { kind: "no-caller", why: "what the framework block of the brief shows or keeps as text; no relation is dropped" },
  "impact.ts#WALK_LIMIT": { kind: "elsewhere", why: "gaps.test.ts (8): the review's change-impact walk only; its cut floors the impact answer with a gap at the cut seed's definition; the corpus asks `callers`" },
  "query/context.ts#MAX_CONTEXT": { kind: "no-caller", why: "source lines shown beside a row; no row is dropped" },
  "query/context.ts#MAX_LINE": { kind: "no-caller", why: "source lines shown beside a row; no row is dropped" },
  "query/ids.ts#MAX_EDGE_ID": { kind: "no-caller", why: "the longest edge id a question accepts back; no row is dropped" },
  "query/page.ts#DEFAULT_LIMIT": { kind: "no-caller", why: "a page of an answer; `truncated` gives the cursor of the next one" },
  "query/page.ts#MAX_CURSOR": { kind: "no-caller", why: "a page of an answer; `truncated` gives the cursor of the next one" },
  "query/page.ts#MAX_LIMIT": { kind: "no-caller", why: "a page of an answer; `truncated` gives the cursor of the next one" },
  "query/traverse.ts#MAX_QUERY_MS": { kind: "elsewhere", why: "query-budget.test.ts: a question stopped by its time budget is a floor that names where it stopped" },
  "render.ts#MAX_CALLEES": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_CONSUMERS": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_EXPORTS": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_FLOOR_SEEDS": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_IMPORTERS": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_NAME": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_NEAR": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_PROSE": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_REFERENCES": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "render.ts#MAX_TOUCHED": { kind: "no-caller", why: "what the review brief shows; it says how much it left out, and the packet holds the rest" },
  "resolve.ts#EXPORT_WALK_STEPS": { kind: "elsewhere", why: "export-walk.test.ts (3, 4, 9): the cut walk floors what it did not reach; it needs over 2,000 barrel files" },
  "resolve.ts#STRUCT_STEPS": { kind: "no-row", why: "a structural type lookup past 1,024 steps reads as not known, so the call stays unbound; no small case found that trips it" },
  "review/packet.ts#MAX_BASE_BYTES": { kind: "no-caller", why: "what the review packet writes beside the callers it lists; no caller is dropped" },
  "review/packet.ts#MAX_BASE_LINES": { kind: "no-caller", why: "what the review packet writes beside the callers it lists; no caller is dropped" },
  "review/packet.ts#MAX_UNKNOWNS": { kind: "no-caller", why: "what the review packet writes beside the callers it lists; no caller is dropped" },
  "safe-fs.ts#MAX_ITEMS": { kind: "no-caller", why: "saved facts past it fail their check and the file is parsed again" },
  "store/leases.ts#LEASE_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/lock.ts#MAX_PID": { kind: "no-caller", why: "the largest process id a lock file may name; no call is read through it" },
  "store/store.ts#FACTS_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/store.ts#GENERATION_FILE_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/store.ts#LOCK_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/store.ts#MANIFEST_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/store.ts#META_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/store.ts#POINTER_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/trust.ts#RECORD_MAX_BYTES": { kind: "no-caller", why: "the largest file of the graph's folder kept or read back; a larger one is not kept or reads as absent, and the graph is built again" },
  "store/types.ts#DEFAULT_MAX_CACHE_MB": { kind: "no-caller", why: "the graph folder's size bound: facts past it are not stored, and the build keeps them in memory (caps.test.ts 5)" },
  "store/types.ts#LEASE_MAX_AGE_MS": { kind: "no-caller", why: "how long a lease keeps a build from the collector; no call is read through it" },
  "test-timing.ts#MAX_GROWTH": { kind: "no-caller", why: "a helper of the speed tests, not code the graph runs" },
  "test-timing.ts#MAX_REPEATS": { kind: "no-caller", why: "a helper of the speed tests, not code the graph runs" },
  "types.ts#MAX_AMBIENT_NAMES": { kind: "no-caller", why: "a global name past it is not vouched for as plain data, which can only add a floor" },
  "types.ts#MAX_FACT_STRING": { kind: "no-caller", why: "saved facts with a longer string fail their check and are parsed again; a longer global name is not vouched for, which only adds a floor" },
};

// A cap's name: a word of it is MAX, CAP, BUDGET, LIMIT or STEPS.
const CAP_NAME = /(^|_)(MAX|CAP|BUDGET|LIMIT|STEPS)(_|$)/;

// "path#NAME" of every constant declared in packages/graph/src whose name reads as a cap.
function capsInSource(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const m = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*[:=]/.exec(line);
          if (m && CAP_NAME.test(m[1] as string)) out.push(`${relative(src, path).split("\\").join("/")}#${m[1]}`);
        }
      }
    }
  };
  walk(src);
  return out.sort();
}

// Each cap a corpus case names, with the cases that name it.
function capsInCorpus(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(corpus).filter((x) => x.endsWith(".json"))) {
    const spec = JSON.parse(readFileSync(join(corpus, f), "utf8")) as { caps?: string[] };
    for (const cap of spec.caps ?? []) out.set(cap, [...(out.get(cap) ?? []), f]);
  }
  return out;
}

describe("every cap of the graph is backed by the escape corpus", () => {
  const source = capsInSource();
  const rows = capsInCorpus();

  it("finds the caps it checks (a scan that finds none would pass anything)", () => {
    expect(source).toContain("resolve.ts#DISPATCH_CAP");
    expect(source.length).toBeGreaterThan(100);
  });

  it("names each cap in a corpus case or in the list of excuses (1)", () => {
    const bare = source.filter((k) => !rows.has(k) && !(k in EXCUSED));
    expect(bare, "add a corpus case that trips each of these, with the constant in its `caps`, or list it in EXCUSED with why").toEqual([]);
  });

  it("names no cap that is not in the source (2)", () => {
    const known = new Set(source);
    expect([...rows.keys()].filter((k) => !known.has(k)), "corpus `caps` naming no constant").toEqual([]);
    expect(Object.keys(EXCUSED).filter((k) => !known.has(k)), "EXCUSED naming no constant").toEqual([]);
  });

  it("excuses no cap a corpus case trips (3)", () => {
    expect(Object.keys(EXCUSED).filter((k) => rows.has(k))).toEqual([]);
  });

  it("points each excuse that names another test at a test file that exists (4)", () => {
    for (const [k, e] of Object.entries(EXCUSED)) {
      if (e.kind !== "elsewhere") continue;
      const file = /([\w-]+\.test\.ts)/.exec(e.why)?.[1];
      expect(file, `${k}: an excuse "elsewhere" names the test that trips it`).toBeDefined();
      expect(existsSync(join(here, file as string)), `${k}: ${file}`).toBe(true);
    }
  });
});
