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

/** Parse a human duration like "30m", "1h", "90s", "7d", "2h30m" into seconds. */
export function parseDuration(input: string): number {
    const trimmed = input.trim().toLowerCase();

    if (/^\d+$/.test(trimmed)) {
        // Bare number: interpret as minutes for convenience.
        return parseInt(trimmed, 10) * 60;
    }
    const re = /(\d+)\s*(d|h|m|s)/g;
    let match: RegExpExecArray | null;
    let seconds = 0;
    let matched = false;
    while ((match = re.exec(trimmed)) !== null) {
        matched = true;
        const value = parseInt(match[1]!, 10);
        const unit = match[2];

        if (unit === "d") seconds += value * 86400;
        else if (unit === "h") seconds += value * 3600;
        else if (unit === "m") seconds += value * 60;
        else seconds += value;
    }
    if (!matched) {
        throw new LlmrunError(`Invalid duration: "${input}"`, 'Use forms like "30m", "1h", "7d", "90s", or "2h30m".');
    }

    return seconds;
}

/**
 * Parse a `--since` range ("30d", "12h", "90m", "60") into an absolute ISO
 * timestamp. A bare number means *days* here (ranges are coarse by nature).
 * Returns undefined for an empty/missing input (= all time).
 */
export function parseSinceIso(input: string | undefined, now = new Date()): string | undefined {
    const trimmed = input?.trim();

    if (!trimmed) return undefined;

    let seconds: number;

    if (/^\d+$/.test(trimmed)) {
        seconds = parseInt(trimmed, 10) * 86400;
    } else {
        seconds = parseDuration(trimmed);
    }

    if (seconds <= 0) {
        throw new LlmrunError(`Invalid range: "${input}"`, 'Use forms like "30d", "12h", or "90m".');
    }

    const since = new Date(now.getTime() - seconds * 1000);

    // Absurd ranges overflow the Date epoch; surface that as a usage error, not a RangeError.
    if (Number.isNaN(since.getTime())) {
        throw new LlmrunError(`Range too large: "${input}"`, 'Use forms like "30d", "12h", or "90m".');
    }

    return since.toISOString();
}

/**
 * Format a number of seconds back into a compact human string ("1h 30m",
 * "59m 59s", "45s"). Truncates rather than rounds, so a value never reads as
 * the unit above it — 3599s is "59m 59s", never "60m".
 */
export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;

    return `${s}s`;
}
