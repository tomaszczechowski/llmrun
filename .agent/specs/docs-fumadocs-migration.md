# Spec: Docs Migration from VitePress to Fumadocs

## Goal

Convert the llmrun docs from VitePress to Fumadocs (Next.js 16, static export) for GitHub Pages deployment under `/llmrun/`.

- Site URL: `https://tomaszczechowski.github.io/llmrun/`
- Git repo: `tomaszczechowski/llmrun`, branch `main`
- Status: **completed** (commit `6c9b590 Mograted to Fumadocs`; follow-ups `1a587ef`, `abbb8ac`)

## Version Decisions

| Package | Version | Notes |
|---|---|---|
| next | 16.3.4 | static export |
| react | ^19.2.8 | |
| fumadocs-core | 16.15.7 | |
| fumadocs-mdx | 15.4.0 | |
| fumadocs-ui | npm:@fumadocs/base-ui@16.15.7 | pnpm alias; Base UI variant (matches reference, not the default Radix) |
| tailwindcss | ^4.3.3 | + @tailwindcss/postcss ^4.3.3, postcss ^8.5.26 |
| typescript | ^5.9.3 | repo standard (not the reference project's 7.0.2) |
| @types/node | ^24 | CI runs Node 24 |

pnpm workspace: `pnpm-workspace.yaml` with `packages: [docs]`; docs package name is `llmrun-docs`.

## Docs App Structure (`docs/`)

- `next.config.mjs`: `createMDX` from `fumadocs-mdx/next`, `output: 'export'`, `basePath: '/llmrun'`, `trailingSlash: true`, `images: { unoptimized: true }`, `reactStrictMode: true`
- Fonts: Inter + JetBrains Mono via `next/font/google`; CSS vars `--font-inter` / `--font-jetbrains-mono` overridden in `@theme` in `globals.css`
- CSS: `@import 'tailwindcss'`, `fumadocs-ui/css/neutral.css`, `fumadocs-ui/css/preset.css`
- `content/docs/meta.json`: `{ "title": "llmrun", "pages": ["index", "guide"] }`
- `content/docs/index.mdx`: welcome/landing-docs page
- `content/docs/guide/meta.json`: `{ "title": "Guide", "pages": ["getting-started", "configuration", "model-catalog", "integrations", "troubleshooting"] }`
- `meta.json` is just a `pages: string[]` array; groups are folders with their own `meta.json`
- `pageSchema` uses `$strip` (permissive for extra frontmatter)
- Landing page: custom server component at `app/page.tsx` (not `HomeLayout`), dark `#0c0b18` background, indigo gradient, 6 feature cards
- `BaseLayoutProps`: `links` is a top-level prop (not `nav.links`); `githubUrl` is separate
- Callout types: `'info' | 'warn' | 'error' | 'success' | 'warning' | 'idea'`; VitePress `tip` → `type="info"`
- Code tabs: not in default MDX components; use `CodeBlockTabs` / `CodeBlockTabsList` / `CodeBlockTabsTrigger` / `CodeBlockTab` (`Base UI Tabs` renders client-side, so tab content is not present in static HTML — expected progressive-enhancement behavior)

## Search & LLMS Endpoints

- Search: `createFromSource(source, { language: 'english' })` → static route, `dynamic = 'force-static'`, `revalidate = false`; client is `staticClient({ from: '/llmrun/api/search' })` — base path hardcoded, since `BASE_PATH` from Vite's `import.meta.env.BASE_URL` is undefined in Next.js. `out/api/search` is a single file with the search-index JSON.
- `llms.txt` and `llms-full.txt` routes; per-page markdown at `/llms.mdx/<slug>/content.md`

## Root File Updates

- `package.json`: scripts `docs:dev` / `docs:build` / `docs:preview` → `pnpm --filter llmrun-docs ...`; removed `vitepress` dev dependency
- `.gitignore`: added `docs/.next/`, `docs/out/`
- `.prettierignore`: added `docs/.next`, `docs/out`, `docs/next-env.d.ts`
- `eslint.config.js`: ignore `docs` and `docs/**`
- `.github/workflows/docs.yml`: "Deploy Fumadocs site to Pages", Node 24, `pnpm run docs:build`, upload `docs/out`

## Build Fixes Applied

1. Duplicate `DocsLayout` export name → default export renamed to `DocsSectionLayout`
2. `TS2344` on `[[...slug]]` route handler — `params` must be optional `slug?: string[]`; added `notFound()` guard on the `llms.mdx` route

## Post-Build Fixes Verified

- **Cross-page relative links**: fumadocs `createRelativeLink` / `source.resolveHref` requires relative file paths *with* the `.mdx` extension (`pathToPage` keys include it). Added `.mdx` to 4 links — `integrations.mdx` (lines ~151, 210, 216) and `troubleshooting.mdx` (~line 135). Links now resolve to `/llmrun/docs/guide/<page>/#anchor`.
- **Heading anchors**: double-hyphen IDs (e.g. `#tool--function-calling`) for headings containing slashes.
- **OG image base path**: Next metadataBase concatenated `basePath` onto image URLs, doubling the prefix (`/llmrun/llmrun/og/...`). Fix: drop the manual `/llmrun` prefix from image URLs (`'/og-image.png'` in `layout.tsx`; `getPageImageUrl(page).url` without prefix in `page.tsx`). After rebuild: `https://tomaszczechowski.github.io/llmrun/og-image.png` and `.../llmrun/og/docs/guide/getting-started/image.png`. Icons (`/llmrun/logo.svg`) were unaffected.
- **Markdown page actions**: `MarkdownCopyButton` / `ViewOptionsPopover` accept a root-relative `markdownUrl` and apply `withBasePath()` internally — no fix needed. Verified `/llmrun/llms.mdx/docs/guide/getting-started/content.md` returns 200.

## Verification Results

- Build: 24/24 static pages, no errors
- Preview: `npx serve` on port 4321 with `docs/out` copied to `<tmp>/preview/llmrun`
- All routes 200: `/llmrun/`, `/llmrun/docs/`, all 5 guide pages, `llms.txt`, `llms-full.txt`, `api/search`, OG images, `llms.mdx` content.md, hero-terminal.svg, icons
- 404 works: `/llmrun/nope-404`
- Assets served under `/llmrun/` prefix correctly
- Content spot-checks: landing hero/features present, sidebar items present, getting-started Quick start + callout present

## Known Caveats

- `Base UI Tabs` content (code tabs) is not in static HTML; renders client-side. Acceptable for a docs site, but search engines won't index the hidden tab content.
