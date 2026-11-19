// A route handler written in place (`app.get("/x", (c) => ...)`, a gin
// `r.GET("/x", func(c *gin.Context) {...})`) is a definition of its own: the
// language extractor names it in angle brackets (`<get /x>`) at the place
// the function starts. A plugin that reads such a handler binds the route to
// that definition, so the route's `handles` edge points at it and the calls
// in it are its own.
import type { PluginIndex } from "../plugin.js";

// The definition of the function written in place at `at`, or null when the
// extractor made none (an arrow inside a class, whose `this` is the
// class's, or a call the extractor does not read as a route by its shape).
export function inlineHandler(index: PluginIndex, file: string, at: { line: number; column: number }): string | null {
  const tail = `@${at.line}:${at.column}`;
  return index.symbols(file).find((n) => n.kind === "function" && n.startLine === at.line && n.name.startsWith("<") && n.id.endsWith(tail))?.id ?? null;
}
