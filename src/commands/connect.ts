import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { listDeployments, loadDeployment, updateDeployment, type DeploymentState } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { describeInstance, waitForSsmOnline } from "../lib/aws.js";
import { establishPortForward, stopPortForward, isProcessAlive } from "../lib/ssm.js";
import { warn, success, info, dim } from "../lib/ui.js";

export interface ConnectOptions {
    all?: boolean;
}

async function connectOne(state: DeploymentState, flags: GlobalFlags): Promise<void> {
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        warn(`"${state.name}" has no instance — skipping.`);
        return;
    }
    const inst = await describeInstance(sel, state.instanceId).catch(() => undefined);

    if (inst && inst.state !== "running") {
        warn(`"${state.name}" is ${inst.state} — run \`llmrun start ${state.name}\` first. Skipping.`);
        return;
    }

    // Restart the forward if a stale one is recorded.
    if (isProcessAlive(state.forwardPid)) {
        stopPortForward(state.forwardPid);
    }

    if (!(await waitForSsmOnline(sel, state.instanceId, 60_000))) {
        warn(`"${state.name}" is not registered with SSM yet — try again shortly. Skipping.`);
        return;
    }
    const pid = await establishPortForward(sel, state);
    updateDeployment(state.name, { forwardPid: pid });
    success(`"${state.name}" → ${dim(`http://localhost:${state.localPort}/v1`)}`);
}

/** (Re)establish SSM port-forward(s). Multiple deployments forward concurrently. */
export async function connectCommand(
    flags: GlobalFlags,
    nameArg: string | undefined,
    opts: ConnectOptions
): Promise<void> {
    if (opts.all) {
        const deployments = listDeployments();

        if (deployments.length === 0) {
            info("No deployments to connect.");
            return;
        }
        for (const d of deployments) {
            await connectOne(d, flags);
        }
        return;
    }

    const name = await resolveDeploymentName(nameArg);
    await connectOne(loadDeployment(name), flags);
}
