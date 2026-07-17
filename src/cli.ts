#!/usr/bin/env node
import { Command } from "commander";
import { LlmrunError } from "./lib/errors.js";
import { error, dim } from "./lib/ui.js";
import type { GlobalFlags } from "./lib/context.js";

import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { modelsCommand } from "./commands/models.js";
import { upCommand } from "./commands/up.js";
import { stopCommand } from "./commands/stop.js";
import { startCommand } from "./commands/start.js";
import { downCommand } from "./commands/down.js";
import { statusCommand } from "./commands/status.js";
import { connectCommand } from "./commands/connect.js";
import { disconnectCommand } from "./commands/disconnect.js";
import { sshCommand } from "./commands/ssh.js";
import { logsCommand } from "./commands/logs.js";
import { configCommand } from "./commands/config.js";

const program = new Command();

program
    .name("llmrun")
    .description("Run open-source LLMs on AWS EC2 — pick a model, get a local OpenAI-compatible endpoint.")
    .version("0.1.0")
    .option("--profile <name>", "AWS profile to use (overrides env/yaml/global config)")
    .option("--region <region>", "AWS region to use (overrides env/yaml/global config)");

/** Merge global options (from the root command) into a typed GlobalFlags object. */
function globals(cmd: Command): GlobalFlags {
    const opts = cmd.optsWithGlobals();

    return { profile: opts.profile, region: opts.region };
}

program
    .command("init")
    .description("Scaffold an editable llmrun.yaml in the current folder")
    .option("-f, --force", "overwrite an existing llmrun.yaml")
    .action(async (opts, cmd) => {
        void globals(cmd);
        await initCommand({ force: opts.force });
    });

program
    .command("doctor")
    .description("Check prerequisites (terraform, aws, SSM plugin, credentials, region)")
    .action(async (_opts, cmd) => {
        await doctorCommand(globals(cmd));
    });

program
    .command("models")
    .alias("catalog")
    .description("List models from the merged catalog with instance type and cost")
    .action(async (_opts, cmd) => {
        await modelsCommand(globals(cmd));
    });

program
    .command("up")
    .description("Pick a model, preview cost, provision, and connect a local endpoint")
    .option("--name <instance>", "name for this deployment (defaults to the model alias)")
    .option("--port <port>", "local port to forward to (defaults to catalog base_port)", (v) => parseInt(v, 10))
    .option("-y, --yes", "skip the cost confirmation prompt")
    .action(async (opts, cmd) => {
        await upCommand(globals(cmd), { name: opts.name, port: opts.port, yes: opts.yes });
    });

program
    .command("stop [name]")
    .description("Stop a deployment's instance (keeps disk + model cache)")
    .option("-w, --wait", "wait until the instance is fully stopped")
    .action(async (name, opts, cmd) => {
        await stopCommand(globals(cmd), name, { wait: opts.wait });
    });

program
    .command("start [name]")
    .description("Restart a stopped deployment and re-forward its endpoint")
    .action(async (name, _opts, cmd) => {
        await startCommand(globals(cmd), name);
    });

program
    .command("down [name]")
    .description("Destroy a deployment (terraform destroy)")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (name, opts, cmd) => {
        await downCommand(globals(cmd), name, { yes: opts.yes });
    });

program
    .command("ls")
    .aliases(["status", "list"])
    .description("List deployments with state, local URL, and connection status")
    .action(async (_opts, cmd) => {
        await statusCommand(globals(cmd));
    });

program
    .command("connect [name]")
    .description("(Re)establish SSM port-forward(s) to local port(s)")
    .option("-a, --all", "connect every running deployment")
    .action(async (name, opts, cmd) => {
        await connectCommand(globals(cmd), name, { all: opts.all });
    });

program
    .command("disconnect [name]")
    .description("Tear down local port-forward(s) without stopping the instance")
    .option("-a, --all", "disconnect every deployment")
    .action(async (name, opts, cmd) => {
        await disconnectCommand(globals(cmd), name, { all: opts.all });
    });

program
    .command("ssh [name]")
    .description("Open an SSM shell on a deployment's instance")
    .action(async (name, _opts, cmd) => {
        await sshCommand(globals(cmd), name);
    });

program
    .command("logs [name]")
    .description("Tail the model server's logs over SSM")
    .action(async (name, _opts, cmd) => {
        await logsCommand(globals(cmd), name);
    });

program
    .command("config")
    .description("Show or edit global config (~/.llmrun/config.json)")
    .option("--set <key=value...>", "set a config value (profile, region, base_port, idle_timeout)")
    .action(async (opts, cmd) => {
        await configCommand(globals(cmd), { set: opts.set });
    });

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (err) {
        // Inquirer throws this when the user Ctrl-C's a prompt.
        if (err instanceof Error && err.name === "ExitPromptError") {
            console.log("\nAborted.");
            process.exit(130);
        }
        if (err instanceof LlmrunError) {
            error(err.message);
            if (err.hint) console.error(dim("  " + err.hint));
            process.exit(1);
        }
        error((err as Error).message ?? String(err));
        process.exit(1);
    }
}

void main();
