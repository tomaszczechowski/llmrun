/** Poll a served model's health endpoint through the local port-forward. */
export async function waitForModelHealthy(
    localPort: number,
    timeoutMs = 900_000,
    intervalMs = 5_000
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const urls = [`http://127.0.0.1:${localPort}/health`, `http://127.0.0.1:${localPort}/v1/models`];
    // Note: Date.now() is used only for a wall-clock timeout.
    while (Date.now() < deadline) {
        for (const url of urls) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(4000) });

                if (res.ok) return true;
            } catch {
                // not up yet
            }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}
