export function fmtInt(n: number | null | undefined): string {
    if (n === null || n === undefined) return "—";

    return Math.round(n).toLocaleString();
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
    if (n === null || n === undefined) return "—";

    return `$${n.toFixed(digits)}`;
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
    if (n === null || n === undefined) return "—";

    return n.toFixed(digits);
}

export function fmtDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !isFinite(seconds) || seconds < 0) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;

    return `${s}s`;
}

export function stateBadgeClass(state: string): string {
    switch (state) {
        case "running":
            return "bg-emerald-500/15 text-emerald-400";
        case "stopped":
            return "bg-amber-500/15 text-amber-400";
        case "pending":
        case "stopping":
        case "provisioning":
            return "bg-sky-500/15 text-sky-400";
        case "no-instance":
        case "terminated":
            return "bg-red-500/15 text-red-400";
        default:
            return "bg-zinc-500/15 text-zinc-400";
    }
}
