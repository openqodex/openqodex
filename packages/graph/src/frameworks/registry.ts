// The shipped framework plugins. Only plugins listed here ever run; a
// repository can never add one. A new plugin is one import and one entry
// in PLUGINS, in id order.
import { django } from "./django/index.js";
import { express } from "./express/index.js";
import { fastapi } from "./fastapi/index.js";
import { goHttp } from "./go-http/index.js";
import { junit } from "./junit/index.js";
import { nextjs } from "./nextjs/index.js";
import type { FrameworkPlugin } from "./plugin.js";
import { PLUGIN_API_VERSION } from "./plugin.js";
import { rails } from "./rails/index.js";
import { react } from "./react/index.js";

export const PLUGINS: readonly FrameworkPlugin[] = [django, express, fastapi, goHttp, junit, nextjs, rails, react] as FrameworkPlugin[];

// Part of every cached facts key: a plugin added, removed or bumped
// re-reads every file's facts.
export function pluginsKey(plugins: readonly FrameworkPlugin[] = PLUGINS): string {
  return [`api${PLUGIN_API_VERSION}`, ...plugins.map((p) => `${p.id}@${p.version}`)].join(",");
}
