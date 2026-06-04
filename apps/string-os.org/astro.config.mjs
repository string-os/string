// @ts-check
import { defineConfig } from 'astro/config';
import sfmd from '@string-os/astro-sfmd/integration';

export default defineConfig({
  site: 'https://string-os.org',
  build: {
    format: 'directory',
  },
  integrations: [
    sfmd({ contentDir: 'content', sidebar: false }),
  ],
});
