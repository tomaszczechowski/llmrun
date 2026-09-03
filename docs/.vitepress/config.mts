import { defineConfig } from "vitepress";

export default defineConfig({
    title: "llmrun",
    description: "Work locally with deployed open-models in your cloud.",
    base: "/llmrun/",
    head: [["link", { rel: "icon", href: "/favicon.ico" }]],

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
    },
});
