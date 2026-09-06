import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: here,
    plugins: [react(), tailwindcss()],
    base: "/",
    build: {
        outDir: path.resolve(here, "..", "..", "dist", "studio", "assets"),
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        proxy: { "/api": "http://127.0.0.1:4173" },
    },
});
