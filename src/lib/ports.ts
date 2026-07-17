import net from "node:net";
import { listDeployments } from "./state.js";

/** Ports already claimed by existing deployments. */
function reservedPorts(): Set<number> {
    return new Set(listDeployments().map((d) => d.localPort));
}

/** Check whether a TCP port is free to bind on localhost. */
function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
            server.close(() => resolve(true));
        });
        server.listen(port, "127.0.0.1");
    });
}

/**
 * Allocate a local port for a new deployment, starting at `base` and skipping
 * ports reserved by other deployments or currently bound.
 */
export async function allocateLocalPort(base: number): Promise<number> {
    const reserved = reservedPorts();
    for (let port = base; port < base + 1000; port++) {
        if (reserved.has(port)) continue;
        if (await isPortFree(port)) return port;
    }
    throw new Error(`Could not find a free local port near ${base}.`);
}
