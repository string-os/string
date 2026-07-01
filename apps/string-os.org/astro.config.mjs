// @ts-check
import { defineConfig } from 'astro/config';
import sfmd from '@string-os/astro-sfmd/integration';

// App-scoped Vercel Web Analytics. The shared sfmd Base.astro owns <head> and has
// no head slot, so instead of touching the shared package (which every sfmd site
// uses) we inject the analytics client on every page of just this site.
/** @type {import('astro').AstroIntegration} */
const vercelWebAnalytics = {
  name: 'vercel-web-analytics',
  hooks: {
    'astro:config:setup': ({ injectScript }) => {
      injectScript('page', 'import { inject } from "@vercel/analytics"; inject();');
    },
  },
};

export default defineConfig({
  site: 'https://string-os.org',
  build: {
    format: 'directory',
  },
  integrations: [
    sfmd({ contentDir: 'content', sidebar: false }),
    vercelWebAnalytics,
  ],
});
