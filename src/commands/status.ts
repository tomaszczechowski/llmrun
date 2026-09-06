import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { listDeployments, updateDeployment } from "../lib/state.js";
import { describeInstance } from "../lib/aws.js";
import { isProcessAlive } from "../lib/ssm.js";
import { flushInstanceUsage, reconcileLifecycle } from "../lib/history.js";
import { estimateCost, formatUsd } from "../lib/instances.js";
import { heading, table, info } from "../lib/ui.js";

/** How stale a last flush can be before `llmrun ls` re-pulls usage. */
const FLUSH_STALE_MS = 5 * 60 * 1000;

/** List all deployments with their live state, local URL, and connection status. */
export async function statusCommand(flags: GlobalFlags): Promise<void> {
    const deployments = listDeployments();

    if (deployments.length === 0) {
        info("No deployments. Create one with `llmrun up`.");
        return;
    }

    // Fetch live instance state for all deployments in parallel.
    const live = await Promise.all(
        deployments.map(async (d) => {
            if (!d.instanceId) return undefined;

            try {
                return await describeInstance(selectionForDeployment(d, flags), d.instanceId);
            } catch {
                return undefined;
            }
        })
    );

    // Reconcile the ledger with EC2 ground truth (records started/stopped windows).
    await Promise.all(
        deployments.map((d, i) =>
            d.instanceId && d.deploymentId
                ? reconcileLifecycle(selectionForDeployment(d, flags), d, live[i]).catch(() => {
                      // Best-effort — the next lifecycle command reconciles.
                  })
                : Promise.resolve()
        )
    );

    // Best-effort usage flush for running deployments that haven't been pulled recently.
    const staleCutoff = Date.now() - FLUSH_STALE_MS;
    await Promise.all(
        deployments.map((d, i) => {
            if (!d.instanceId || !d.deploymentId || live[i]?.state !== "running") return Promise.resolve();
            if (d.lastFlushAt && Date.parse(d.lastFlushAt) > staleCutoff) return Promise.resolve();

            return flushInstanceUsage(selectionForDeployment(d, flags), d.instanceId, d.deploymentId)
                .then(() => {
                    updateDeployment(d.name, { lastFlushAt: new Date().toISOString() });
                })
                .catch(() => {
                    // Transient SSM/EC2 error — the next pass retries.
                });
        })
    );

    const rows = deployments.map((d, i) => {
        const cost = estimateCost(d.instanceType);
        const connected = isProcessAlive(d.forwardPid) ? "yes" : "no";
        const state = !d.instanceId ? (d.provisioningAt ? "provisioning" : "no-instance") : (live[i]?.state ?? "unknown");

        return [
            d.name,
            d.alias,
            state,
            d.instanceType,
            `localhost:${d.localPort}`,
            connected,
            cost ? `~${formatUsd(cost.usdPerHour)}/hr` : "—",
        ];
    });

    heading("Deployments");
    table(["NAME", "MODEL", "STATE", "INSTANCE", "LOCAL", "FWD", "COST"], rows);

    info("Endpoints are http://localhost:<LOCAL>/v1 while FWD=yes. Costs approximate.");
}
