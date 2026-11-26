import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { OpenQodexError } from "@openqodex/core";
import { EXIT_TOOL_FAILED } from "./exit-codes.js";
import { noteInternalError, offer, takePending } from "./feedback.js";
import { begin, dispatch, recordCommand } from "./telemetry/dispatch.js";

type CommandModule = { run: (args: string[]) => Promise<number> };

// Each command is loaded only when it runs, so startup stays fast. `--help`
// shows the five a person uses (init, review, update, trust, graph); the hidden ones stay callable: hooks, the
// skill, the Action and pre-commit call them (docs/plumbing.md). `scan` is
// what plain `review` does, kept by its own name for released hooks.
const commands: Record<string, { summary: string; usage?: string; hidden?: true; load: () => Promise<CommandModule> }> = {
  init: { summary: "Install OpenQodex into your coding agent", load: () => import("./commands/init.js") },
  review: {
    summary: "Review the current change, or a branch or pull request",
    usage: "[--agent] [<branch> | #<pr> | <pr link>] [--base <ref>] [options], or --finalize [--run <id> | <path>], or --all",
    load: () => import("./commands/review.js"),
  },
  update: { summary: "Update OpenQodex now, roll back, or turn updates off", load: () => import("./commands/update.js") },
  trust: { summary: "Approve a custom scanner from .openqodex/config.yaml", load: () => import("./commands/trust.js") },
  scan: { summary: "Run the scanners on the current change", hidden: true, load: () => import("./commands/scan.js") },
  doctor: { summary: "Show which scanners are installed", hidden: true, load: () => import("./commands/doctor.js") },
  hook: { summary: "Run as a git hook", hidden: true, load: () => import("./commands/hook.js") },
  guide: { summary: "Print the docs", hidden: true, load: () => import("./commands/guide.js") },
  findings: { summary: "Print the named findings of the last review in full", usage: "<numbers | all>", hidden: true, load: () => import("./commands/findings.js") },
  demo: { summary: "Build the demo repo with planted bugs", hidden: true, load: () => import("./commands/demo.js") },
  report: { summary: "Report a problem with OpenQodex as a GitHub issue", hidden: true, load: () => import("./commands/report.js") },
  config: { summary: "Rewrite the repo config for this version", usage: "migrate [--write]", hidden: true, load: () => import("./commands/config.js") },
  graph: {
    summary: "Ask the code graph: who calls this, what it calls, implementers, tests, paths, what a change reaches",
    usage: "<question> [<target>] [--json]; `openqodex graph help` lists the questions",
    load: () => import("./commands/graph.js"),
  },
  // The code graph's tools for an agent, over stdio: `init` registers it
  // with each agent, which starts it; a person never runs it by hand.
  mcp: { summary: "Serve the code graph's questions to an agent as MCP tools, over stdio", usage: "[--repo <dir>]", hidden: true, load: () => import("./commands/mcp.js") },
};

// The hook check must stay silent, report shows its own offer, and the MCP
// server has no terminal: its standard output is the protocol.
const NO_OFFER = new Set(["hook", "report", "mcp"]);

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
    .description("Open source AI code review for Claude Code and Codex, before you push.")
    .version(__OPENQODEX_VERSION__, "-v, --version", "Print the version")
    .exitOverride();

  for (const [name, entry] of Object.entries(commands)) {
    const command = program.command(name, { hidden: entry.hidden === true });
    if (entry.usage !== undefined) command.usage(entry.usage);
    command
      .description(entry.summary)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(async (_options: unknown, command: Command) => {
        begin(name, command.args);
        let threw = false;
        let caught: unknown;
        try {
          const mod = await entry.load();
          process.exitCode = await mod.run(command.args);
        } catch (error) {
          threw = true;
          caught = error;
          process.exitCode = reportError(error, name, command.args);
        }
        // The usage data of this command leaves now, before the feedback
        // question, so the question is not in its duration and closing the
        // terminal during it loses nothing.
        try {
          recordCommand({ exitCode: Number(process.exitCode ?? 0), error: caught, threw, interrupted: false });
          dispatch();
        } catch {
          // never a reason to fail
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

  // Hidden: the usage data worker, run as a detached process by a command
  // with its events. It ends by itself; the exit is explicit so no open
  // socket keeps it.
  program.command("__telemetry", { hidden: true }).action(async () => {
    const { runTelemetryWorker } = await import("./telemetry/worker.js");
    await runTelemetryWorker();
    process.exit(0);
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
