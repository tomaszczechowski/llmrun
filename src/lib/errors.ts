/**
 * A user-facing error whose message is safe (and intended) to print directly,
 * optionally with a hint on how to resolve it. The CLI top-level handler prints
 * these cleanly instead of dumping a stack trace.
 */
export class LlmrunError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = "LlmrunError";
        this.hint = hint;
    }
}

/** Parse a human duration like "30m", "1h", "90s", "2h30m" into seconds. */
export function parseDuration(input: string): number {
    const trimmed = input.trim().toLowerCase();

    if (/^\d+$/.test(trimmed)) {
        // Bare number: interpret as minutes for convenience.
        return parseInt(trimmed, 10) * 60;
    }
    const re = /(\d+)\s*(h|m|s)/g;
    let match: RegExpExecArray | null;
    let seconds = 0;
    let matched = false;
    while ((match = re.exec(trimmed)) !== null) {
        matched = true;
        const value = parseInt(match[1]!, 10);
        const unit = match[2];

        if (unit === "h") seconds += value * 3600;
        else if (unit === "m") seconds += value * 60;
        else seconds += value;
    }
    if (!matched) {
        throw new LlmrunError(`Invalid duration: "${input}"`, 'Use forms like "30m", "1h", "90s", or "2h30m".');
    }

    return seconds;
}

/** Format a number of seconds back into a compact human string. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];

    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);

    return parts.join("") || "0m";
}
