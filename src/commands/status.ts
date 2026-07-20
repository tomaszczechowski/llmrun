import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { listDeployments } from "../lib/state.js";
import { describeInstance } from "../lib/aws.js";
import { isProcessAlive } from "../lib/ssm.js";
import { estimateCost, formatUsd } from "../lib/instances.js";
import { heading, table, info, dim } from "../lib/ui.js";

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
            if (!d.instanceId) return "no-instance";

            try {
                const info = await describeInstance(selectionForDeployment(d, flags), d.instanceId);

                return info?.state ?? "unknown";
            } catch {
                return "unknown";
            }
        })
    );

    const rows = deployments.map((d, i) => {
        const cost = estimateCost(d.instanceType);
        const connected = isProcessAlive(d.forwardPid) ? "yes" : "no";

        return [
            d.name,
            d.alias,
            String(live[i]),
            d.instanceType,
            `localhost:${d.localPort}`,
            connected,
            cost ? `~${formatUsd(cost.usdPerHour)}/hr` : "—",
        ];
    });

    heading("Deployments");
    table(["NAME", "MODEL", "STATE", "INSTANCE", "LOCAL", "FWD", "COST"], rows);

    console.log("\n" + dim("Endpoints are http://localhost:<LOCAL>/v1 while FWD=yes. Costs approximate."));
}
