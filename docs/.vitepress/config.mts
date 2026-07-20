import { defineConfig } from "vitepress";

export default defineConfig({
    title: "llmrun",
    description: "Work locally with deployed open-models in your cloud.",
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
                    { text: "Coding Assistants", link: "/guide/integrations" },
                ],
            },
        ],

        socialLinks: [{ icon: "github", link: "https://github.com/tomaszczechowski/llmrun" }],

        footer: {
            message: "Released under the Apache-2.0 License.",
            copyright: "Copyright © 2026 Tomasz Czechowski",
        },

        search: {
            provider: "local",
        },
    },
});
