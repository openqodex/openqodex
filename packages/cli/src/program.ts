import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { OpenQodexError } from "@openqodex/core";
import { EXIT_TOOL_FAILED } from "./exit-codes.js";
import { noteInternalError, offer, takePending } from "./feedback.js";

type CommandModule = { run: (args: string[]) => Promise<number> };

// Each command is loaded only when it runs, so startup stays fast. `--help`
// shows the four a person uses; the hidden ones stay callable: hooks, the
// skill, the Action and pre-commit call them (docs/plumbing.md). `scan` is
// what plain `review` does, kept by its own name for released hooks.
const commands: Record<string, { summary: string; hidden?: true; load: () => Promise<CommandModule> }> = {
  init: { summary: "Install OpenQodex into your coding agent", load: () => import("./commands/init.js") },
  review: { summary: "Review the current change", load: () => import("./commands/review.js") },
  update: { summary: "Update OpenQodex now, roll back, or turn updates off", load: () => import("./commands/update.js") },
  trust: { summary: "Approve a custom scanner from .openqodex.yaml", load: () => import("./commands/trust.js") },
  scan: { summary: "Run the scanners on the current change", hidden: true, load: () => import("./commands/scan.js") },
  doctor: { summary: "Show which scanners are installed", hidden: true, load: () => import("./commands/doctor.js") },
  hook: { summary: "Run as a git hook", hidden: true, load: () => import("./commands/hook.js") },
  guide: { summary: "Print the docs", hidden: true, load: () => import("./commands/guide.js") },
  demo: { summary: "Build the demo repo with planted bugs", hidden: true, load: () => import("./commands/demo.js") },
  report: { summary: "Report a problem with OpenQodex as a GitHub issue", hidden: true, load: () => import("./commands/report.js") },
};

// The hook check must stay silent, and report shows its own offer.
const NO_OFFER = new Set(["hook", "report"]);

function cwdOf(args: string[]): string {
  const i = args.findIndex((a) => a === "--cwd" || a.startsWith("--cwd="));
  const value = i === -1 ? undefined : args[i].startsWith("--cwd=") ? args[i].slice(6) : args[i + 1];
  return resolve(value ?? process.cwd());
}

// An input or usage problem prints its one line. Anything else is a bug in
// OpenQodex: one line, with the stack only under --verbose.
function reportError(error: unknown, command: string, args: string[]): number {
  if (error instanceof OpenQodexError) {
    process.stderr.write(`openqodex: ${error.message}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`openqodex failed: ${message}\n`);
    if (args.includes("--verbose") && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    noteInternalError(command, args, error);
  }
  return EXIT_TOOL_FAILED;
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command("openqodex")
    .description("Open source code review that runs inside your coding agent, before you push.")
    .version(__OPENQODEX_VERSION__, "-v, --version", "Print the version")
    .exitOverride();

  for (const [name, entry] of Object.entries(commands)) {
    program
      .command(name, { hidden: entry.hidden === true })
      .description(entry.summary)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(async (_options: unknown, command: Command) => {
        let threw = false;
        try {
          const mod = await entry.load();
          process.exitCode = await mod.run(command.args);
        } catch (error) {
          threw = true;
          process.exitCode = reportError(error, name, command.args);
        }
        // At most one offer per run, after the command's own output.
        const problem = takePending();
        if (problem !== null && !NO_OFFER.has(name)) await offer(problem, name, command.args, cwdOf(command.args));
        // Last: the update notices on stderr and, after a review, scan or
        // hook run through the launcher, the detached daily check. Not after
        // a command that stopped on an error, such as a flag that did not parse.
        if (!threw) {
          const { afterCommand } = await import("./update/trigger.js");
          afterCommand(name, command.args);
        }
      });
  }

  // Hidden: one scanner install, run as a detached process by the toolchain
  // so it keeps going after the command that started it exits.
  program
    .command("__install <tool>", { hidden: true })
    .action(async (tool: string) => {
      const { ADAPTERS, IN_PROCESS, runInstallWorker } = await import("@openqodex/scanners");
      // Only a name from the toolchain reaches the worker: the name becomes a
      // folder under the home folder.
      const known = new Set<string>(["uv", ...ADAPTERS.map((a) => a.source).filter((s) => !IN_PROCESS.has(s))]);
      if (!known.has(tool)) {
        process.stderr.write(`openqodex: unknown tool: ${tool}\n`);
        process.exitCode = EXIT_TOOL_FAILED;
        return;
      }
      process.exitCode = (await runInstallWorker(tool)) === 0 ? 0 : EXIT_TOOL_FAILED;
    });

  // Hidden: the update worker, run as a detached process after a command.
  // It ends by itself; the exit is explicit so no open socket keeps it.
  program.command("__update", { hidden: true }).action(async () => {
    const { runUpdateWorker } = await import("./update/worker.js");
    // It never waits for the commit boundary: when another process holds
    // it, this worker gives up and the next daily check tries again.
    const result = await runUpdateWorker({ anyAge: false, daily: true, wait: 0 });
    process.exit(result.outcome === "failed" ? EXIT_TOOL_FAILED : 0);
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version exit 0; every usage error is a tool failure.
      process.exit(error.exitCode === 0 ? 0 : EXIT_TOOL_FAILED);
    }
    throw error;
  }
}
