<template>
    <footer class="custom-footer">
        <div class="footer-inner">
            <div class="footer-brand">
                <span class="footer-logo">llmrun</span>
                <p class="footer-tagline">Work locally with deployed open-models in your cloud.</p>
            </div>

            <div class="footer-links">
                <div class="footer-col">
                    <span class="footer-col-title">Docs</span>
                    <a href="/guide/getting-started">Getting started</a>
                    <a href="/guide/configuration">Configuration</a>
                    <a href="/guide/model-catalog">Model catalog</a>
                    <a href="/guide/integrations">Coding assistants</a>
                </div>
                <div class="footer-col">
                    <span class="footer-col-title">Project</span>
                    <a href="https://www.npmjs.com/package/llmrun" target="_blank">npm</a>
                    <a href="https://github.com/tomaszczechowski/llmrun" target="_blank">GitHub</a>
                </div>
            </div>
        </div>

        <div class="footer-bottom">
            <span>Released under the Apache-2.0 License.</span>
            <span>Copyright © 2026 Tomasz Czechowski</span>
        </div>
    </footer>
</template>

<style scoped>
.custom-footer {
    border-top: 1px solid transparent;
    background: linear-gradient(var(--vp-c-bg), var(--vp-c-bg)) padding-box,
        linear-gradient(90deg, transparent, rgba(129, 140, 248, 0.3), transparent) border-box;
    padding: 48px 24px 28px;
    margin-top: 48px;
}

.footer-inner {
    max-width: 1152px;
    margin: 0 auto;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 48px;
    flex-wrap: wrap;
}

.footer-brand {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 260px;
}

.footer-logo {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--vp-c-text-1);
}

.footer-tagline {
    font-size: 13px;
    color: var(--vp-c-text-3);
    line-height: 1.6;
    margin: 0;
}

.footer-links {
    display: flex;
    gap: 48px;
    flex-wrap: wrap;
}

.footer-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.footer-col-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vp-c-text-3);
}

.footer-col a {
    font-size: 13px;
    color: var(--vp-c-text-2);
    text-decoration: none;
    transition: color 0.15s ease;
}

.footer-col a:hover {
    color: var(--vp-c-brand-1);
}

.footer-bottom {
    max-width: 1152px;
    margin: 32px auto 0;
    padding-top: 20px;
    border-top: 1px solid var(--vp-c-divider);
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--vp-c-text-3);
}
</style>
