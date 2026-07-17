import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { tailUnitLogs } from "../lib/ssm.js";
import { LlmrunError } from "../lib/errors.js";
import { info } from "../lib/ui.js";

/** Tail the model server's logs over SSM. */
export async function logsCommand(flags: GlobalFlags, nameArg: string | undefined): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        throw new LlmrunError(`Deployment "${name}" has no instance.`);
    }

    info(`Tailing logs for ${state.instanceId} (Ctrl-C to stop)…`);
    await tailUnitLogs(sel, state.instanceId, "llmrun-server");
}
