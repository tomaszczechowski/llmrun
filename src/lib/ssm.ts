import { openSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { execa } from "execa";
import { deploymentDir } from "./paths.js";
import type { AwsSelection } from "./config.js";
import type { DeploymentState } from "./state.js";
import { LlmrunError } from "./errors.js";

/**
 * SSM-based access to instances. We shell out to the `aws` CLI here (rather than
 * the SDK) because interactive Session Manager streams — port forwarding, shells,
 * and log tails — are handled by the CLI's bundled session-manager-plugin.
 */

/** Global AWS CLI flags derived from the resolved selection. */
function awsFlags(sel: AwsSelection): string[] {
    const flags: string[] = [];

    if (sel.region) flags.push("--region", sel.region);
    if (sel.profile) flags.push("--profile", sel.profile);

    return flags;
}

/** Start a background SSM port-forward. Returns the detached child PID. */
export function startPortForward(sel: AwsSelection, state: DeploymentState): number {
    if (!state.instanceId) {
        throw new LlmrunError(`Deployment "${state.name}" has no instance id yet.`);
    }
    const logFile = openSync(path.join(deploymentDir(state.name), "forward.log"), "a");
    const child = spawn(
        "aws",
        [
            "ssm",
            "start-session",
            "--target",
            state.instanceId,
            "--document-name",
            "AWS-StartPortForwardingSession",
            "--parameters",
            `portNumber=${state.remotePort},localPortNumber=${state.localPort}`,
            ...awsFlags(sel),
        ],
        {
            detached: true,
            stdio: ["ignore", logFile, logFile],
        }
    );
    child.unref();
    if (child.pid === undefined) {
        throw new LlmrunError("Failed to start SSM port-forward process.");
    }

    return child.pid;
}

export function isProcessAlive(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function stopPortForward(pid: number | undefined): void {
    if (!pid || !isProcessAlive(pid)) return;
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // already gone
    }
}

/** Resolve true once something is listening on the local port. */
function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
        const attempt = () => {
            const socket = net.connect({ port, host: "127.0.0.1" });
            socket.once("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.once("error", () => {
                socket.destroy();

                if (Date.now() >= deadline) resolve(false);
                else setTimeout(attempt, 500);
            });
        };

        attempt();
    });
}

/**
 * Establish a port-forward and confirm it is actually listening, retrying a few
 * times. The session-manager-plugin only opens the local port once the SSM
 * session connects, so a live local port means the tunnel is up. Requires the
 * instance to already be SSM-registered (see waitForSsmOnline).
 */
export async function establishPortForward(sel: AwsSelection, state: DeploymentState, attempts = 3): Promise<number> {
    for (let i = 1; i <= attempts; i++) {
        const pid = startPortForward(sel, state);
        const listening = await waitForLocalPort(state.localPort, 15_000);

        if (listening) return pid;
        stopPortForward(pid);
    }

    throw new LlmrunError(
        `Could not establish a port-forward to localhost:${state.localPort}.`,
        `Check ${path.join(deploymentDir(state.name), "forward.log")}, then retry with \`llmrun connect ${state.name}\`.`
    );
}

/** Open an interactive SSM shell on the instance (inherits the terminal). */
export async function openShell(sel: AwsSelection, instanceId: string): Promise<void> {
    await execa("aws", ["ssm", "start-session", "--target", instanceId, ...awsFlags(sel)], {
        stdio: "inherit",
        reject: false,
    });
}

/**
 * Spawn a non-interactive SSM command session whose output is piped (rather
 * than attached to the terminal), for streaming to an API client. The caller
 * owns the child: read its stdout/stderr and kill it when done.
 */
export function spawnCommandStream(sel: AwsSelection, instanceId: string, command: string): ChildProcess {
    return spawn(
        "aws",
        [
            "ssm",
            "start-session",
            "--target",
            instanceId,
            "--document-name",
            "AWS-StartInteractiveCommand",
            "--parameters",
            `command=${command}`,
            ...awsFlags(sel),
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
    );
}

/** Tail a systemd unit's logs over an interactive SSM command session. */
export async function tailUnitLogs(sel: AwsSelection, instanceId: string, unit: string): Promise<void> {
    await execa(
        "aws",
        [
            "ssm",
            "start-session",
            "--target",
            instanceId,
            "--document-name",
            "AWS-StartInteractiveCommand",
            "--parameters",
            `command=sudo journalctl -u ${unit} -f -n 200`,
            ...awsFlags(sel),
        ],
        { stdio: "inherit", reject: false }
    );
}
