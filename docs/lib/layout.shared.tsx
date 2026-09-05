import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitHubUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            title: appName,
        },
        links: [
            { url: '/docs/guide/getting-started', text: 'Docs' },
            { url: 'https://www.npmjs.com/package/llmrun', text: 'npm', external: true },
        ],
        githubUrl: gitHubUrl,
    };
}
