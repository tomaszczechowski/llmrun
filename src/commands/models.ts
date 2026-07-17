import { loadCatalogContext, type GlobalFlags } from "../lib/context.js";
import { estimateCost, formatUsd, getInstanceSpec } from "../lib/instances.js";
import { idleTimeoutFor } from "../lib/catalog.js";
import { heading, table, dim, info } from "../lib/ui.js";

/** List the models available in the merged catalog with their instance + cost. */
export async function modelsCommand(flags: GlobalFlags): Promise<void> {
    const { catalog, sources } = loadCatalogContext(flags);

    heading("Models");
    if (catalog.models.length === 0) {
        info("No models defined. Add some to your llmrun.yaml.");
        return;
    }

    const rows = catalog.models.map((m) => {
        const spec = getInstanceSpec(m.instance_type);
        const cost = estimateCost(m.instance_type);
        const gpu = spec ? (spec.gpus > 0 ? `${spec.gpus}×${spec.gpuType}` : "CPU") : "—";
        const price = cost ? `~${formatUsd(cost.usdPerHour)}/hr` : "unknown";

        return [m.alias, m.hf_repo, m.instance_type, gpu, price, idleTimeoutFor(catalog, m)];
    });

    table(["ALIAS", "HF REPO", "INSTANCE", "GPU", "EST. COST", "IDLE"], rows);
    console.log("\n" + dim(`Catalog sources: ${sources.join(", ")}`));
    console.log(dim("Costs are approximate (us-east-1 on-demand)."));
}
