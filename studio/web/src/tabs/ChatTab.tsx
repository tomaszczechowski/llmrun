import { useCallback, useEffect, useRef, useState } from "react";
import {
    createConversation,
    deleteConversation,
    fetchConversation,
    fetchConversations,
    fetchServedModels,
    streamChat,
    type ChatStream,
    type ChatUsage,
    type ConversationSummary,
    type DeploymentInfo,
} from "../api";
import Markdown, { ToolCallBlock } from "../components/Markdown";
import { fmtDateTime, fmtInt, fmtUsd } from "../util";

/**
 * ChatGPT-style chat against the served model, streamed through the bridge.
 * Conversations persist as ledger `chat` events — they survive `llmrun down`.
 * Chatting counts as activity on the instance (keeps it warm), one active
 * stream per deployment.
 */

/**
 * Must stay <= the bridge's `history` cap (chatRequestSchema in
 * src/studio/chat.ts), which rejects an oversized list outright rather than
 * truncating it. Sending uncapped would make a long conversation permanently
 * unsendable, since the refused turn stays in the list and the next attempt is
 * one message longer.
 */
const MAX_HISTORY_MESSAGES = 400;

interface Props {
    deployment: DeploymentInfo | null;
}

interface UiToolCall {
    id?: string;
    name?: string;
    arguments: string;
}

interface UiMessage {
    key: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: UiToolCall[];
    usage?: ChatUsage | null;
    costUsd?: number | null;
    tokensPerSec?: number | null;
    streaming?: boolean;
    aborted?: boolean;
    error?: string | null;
}

interface ChatPrefs {
    model: string;
    temperature: number;
    maxTokens: string;
    system: string;
}

const DEFAULT_PREFS: ChatPrefs = { model: "", temperature: 0.7, maxTokens: "", system: "" };

function prefsKey(name: string): string {
    return `llmrun.chat.prefs.${name}`;
}

function cidKey(name: string): string {
    return `llmrun.chat.cid.${name}`;
}

function loadPrefs(name: string): ChatPrefs {
    try {
        const raw = localStorage.getItem(prefsKey(name));

        return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ChatPrefs>) } : DEFAULT_PREFS;
    } catch {
        return DEFAULT_PREFS;
    }
}

