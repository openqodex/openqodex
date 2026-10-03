// `openqodex guide [topic]`: the docs that ship inside the package, so an
// agent can read them offline. `guide skill`, and `guide` with no topic,
// print the full review procedure of this version: the shipped skill with
// every command written for the runner that started it, the launcher when
// the launcher started it, else the pinned npx form of this version.
import { readdirSync, readFileSync } from "node:fs";
import { assetPath } from "../assets.js";
import { renderSkill } from "../agents/targets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { launcherPath, launcherRunner, launcherStarted, openqodexHomeDir } from "../launcher.js";

function topics(): string[] {
  try {
    return readdirSync(assetPath("docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export async function run(args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, { positionals: 1 });
  const topic = positionals[0];
  if (topic === undefined || topic === "skill") {
    const runner = launcherStarted() ? launcherRunner(launcherPath(openqodexHomeDir())) : `npx -y openqodex@${__OPENQODEX_VERSION__}`;
    process.stdout.write(renderSkill(runner));
    return EXIT_OK;
  }
  const available = topics();
  if (!available.includes(topic)) {
    const list = ["skill", ...available].join(", ");
    process.stderr.write(`No guide named ${topic}. Topics: ${list}\n`);
    return EXIT_TOOL_FAILED;
  }
  process.stdout.write(readFileSync(assetPath("docs", `${topic}.md`), "utf8"));
  return EXIT_OK;
}
