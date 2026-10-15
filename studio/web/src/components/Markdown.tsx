import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for chat messages: GitHub-flavored markdown, styled code
 * blocks with a copy button, and automatic extraction of raw tool-call XML
 * (Qwen3-style `<tool_call>` / `<tool_response>` blocks the model emits inline)
 * into collapsible panels.
 */

const TOOL_XML_RE = /(<tool_response>[\s\S]*?<\/tool_response>|<tool_call>[\s\S]*?<\/tool_call>)/g;

function tryPrettyJson(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

export function ToolCallBlock({ name, raw }: { name?: string; raw: string }) {
    const [open, setOpen] = useState(false);
    const stripped = raw
        .replace(/<\/?tool_response>/g, "")
        .replace(/<\/?tool_call>/g, "")
        .trim();

    return (
        <div className="my-1.5 rounded-md border border-violet-500/30 bg-violet-500/5 text-sm">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-violet-300"
            >
                <span className="text-xs">{open ? "▾" : "▸"}</span>
                <span className="font-medium">{name || "tool call"}</span>
            </button>
            {open && (
                <pre className="terminal overflow-auto border-t border-violet-500/20 px-3 py-2 text-xs text-zinc-300">
                    {tryPrettyJson(stripped)}
                </pre>
            )}
        </div>
    );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
        } catch {
            // Clipboard unavailable — ignore.
        }
    };

    return (
        <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1 text-xs text-zinc-500">
                <span>{lang || "code"}</span>
                <button onClick={() => void copy()} className="text-zinc-400 hover:text-zinc-200">
                    {copied ? "copied" : "copy"}
                </button>
            </div>
            <pre className="terminal overflow-auto p-3 text-xs leading-relaxed text-zinc-200">{text}</pre>
        </div>
    );
}

/** react-markdown renders fenced code inside <pre><code class="language-x">. */
function PreWrapper({ children }: { children?: ReactNode }) {
    const child = Array.isArray(children) ? children[0] : children;
    const props = ((child as { props?: Record<string, unknown> } | null)?.props ?? {}) as {
        className?: string;
        children?: ReactNode;
    };
    const lang = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? "";
    const text = String(props.children ?? "").replace(/\n$/, "");

    return <CodeBlock lang={lang} text={text} />;
}

export default function Markdown({ text }: { text: string }) {
    const parts = text.split(TOOL_XML_RE).filter((p) => p !== "");

    return (
        <div className="min-w-0">
            {parts.map((part, i) =>
                /<tool_response>/.test(part) || /<tool_call>/.test(part) ? (
                    <ToolCallBlock key={i} raw={part} />
                ) : (
                    <div key={i} className="md">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                pre: PreWrapper,
                                a: ({ href, children }) => (
                                    <a href={href} target="_blank" rel="noreferrer" className="text-sky-400 underline">
                                        {children}
                                    </a>
                                ),
                            }}
                        >
                            {part}
                        </ReactMarkdown>
                    </div>
                )
            )}
        </div>
    );
}
