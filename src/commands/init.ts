import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { templatesDir } from "../lib/paths.js";
import { LlmrunError } from "../lib/errors.js";
import { success, info, dim } from "../lib/ui.js";

export interface InitOptions {
    force?: boolean;
}

/** Scaffold an editable `llmrun.yaml` into the current directory. */
export async function initCommand(opts: InitOptions): Promise<void> {
    const target = path.join(process.cwd(), "llmrun.yaml");

    if (existsSync(target) && !opts.force) {
        throw new LlmrunError(`llmrun.yaml already exists in ${process.cwd()}.`, "Pass --force to overwrite it.");
    }
    copyFileSync(path.join(templatesDir(), "llmrun.yaml"), target);
    success(`Created ${dim(target)}`);
    info("Edit it to set your AWS profile/region and the models you want, then run `llmrun up`.");
}
