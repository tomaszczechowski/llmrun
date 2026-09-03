import { defineConfig } from "vitepress";

const SITE_URL = "https://tomaszczechowski.github.io/llmrun/";
const BASE = "/llmrun/";

export default defineConfig({
    title: "llmrun",
    description: "Work locally with deployed open-models in your cloud.",
    base: "/llmrun/",
    head: [
        ["link", { rel: "icon", href: `${BASE}logo.svg` }],
        ["link", { rel: "apple-touch-icon", href: `${BASE}apple-icon.png` }],
        ["meta", { name: "theme-color", content: "#0c0b18" }],
        ["meta", { property: "og:type", content: "website" }],
        ["meta", { property: "og:url", content: SITE_URL }],
        ["meta", { property: "og:title", content: "llmrun — local LLMs on AWS GPU" }],
        [
            "meta",
            {
                property: "og:description",
                content:
                    "Work locally with deployed open-models in your cloud. No local GPU, no public IP, no per-token billing.",
            },
        ],
        ["meta", { property: "og:image", content: `${SITE_URL}og-image.png` }],
        ["meta", { name: "twitter:card", content: "summary_large_image" }],
        ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
        ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
        [
            "link",
            {
                rel: "stylesheet",
                href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
            },
        ],
    ],

    themeConfig: {
        logo: "/logo.svg",
        siteTitle: "llmrun",

        nav: [
            { text: "Docs", link: "/guide/getting-started" },
            { text: "npm", link: "https://www.npmjs.com/package/llmrun" },
        ],

        sidebar: [
            {
                text: "Guide",
                items: [
                    { text: "Docs", link: "/guide/getting-started" },
                    { text: "Configuration", link: "/guide/configuration" },
                    { text: "Model Catalog", link: "/guide/model-catalog" },
                    {
                        text: "Coding Assistants",
                        link: "/guide/integrations",
                        collapsed: true,
                        items: [
                            { text: "Continue", link: "/guide/integrations#continue-vs-code-jetbrains" },
                            { text: "Cursor", link: "/guide/integrations#cursor" },
                            { text: "Cline / Roo", link: "/guide/integrations#cline-roo-vs-code" },
                            { text: "Kilo Code", link: "/guide/integrations#kilo-code-vs-code" },
                            { text: "Aider", link: "/guide/integrations#aider" },
                            { text: "Open WebUI", link: "/guide/integrations#open-webui" },
                            { text: "OpenClaw", link: "/guide/integrations#openclaw" },
                            { text: "OpenCode", link: "/guide/integrations#opencode" },
                        ],
                    },
                    { text: "Troubleshooting", link: "/guide/troubleshooting" },
                ],
            },
        ],

        socialLinks: [{ icon: "github", link: "https://github.com/tomaszczechowski/llmrun" }],

        search: {
            provider: "local",
        },

        lastUpdated: true,
        editLink: {
            pattern: "https://github.com/tomaszczechowski/llmrun/edit/main/docs/:path",
            text: "Edit this page on GitHub",
        },
    },
});
