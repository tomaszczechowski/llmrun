import { spawn } from "node:child_process";
import { loadGlobalConfig, resolveAws } from "../lib/config.js";
import type { GlobalFlags } from "../lib/context.js";
import { startStudioServer } from "../studio/server.js";
import { heading, info, dim, cyan } from "../lib/ui.js";

export interface StudioOptions {
    port?: number;
    /** Commander sets this to false for `--no-browser`. */
    browser?: boolean;
}

const DEFAULT_STUDIO_PORT = 4173;

function openBrowser(url: string): void {
    const [bin, args] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.unref();
}

/** Start the local dashboard bridge and keep the process alive until Ctrl-C. */
export async function studioCommand(flags: GlobalFlags, opts: StudioOptions): Promise<void> {
    const global = loadGlobalConfig();
    const sel = resolveAws(flags, undefined, global);
    const port = opts.port ?? global.studio_port ?? DEFAULT_STUDIO_PORT;

    const handle = await startStudioServer({ port, flags: sel });

    const url = `http://127.0.0.1:${handle.port}/`;
    heading("llmrun studio");
    info(`Dashboard: ${cyan(url)}`);

    if (opts.browser !== false) {
        try {
            openBrowser(url);
        } catch {
            info(`No browser opened — visit ${url} manually.`);
        }
    }

    info(dim("Press Ctrl-C to stop. Deployments, metrics, and logs refresh automatically."));

    await new Promise<void>((resolve) => {
        const shutdown = () => {
            void handle.close().then(resolve);
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
}
