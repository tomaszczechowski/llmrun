import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
    {
        ignores: [
            "node_modules",
            "**/node_modules",
            "**/dist",
            "docs",
            "docs/**",
            ".pnpm-store",
            "*.lock",
            "pnpm-lock.yaml",
            "*.tsbuildinfo",
        ],
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                require: "readonly",
                module: "readonly",
                __dirname: "readonly",
                process: "readonly",
                console: "readonly",
            },
        },
        rules: {
            ...js.configs.recommended.rules,
        },
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                process: "readonly",
                console: "readonly",
                fetch: "readonly",
                URL: "readonly",
                AbortController: "readonly",
            },
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": "off",
            "no-undef": "off",
            "padding-line-between-statements": [
                "warn",
                { blankLine: "always", prev: "function", next: "*" },
                { blankLine: "always", prev: "*", next: "function" },
                { blankLine: "always", prev: "class", next: "*" },
                { blankLine: "always", prev: "*", next: "class" },
                { blankLine: "always", prev: "const", next: "return" },
                { blankLine: "always", prev: "const", next: "if" },
                { blankLine: "always", prev: "if", next: "return" },
                { blankLine: "always", prev: "import", next: "*" },
                { blankLine: "any", prev: "import", next: "import" },
            ],
            "no-multiple-empty-lines": ["warn", { max: 1, maxBOF: 0, maxEOF: 0 }],
        },
    },
];
