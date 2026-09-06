import { useEffect, useRef, useState } from "react";
import { logsStream, type DeploymentInfo } from "../api";

interface Props {
    deployment: DeploymentInfo | null;
}

const MAX_LINES = 5000;
const RESTART_RE = /exited|schedul\w+ restart|out of memory|oom-?kill|fatal|aborted/i;

export default function LogsTab({ deployment }: Props) {
    const name = deployment?.name;
    const [lines, setLines] = useState<string[]>([]);
    const [filter, setFilter] = useState("");
    const [paused, setPaused] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const [info, setInfo] = useState<string | null>(null);
    const preRef = useRef<HTMLPreElement | null>(null);

    useEffect(() => {
        if (!name) return;
        setLines([]);
        setInfo(null);
        const close = logsStream(name, {
            onLine: (line) => {
                setInfo(null);
                setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(1), line] : [...prev, line]));
            },
            onEnd: (text) => setInfo(text),
        });
        return close;
    }, [name]);

    const filtered = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
    const restartSignals = lines.filter((l) => RESTART_RE.test(l)).length;

    useEffect(() => {
        if (autoScroll && !paused && preRef.current) {
            preRef.current.scrollTop = preRef.current.scrollHeight;
        }
    }, [filtered, autoScroll, paused]);

    if (!deployment) {
        return <div className="text-zinc-400">Select a deployment to see logs.</div>;
    }

    if (deployment.state !== "running") {
        return (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-10 text-center text-zinc-400">
                The instance is <span className="text-amber-400">{deployment.state}</span> — logs are only streamed
                while it's running (SSM needs the agent online).
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter lines…"
                    className="w-64 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm placeholder:text-zinc-500"
                />
                <button
                    onClick={() => setPaused((p) => !p)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                        paused ? "bg-amber-500/10 text-amber-400" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    }`}
                >
                    {paused ? "Resume" : "Pause"}
                </button>
                <label className="flex items-center gap-2 text-sm text-zinc-400">
                    <input
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                        className="accent-sky-500"
                    />
                    Autoscroll
                </label>
                {restartSignals > 0 && (
                    <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400">
                        {restartSignals} restart/exit signal{restartSignals === 1 ? "" : "s"} — the server may be
                        crash-looping
                    </span>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                    {lines.length.toLocaleString()} lines (journalctl -u llmrun-server)
                </span>
            </div>

            <pre
                ref={preRef}
                className="terminal h-[70vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-300"
            >
                {filtered.length === 0
                    ? info ?? (lines.length === 0 ? "Waiting for log output from the instance…" : "(no lines match the filter)")
                    : filtered.map((l, i) => (
                          <div key={i} className={RESTART_RE.test(l) ? "text-red-400" : undefined}>
                              {l}
                          </div>
                      ))}
            </pre>
        </div>
    );
}
