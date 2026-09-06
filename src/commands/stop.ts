import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment, updateDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { stopInstance, waitForInstanceState } from "../lib/aws.js";
import { stopPortForward } from "../lib/ssm.js";
import { flushInstanceUsage, reconcileLifecycle } from "../lib/history.js";
import { LlmrunError } from "../lib/errors.js";
import { info, success, spinner } from "../lib/ui.js";

export interface StopOptions {
    wait?: boolean;
}

/** Stop a deployment's instance (EBS + model cache persist for a fast start). */
export async function stopCommand(flags: GlobalFlags, nameArg: string | undefined, opts: StopOptions): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        throw new LlmrunError(`Deployment "${name}" has no instance to stop.`);
    }

    // Tear down the local port-forward first.
    stopPortForward(state.forwardPid);
    updateDeployment(name, { forwardPid: undefined });

    // Pull the staged usage buffer while SSM is still reachable.
    if (state.deploymentId) {
        try {
            await flushInstanceUsage(sel, state.instanceId, state.deploymentId);
            updateDeployment(name, { lastFlushAt: new Date().toISOString() });
        } catch {
            // SSM blip — the buffer persists on the instance's disk until `down`.
        }
    }

    await stopInstance(sel, state.instanceId);
    info(`Stopping ${state.instanceId}…`);

    if (opts.wait) {
        const spin = spinner("Waiting for the instance to stop");
        await waitForInstanceState(sel, state.instanceId, ["stopped"]);
        spin.succeed("Instance stopped");
    }

    // Close the running window in the ledger (also records session totals).
    await reconcileLifecycle(sel, state).catch(() => {
        // Best-effort — the next llmrun ls/down reconciles.
    });
    success(`Deployment "${name}" stopped. Start it again with \`llmrun start ${name}\`.`);
}
