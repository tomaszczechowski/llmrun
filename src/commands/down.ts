import { confirm } from "@inquirer/prompts";
import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment, removeDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { stopPortForward } from "../lib/ssm.js";
import * as tf from "../lib/terraform.js";
import { info, success } from "../lib/ui.js";

export interface DownOptions {
    yes?: boolean;
}

/** Tear a deployment down entirely (`terraform destroy`) and remove its workspace. */
export async function downCommand(flags: GlobalFlags, nameArg: string | undefined, opts: DownOptions): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!opts.yes) {
        const ok = await confirm({
            message: `Destroy deployment "${name}" (${state.instanceType}, ${state.hf_repo})? This deletes the instance and its disk.`,
            default: false,
        });

        if (!ok) {
            info("Aborted. Nothing was destroyed.");
            return;
        }
    }

    stopPortForward(state.forwardPid);

    info("Running terraform destroy…");
    await tf.destroy(name, sel);

    removeDeployment(name);
    success(`Deployment "${name}" destroyed.`);
}