export default function ChatTab({ deployment }: Props) {
    const name = deployment?.name ?? null;
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [convsLoaded, setConvsLoaded] = useState(false);
    const [activeCid, setActiveCid] = useState<string | null>(null);
    const [messages, setMessages] = useState<UiMessage[]>([]);
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [statusText, setStatusText] = useState<string | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [prefs, setPrefs] = useState<ChatPrefs>(DEFAULT_PREFS);
    const [showPrefs, setShowPrefs] = useState(false);
    const streamRef = useRef<ChatStream | null>(null);
    const streamStartRef = useRef<number>(0);
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const loadingConvRef = useRef<string | null>(null);

    const refreshConversations = useCallback(async () => {
        if (!name) return;
        try {
            setConversations(await fetchConversations(name));
        } catch {
            // Bridge hiccup — the next poll retries.
        }
    }, [name]);

    // Reset + load everything when the deployment changes.
    useEffect(() => {
        setMessages([]);
        setModels([]);
        setStatusText(null);
        setActiveCid(null);
        loadingConvRef.current = null;
        if (!name) {
            setConversations([]);

            return;
        }
        setPrefs(loadPrefs(name));
        setConvsLoaded(false);
        void (async () => {
            try {
                setConversations(await fetchConversations(name));
            } catch {
                // Bridge hiccup — the next poll retries.
            } finally {
                setConvsLoaded(true);
            }
        })();
        const saved = localStorage.getItem(cidKey(name));

        if (saved) setActiveCid(saved);
    }, [name]);

    // Load the persisted conversation when a saved one is selected.
    useEffect(() => {
        if (!name || !activeCid || loadingConvRef.current === activeCid) return;
        const known = conversations.some((c) => c.conversationId === activeCid);

        if (!known) {
            // A locally-managed draft (first turn pending) keeps its ref guard;
            // anything else unknown after the list loaded is stale (deleted).
            if (convsLoaded) {
                setActiveCid(null);
                setMessages([]);
            }

            return;
        }
        loadingConvRef.current = activeCid;
        void (async () => {
            try {
                const turns = await fetchConversation(name, activeCid);
                const out: UiMessage[] = [];

                for (const turn of turns) {
                    for (const m of turn.messages) {
                        if (m.role !== "user" && m.role !== "assistant") continue;
                        const msg: UiMessage = {
                            key: `${turn.ts}-${out.length}`,
                            role: m.role,
                            content: m.content,
                            toolCalls: m.toolCalls?.map((t) => ({
                                id: t.id,
                                name: t.name,
                                arguments: t.arguments ?? "",
                            })),
                        };
                        out.push(msg);
                        if (msg.role === "assistant" && turn.usage) msg.usage = turn.usage;
                    }
                }
                setMessages(out);
            } catch {
                setMessages([]);
            }
        })();
    }, [name, activeCid, conversations, convsLoaded]);

    // Served-model picker (needs the forward; retried whenever it reconnects).
    useEffect(() => {
        if (!name || !deployment?.connected) return;
        let cancelled = false;
        void (async () => {
            const ids = await fetchServedModels(name);

            if (!cancelled && ids.length > 0) setModels(ids);
        })();

        return () => {
            cancelled = true;
        };
    }, [name, deployment?.connected]);

    // Persist prefs + active conversation.
    useEffect(() => {
        if (name) localStorage.setItem(prefsKey(name), JSON.stringify(prefs));
    }, [name, prefs]);
    useEffect(() => {
        if (!name) return;
        if (activeCid) localStorage.setItem(cidKey(name), activeCid);
        else localStorage.removeItem(cidKey(name));
    }, [name, activeCid]);

    // Autoscroll.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, [messages, statusText]);

    const newChat = () => {
        if (streaming) return;
        setActiveCid(null);
        setMessages([]);
        loadingConvRef.current = null;
    };

    const removeConversation = async (cid: string) => {
        if (!name || streaming) return;
        if (!window.confirm("Delete this conversation from the ledger view?")) return;
        try {
            await deleteConversation(name, cid);
        } catch {
            // Ignore — the list refresh below is the source of truth.
        }
        if (activeCid === cid) newChat();
        void refreshConversations();
    };

    const openConversation = (cid: string) => {
        if (streaming) return;
        // Clicking the already-open conversation keeps the live view
        // (with its cost/tok-s chips) instead of reloading ledger state.
        if (cid === activeCid && messages.length > 0) return;
        loadingConvRef.current = null;
        setActiveCid(cid);
    };

    const stop = () => {
        streamRef.current?.abort();
        streamRef.current = null;
        const elapsedMs = Date.now() - streamStartRef.current;
        const rate = deployment?.usdPerHour ?? 0;
        setMessages((prev) =>
            prev.map((m, i) =>
                i === prev.length - 1 && m.streaming
                    ? { ...m, streaming: false, aborted: true, costUsd: (elapsedMs / 3_600_000) * rate }
                    : m
            )
        );
        setStreaming(false);
        setStatusText(null);
        void refreshConversations();
    };

    const send = async () => {
        const text = input.trim();

        if (!text || streaming || !deployment || !name) return;

        let cid = activeCid;

        if (!cid) {
            try {
                cid = await createConversation(name);
            } catch {
                cid = crypto.randomUUID();
            }
            // The live message list is the conversation's current content —
            // don't let the loader effect overwrite it from the ledger.
            loadingConvRef.current = cid;
            setActiveCid(cid);
        }

        const system = prefs.system.trim();
        const prior: { role: "system" | "user" | "assistant"; content: string }[] = messages
            .filter((m) => !m.error && (m.content || (m.toolCalls?.length ?? 0) > 0))
            .map((m) => ({ role: m.role, content: m.content }));
        // Keep the most recent turns; the system prompt always rides along.
        const budget = system ? MAX_HISTORY_MESSAGES - 1 : MAX_HISTORY_MESSAGES;
        const history = prior.slice(-budget);

        if (system) {
            history.unshift({ role: "system", content: system });
        }

        const asstKey = `a-${Date.now()}`;
        setMessages((prev) => [
            ...prev,
            { key: `u-${Date.now()}`, role: "user", content: text },
            { key: asstKey, role: "assistant", content: "", streaming: true },
        ]);
        setInput("");
        setStreaming(true);
        setStatusText(null);
        streamStartRef.current = Date.now();

        const rate = deployment.usdPerHour;
        const patch = (fn: (m: UiMessage) => UiMessage) =>
            setMessages((prev) => prev.map((m) => (m.key === asstKey ? fn(m) : m)));

        streamRef.current = streamChat(
            name,
            {
                conversationId: cid,
                message: text,
                history,
                params: {
                    model: prefs.model || undefined,
                    temperature: Number.isFinite(prefs.temperature) ? prefs.temperature : undefined,
                    maxTokens: prefs.maxTokens ? parseInt(prefs.maxTokens, 10) || undefined : undefined,
                },
            },
            {
                onStatus: (t) => setStatusText(t),
                onDelta: (t) => patch((m) => ({ ...m, content: m.content + t })),
                onToolCalls: (tc) =>
                    patch((m) => ({
                        ...m,
                        toolCalls: tc.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })),
                    })),
                onUsage: (u) => patch((m) => ({ ...m, usage: u })),
                onDone: (info) => {
                    setStatusText(null);
                    setStreaming(false);
                    streamRef.current = null;
                    patch((m) => ({
                        ...m,
                        streaming: false,
                        usage: info.usage ?? m.usage,
                        costUsd: (info.elapsedMs / 3_600_000) * rate,
                        tokensPerSec:
                            info.usage && info.elapsedMs > 0
                                ? (info.usage.completionTokens / info.elapsedMs) * 1000
                                : m.tokensPerSec,
                    }));
                    void refreshConversations();
                },
                onError: (msg) => {
                    setStatusText(null);
                    setStreaming(false);
                    streamRef.current = null;
                    patch((m) => ({ ...m, streaming: false, error: msg }));
                },
            }
        );
    };

    if (!deployment) {
        return <div className="text-zinc-400">Select a deployment to chat with its model.</div>;
    }

    const stopped = deployment.state !== "running";

    return (
        <div className="flex h-[calc(100vh-7.5rem)] gap-4">
            {/* Conversation switcher — backed by the ledger, survives `down`. */}
            <aside className="flex w-64 shrink-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900">
                <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                    <span className="text-sm font-medium text-zinc-300">Conversations</span>
                    <button
                        onClick={newChat}
                        disabled={streaming}
                        className="rounded-md bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-400 hover:bg-sky-500/20 disabled:opacity-50"
                    >
                        + New
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-2">
                    {conversations.length === 0 && (
                        <div className="px-2 py-3 text-xs text-zinc-500">
                            No conversations yet — sent messages are saved to the local ledger automatically.
                        </div>
                    )}
                    {conversations.map((c) => (
                        <div
                            key={c.conversationId}
                            className={`group mb-1 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm ${
                                c.conversationId === activeCid
                                    ? "bg-zinc-800 text-zinc-100"
                                    : "text-zinc-400 hover:bg-zinc-800/60"
                            }`}
                            onClick={() => openConversation(c.conversationId)}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate">{c.title}</div>
                                <div className="mt-0.5 text-[11px] text-zinc-500">
                                    {c.turns} turn{c.turns === 1 ? "" : "s"} · {fmtDateTime(c.lastTs)}
                                </div>
                            </div>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void removeConversation(c.conversationId);
                                }}
                                className="hidden shrink-0 text-xs text-zinc-500 hover:text-red-400 group-hover:block"
                                title="Delete conversation"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
                <div className="border-t border-zinc-800 px-3 py-2 text-[11px] leading-snug text-zinc-500">
                    Persisted in <code>~/.llmrun/history.jsonl</code> — conversation text survives{" "}
                    <code>llmrun down</code>.
                </div>
            </aside>

            {/* Chat pane */}
            <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900">
                <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
                    <span className="font-medium text-zinc-200">{deployment.alias}</span>
                    <select
                        value={prefs.model}
                        onChange={(e) => setPrefs((p) => ({ ...p, model: e.target.value }))}
                        className="max-w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300"
                        title="Served model (from GET /v1/models)"
                    >
                        <option value="">{models.length > 0 ? `${models[0]} (default)` : "default model"}</option>
                        {models.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                    <span className="text-xs text-zinc-500">
                        {deployment.state} · {fmtUsd(deployment.usdPerHour)}/hr{deployment.rateLive ? " (live)" : ""}
                    </span>
                    <div className="relative ml-auto">
                        <button
                            onClick={() => setShowPrefs((s) => !s)}
                            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                showPrefs ? "bg-sky-500/20 text-sky-300" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                            }`}
                        >
                            ⚙ Params
                        </button>
                        {showPrefs && (
                            <div className="absolute right-0 top-9 z-10 w-72 rounded-lg border border-zinc-700 bg-zinc-950 p-3 shadow-xl">
                                <label className="block text-xs text-zinc-400">
                                    Temperature: {prefs.temperature.toFixed(1)}
                                    <input
                                        type="range"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={prefs.temperature}
                                        onChange={(e) =>
                                            setPrefs((p) => ({ ...p, temperature: parseFloat(e.target.value) }))
                                        }
                                        className="mt-1 w-full accent-sky-500"
                                    />
                                </label>
                                <label className="mt-2 block text-xs text-zinc-400">
                                    Max tokens
                                    <input
                                        type="number"
                                        min={1}
                                        placeholder="model default"
                                        value={prefs.maxTokens}
                                        onChange={(e) => setPrefs((p) => ({ ...p, maxTokens: e.target.value }))}
                                        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                                    />
                                </label>
                                <label className="mt-2 block text-xs text-zinc-400">
                                    System prompt
                                    <textarea
                                        rows={3}
                                        placeholder="(none)"
                                        value={prefs.system}
                                        onChange={(e) => setPrefs((p) => ({ ...p, system: e.target.value }))}
                                        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                                    />
                                </label>
                            </div>
                        )}
                    </div>
                </div>

                {stopped && (
                    <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
                        The instance is <b>{deployment.state}</b> — start it from the Overview tab to continue chatting.
                        Saved conversations stay readable.
                    </div>
                )}

                <div className="flex-1 overflow-auto p-4">
                    {messages.length === 0 && (
                        <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                            {stopped
                                ? "Start the instance to chat. Its past conversations remain in the sidebar."
                                : "Send a message to chat with the served model. Chatting keeps the instance awake (it counts as activity)."}
                        </div>
                    )}
                    <div className="mx-auto flex max-w-3xl flex-col gap-4">
                        {messages.map((m) => (
                            <MessageView key={m.key} m={m} />
                        ))}
                        {statusText && (
                            <div className="self-start rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-sky-300">
                                {statusText}
                            </div>
                        )}
                        <div ref={bottomRef} />
                    </div>
                </div>

                <div className="border-t border-zinc-800 p-3">
                    <div className="mx-auto flex max-w-3xl items-end gap-2">
                        <textarea
                            rows={Math.min(6, Math.max(1, input.split("\n").length))}
                            value={input}
                            disabled={stopped}
                            placeholder={
                                stopped
                                    ? "Instance is not running"
                                    : "Message the model… (Enter to send, Shift+Enter for a newline)"
                            }
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                            className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-60"
                        />
                        {streaming ? (
                            <button
                                onClick={stop}
                                className="rounded-md bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20"
                            >
                                Stop
                            </button>
                        ) : (
                            <button
                                onClick={() => void send()}
                                disabled={stopped || input.trim().length === 0 || deployment.chatBusy}
                                className="rounded-md bg-sky-500/15 px-4 py-2 text-sm font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-40"
                            >
                                Send
                            </button>
                        )}
                    </div>
                    {deployment.chatBusy && !streaming && (
                        <div className="mx-auto mt-1.5 max-w-3xl text-[11px] text-amber-400">
                            Another chat stream is running for this deployment (one at a time).
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

function MessageView({ m }: { m: UiMessage }) {
    if (m.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-sky-500/15 px-3.5 py-2 text-sm text-zinc-100">
                    {m.content}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="max-w-[92%] rounded-lg rounded-bl-sm bg-zinc-800/70 px-3.5 py-2 text-sm text-zinc-100">
                {m.toolCalls?.map((tc, i) => (
                    <ToolCallBlock key={i} name={tc.name} raw={renderToolArgs(tc)} />
                ))}
                {m.content ? (
                    <Markdown text={m.content} />
                ) : m.streaming ? (
                    <span className="inline-block h-4 w-2 animate-pulse bg-zinc-500 align-text-bottom" />
                ) : m.error ? null : (
                    <span className="text-zinc-500">(empty response)</span>
                )}
                {m.error && <div className="mt-1 text-xs text-red-400">{m.error}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-1 text-[11px] text-zinc-500">
                {m.aborted && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-400">stopped</span>}
                {m.usage && (
                    <span>
                        {fmtInt(m.usage.promptTokens)} in · {fmtInt(m.usage.completionTokens)} out
                    </span>
                )}
                {m.tokensPerSec !== null && m.tokensPerSec !== undefined && m.tokensPerSec > 0 && (
                    <span>{m.tokensPerSec.toFixed(1)} tok/s</span>
                )}
                {m.costUsd !== null && m.costUsd !== undefined && m.costUsd > 0 && (
                    <span title="Share of instance time spent on this message">
                        ≈ {fmtUsd(m.costUsd, m.costUsd < 0.01 ? 4 : 3)} of instance time
                    </span>
                )}
            </div>
        </div>
    );
}

function renderToolArgs(tc: UiToolCall): string {
    const args = tc.arguments.trim();
    const nameLine = tc.name ? `${tc.name}\n` : "";

    if (args.startsWith("{") || args.startsWith("[")) {
        try {
            return `${nameLine}${JSON.stringify(JSON.parse(args), null, 2)}`;
        } catch {
            // Fall through to the raw text.
        }
    }

    return `${nameLine}${args}`;
}
