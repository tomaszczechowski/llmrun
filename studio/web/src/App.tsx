import { useEffect, useState } from "react";
import { fetchDeployments, sendAction, type DeploymentInfo } from "./api";
import OverviewTab from "./tabs/OverviewTab";
import MetricsTab from "./tabs/MetricsTab";
import LogsTab from "./tabs/LogsTab";

type Tab = "overview" | "metrics" | "logs";

const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "metrics", label: "Metrics" },
    { id: "logs", label: "Logs" },
];

export default function App() {
    const [tab, setTab] = useState<Tab>("overview");
    const [deployments, setDeployments] = useState<DeploymentInfo[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        let stopped = false;
        const tick = async () => {
            try {
                const ds = await fetchDeployments();
                if (!stopped) {
                    setDeployments(ds);
                    setError(null);
                }
            } catch (e) {
                if (!stopped) setError((e as Error).message);
            }
        };
        void tick();
        const h = setInterval(() => void tick(), 5_000);
        return () => {
            stopped = true;
            clearInterval(h);
        };
    }, []);

    useEffect(() => {
        if (deployments.length === 0) {
            if (selected !== null) setSelected(null);
            return;
        }
        if (!selected || !deployments.some((d) => d.name === selected)) {
            setSelected(deployments[0]!.name);
        }
    }, [deployments, selected]);

    const selectedDeployment = deployments.find((d) => d.name === selected) ?? null;

    const runAction = async (name: string, action: string) => {
        setBusy(`${name}:${action}`);
        try {
            const r = await sendAction(name, action);
            if (!r.ok && r.error) setError(r.error);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100">
            <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-zinc-800 px-6 py-4">
                <div className="text-lg font-semibold tracking-tight">
                    llmrun <span className="text-sky-400">studio</span>
                </div>
                <nav className="flex gap-1">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                                tab === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>
                {(tab === "metrics" || tab === "logs") && (
                    <select
                        value={selected ?? ""}
                        onChange={(e) => setSelected(e.target.value)}
                        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
                    >
                        {deployments.map((d) => (
                            <option key={d.name} value={d.name}>
                                {d.name} ({d.state})
                            </option>
                        ))}
                    </select>
                )}
                <div className="ml-auto text-xs text-zinc-500">
                    {error ? <span className="text-red-400">{error}</span> : "localhost only · no external access"}
                </div>
            </header>

            <main className="p-6">
                {tab === "overview" && (
                    <OverviewTab
                        deployments={deployments}
                        busy={busy}
                        onAction={(name, action) => void runAction(name, action)}
                    />
                )}
                {tab === "metrics" && <MetricsTab deployment={selectedDeployment} />}
                {tab === "logs" && <LogsTab deployment={selectedDeployment} />}
            </main>
        </div>
    );
}
