import { openSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { execa } from "execa";
import { deploymentDir } from "./paths.js";
import type { AwsSelection } from "./config.js";
import type { DeploymentState } from "./state.js";
import { LlmrunError } from "./errors.js";

/**
 * SSM-based access to instances. We shell out to the `aws` CLI here (rather than
 * the SDK) because interactive Session Manager streams — port forwarding, shells,
 * and log tails — are handled by the CLI's bundled session-manager-plugin.
 *
 * Note on process shape: `aws ssm start-session` spawns session-manager-plugin as a
 * child in its own process group. The plugin (not the `aws` parent) owns the local
 * port and the SSM session, and it outlives the parent — so forwarders are always
 * managed by process group, never by the parent pid alone.
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

/** Send a signal to a pid (or a whole process group via a negative pid), ignoring "already gone". */
function signal(target: number, s: NodeJS.Signals): void {
    try {
        process.kill(target, s);
    } catch {
        // process or group already gone
    }
}

/** The command line for a pid, or "" when the process no longer exists. */
function commandOf(pid: number): string {
    try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
}

/** True when a live process in the group whose pgid equals `gid` is our SSM forward family. */
function groupIsSsmForward(gid: number): boolean {
    let out: string;
    try {
        out = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
    } catch {
        return false;
    }
    return out.split("\n").some((line) => {
        if (!line.includes("session-manager-plugin") && !line.includes("ssm start-session")) return false;
        const m = line.match(/^\s*\d+\s+(\d+)/);

        return m !== null && Number(m[1]) === gid;
    });
}

/**
 * True when a recorded forward pid is still around — either as the `aws` parent
 * itself or as the group its session-manager-plugin child still belongs to (the
 * parent can exit while the child keeps serving the port).
 */
export function isForwardAlive(pid: number | undefined): boolean {
    if (!pid) return false;
    if (isProcessAlive(pid)) return true;

    return groupIsSsmForward(pid);
}

/**
 * Tear down a port-forward. Kills the recorded pid's whole process group so the
 * session-manager-plugin child (the actual port/session owner) cannot be orphaned;
 * only does so when the group is verifiably our SSM forward, to protect against
 * a reused pid naming an unrelated group.
 */
export function stopPortForward(pid: number | undefined): void {
    if (!pid) return;
    if (commandOf(pid).includes("ssm start-session") || groupIsSsmForward(pid)) {
        signal(-pid, "SIGTERM");
    } else if (isProcessAlive(pid)) {
        signal(pid, "SIGTERM");
    }
}

/** Pids of the processes currently listening on a local TCP port. */
function listenersOnPort(port: number): number[] {
    try {
        const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();

        return out
            .split(/\s+/)
            .filter(Boolean)
            .map((s) => Number(s));
    } catch {
        return [];
    }
}

/** Kill whatever is listening on the local port (e.g. an orphaned forward from a previous run). */
export function clearPortListeners(port: number): void {
    for (const pid of listenersOnPort(port)) {
        signal(pid, "SIGTERM");
    }
}

/** Resolve true once nothing is listening on the local port. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && listenersOnPort(port).length > 0) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return listenersOnPort(port).length === 0;
}

/** True when `pid` is a member of the process group led by `group` (or is the leader itself). */
function inSameProcessGroup(pid: number, group: number): boolean {
    if (pid === group) return true;
    try {
        const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());

        return pgid === group;
    } catch {
        return false;
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
 * Establish a port-forward and confirm it is actually the forward that is listening,
 * retrying a few times. The session-manager-plugin only opens the local port once the
 * SSM session connects, but a stale listener (an orphaned forward from a previous run)
 * can make a naive "port is listening" check succeed while our forward fails to bind.
 * Requires the instance to already be SSM-registered (see waitForSsmOnline).
 */
export async function establishPortForward(sel: AwsSelection, state: DeploymentState, attempts = 3): Promise<number> {
    for (let i = 1; i <= attempts; i++) {
        // Clear any stale listener on our port before binding; a leftover orphan
        // would otherwise absorb the bind attempt and keep serving a dead tunnel.
        clearPortListeners(state.localPort);
        await waitForPortFree(state.localPort, 3_000);

        const pid = startPortForward(sel, state);
        const listening = await waitForLocalPort(state.localPort, 15_000);

        if (listening) {
            // The port is open — but is it our forward? A listener outside our process
            // group means our plugin could not bind (EADDRINUSE) and exited.
            const ownedByUs = listenersOnPort(state.localPort).some((p) => inSameProcessGroup(p, pid));

            if (ownedByUs) return pid;
        }
        stopPortForward(pid);
    }

    throw new LlmrunError(
        `Could not establish a port-forward to localhost:${state.localPort} — the port appears to be held by another process.`,
        `Check ${path.join(deploymentDir(state.name), "forward.log")}, then retry with \`llmrun connect ${state.name}\`.`
    );
}

/**
 * Port-forward processes that are orphans: their process group is not a live
 * deployment's recorded forward. The plugin outlives its `aws` parent, so dead
 * forwards can linger on the machine for days — holding a local port and answering
 * connections with nothing. Returns the orphan pids (with their local ports).
 */
export function findOrphanedPortForwards(trackedGroups: number[]): { pid: number; port?: number }[] {
    let out: string;
    try {
        out = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
    } catch {
        return [];
    }

    const orphans: { pid: number; port?: number }[] = [];

    for (const line of out.split("\n")) {
        if (!line.includes("session-manager-plugin") || !line.includes("AWS-StartPortForwardingSession")) continue;
        const m = line.match(/^\s*(\d+)\s+(\d+)/);

        if (!m) continue;
        const pid = Number(m[1]);
        const pgid = Number(m[2]);

        if (trackedGroups.includes(pgid) || trackedGroups.includes(pid)) continue;
        const portMatch = line.match(/localPortNumber":\s*\["?(\d+)/);
        orphans.push({ pid, port: portMatch ? Number(portMatch[1]) : undefined });
    }

    return orphans;
}

/** Kill all orphaned port-forward processes; returns what was killed. */
export function killOrphanedPortForwards(trackedGroups: number[]): { pid: number; port?: number }[] {
    const orphans = findOrphanedPortForwards(trackedGroups);
    for (const o of orphans) signal(o.pid, "SIGTERM");
    return orphans;
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
