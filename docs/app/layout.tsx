import { Inter, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import { basePath, siteUrl } from '@/lib/shared';
import './globals.css';

const inter = Inter({
    subsets: ['latin'],
    variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
    subsets: ['latin'],
    variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: {
        default: 'llmrun — local LLMs on AWS GPU',
        template: '%s — llmrun',
    },
    description: 'Work locally with deployed open-models in your cloud.',
    icons: [
        { url: `${basePath}/logo.svg`, type: 'image/svg+xml' },
        { url: `${basePath}/apple-icon.png`, rel: 'apple-touch-icon' },
    ],
    openGraph: {
        type: 'website',
        url: siteUrl,
        siteName: 'llmrun',
        title: 'llmrun — local LLMs on AWS GPU',
        description:
            'Work locally with deployed open-models in your cloud. No local GPU, no public IP, no per-token billing.',
        images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'llmrun' }],
    },
    twitter: {
        card: 'summary_large_image',
    },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
            <body className="flex min-h-screen flex-col">
                <Provider>{children}</Provider>
            </body>
        </html>
    );
}
