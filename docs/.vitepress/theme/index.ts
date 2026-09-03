import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import Footer from "./Footer.vue";
import HeroTerminal from "./HeroTerminal.vue";
import "./custom.css";
import type { Theme } from "vitepress";

export default {
    extends: DefaultTheme,
    Layout() {
        return h(DefaultTheme.Layout, null, {
            "home-hero-actions-after": () => h(HeroTerminal),
            "layout-bottom": () => h(Footer),
        });
    },
} satisfies Theme;
