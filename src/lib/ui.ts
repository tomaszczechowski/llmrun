import pc from "picocolors";
import ora, { type Ora } from "ora";

/** Presentation helpers: consistent colouring, symbols, and spinners across commands. */

export const symbols = {
    ok: pc.green("✔"),
    warn: pc.yellow("⚠"),
    err: pc.red("✖"),
    info: pc.cyan("ℹ"),
    arrow: pc.dim("›"),
    bullet: pc.dim("•"),
};

export function heading(text: string): void {
    console.log("\n" + pc.bold(text));
}

export function info(text: string): void {
    console.log(`${symbols.info} ${text}`);
}

export function success(text: string): void {
    console.log(`${symbols.ok} ${text}`);
}

export function warn(text: string): void {
    console.log(`${symbols.warn} ${pc.yellow(text)}`);
}

export function error(text: string): void {
    console.error(`${symbols.err} ${pc.red(text)}`);
}

export function dim(text: string): string {
    return pc.dim(text);
}

export function bold(text: string): string {
    return pc.bold(text);
}

export function cyan(text: string): string {
    return pc.cyan(text);
}

export function spinner(text: string): Ora {
    return ora({ text, spinner: "dots" }).start();
}

/** Render an aligned key/value block. */
export function keyValues(pairs: Array<[string, string]>): void {
    const width = Math.max(...pairs.map(([k]) => k.length));
    for (const [k, v] of pairs) {
        console.log(`  ${pc.dim(k.padEnd(width))}  ${v}`);
    }
}

/** Render a simple table with a header row. */
export function table(headers: string[], rows: string[][]): void {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
    console.log("  " + pc.bold(fmt(headers)));
    for (const row of rows) {
        console.log("  " + fmt(row));
    }
}
