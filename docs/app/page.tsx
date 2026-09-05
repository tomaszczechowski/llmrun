import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { gitHubUrl } from '@/lib/shared';
import { basePath } from '@/lib/shared';

export const metadata: Metadata = {
    title: 'Local LLMs on AWS GPU',
    description: 'Work locally with deployed open-models in your cloud.',
};

const features = [
    {
        icon: `${basePath}/icons/no-gpu.svg`,
        title: 'No local GPU required',
        details:
            "Your laptop stays cool. Models run on the right-sized AWS GPU instance — spin it up when you need it, let it stop itself when you don't.",
    },
    {
        icon: `${basePath}/icons/cost.svg`,
        title: 'Pay for infrastructure, not tokens',
        details:
            "No per-token pricing. You pay AWS on-demand rates (~$0.80/hr) only while the instance is running. Idle auto-stop means you're rarely paying for nothing.",
    },
    {
        icon: `${basePath}/icons/security.svg`,
        title: 'Your data stays in your cloud',
        details:
            'Inference never leaves your AWS account. No third-party API receives your prompts, code, or documents — full isolation for sensitive or proprietary work.',
    },
    {
        icon: `${basePath}/icons/catalog.svg`,
        title: 'Editable model catalog',
        details:
            'llmrun.yaml maps a friendly alias to a HuggingFace repo and the GPU instance needed to serve it. Add, swap, or pin any open-source model in seconds.',
    },
    {
        icon: `${basePath}/icons/lock.svg`,
        title: 'No public IP, no SSH keys',
        details:
            'Access is entirely over AWS SSM port-forwarding. No inbound security group rules, no bastion host, no key pair to manage.',
    },
    {
        icon: `${basePath}/icons/parallel.svg`,
        title: 'Run multiple models at once',
        details:
            'Each deployment gets its own local port (8000, 8001, …). Forward all concurrently — point different tools at different models without disconnecting anything.',
    },
];

export default function Home() {
    return (
        <main className="min-h-dvh bg-[#0c0b18] text-white">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[500px]" style={{ background: 'radial-gradient(760px 400px at 50% -140px, rgba(99, 102, 241, 0.24), transparent 70%), radial-gradient(520px 300px at 82% 0%, rgba(129, 140, 248, 0.1), transparent 70%)' }} />

            <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
                <Link href="/" className="flex items-center gap-2.5">
                    <Image src={basePath + "/logo.svg"} alt="llmrun logo" width={32} height={32} />
                    <span className="text-lg font-bold tracking-tight">llmrun</span>
                </Link>
                <nav className="flex items-center gap-6 text-sm text-white/70">
                    <Link href="/docs/guide/getting-started" className="transition-colors hover:text-white">
                        Docs
                    </Link>
                    <a href="https://www.npmjs.com/package/llmrun" target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                        npm
                    </a>
                    <a href={gitHubUrl} target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                        GitHub
                    </a>
                </nav>
            </header>

            <section className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-16 pt-12 text-center sm:pt-16">
                <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl">
                    <span className="bg-gradient-to-r from-[#a5b4fc] via-[#818cf8] to-[#6366f1] bg-clip-text text-transparent">llmrun</span>
                </h1>
                <p className="mt-4 text-2xl font-semibold text-white/90 sm:text-3xl">Local LLMs on AWS GPU</p>
                <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/60">
                    Work locally with deployed open-models in your cloud. No local GPU, no public IP, no per-token billing.
                </p>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                    <Link
                        href="/docs/guide/getting-started"
                        className="rounded-lg bg-[#4f46e5] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition-colors hover:bg-[#4338ca]"
                    >
                        Get Started
                    </Link>
                    <a
                        href={gitHubUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white/90 transition-colors hover:bg-white/10"
                    >
                        GitHub
                    </a>
                </div>
                <Image src={basePath + "/hero-terminal.svg"} alt="llmrun terminal session" width={760} height={460} className="mt-14 w-full max-w-3xl" />
            </section>

            <section className="relative mx-auto w-full max-w-6xl px-6 pb-20">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {features.map((feature) => (
                        <div key={feature.title} className="group rounded-xl border border-indigo-500/25 bg-white/[0.03] p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-500/50 hover:shadow-[0_10px_28px_rgba(99,102,241,0.22)]">
                            <div className="flex flex-col gap-2.5">
                                <div className="flex size-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-indigo-500/15">
                                    <Image src={feature.icon} alt="" width={24} height={24} className="transition-transform duration-200 group-hover:-rotate-3 group-hover:scale-110" />
                                </div>
                                <h2 className="text-[15px] font-bold leading-snug tracking-[-0.01em]">{feature.title}</h2>
                                <p className="text-[13px] leading-[1.65] text-white/60">{feature.details}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <footer className="relative border-t border-white/10 py-8">
                <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 text-sm text-white/50 sm:flex-row">
                    <p>© {new Date().getFullYear()} Tomasz Czechowski · Apache-2.0</p>
                    <div className="flex items-center gap-5">
                        <Link href="/docs/guide/getting-started" className="transition-colors hover:text-white">
                            Docs
                        </Link>
                        <a href="https://www.npmjs.com/package/llmrun" target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                            npm
                        </a>
                        <a href={gitHubUrl} target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
                            GitHub
                        </a>
                    </div>
                </div>
            </footer>
        </main>
    );
}
