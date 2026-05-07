// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sfmd from '@string-os/astro-sfmd/integration';

export default defineConfig({
	site: 'https://docs.string-os.org',
	integrations: [
		sfmd({ contentDir: 'src/content/docs' }),
		starlight({
			title: 'String',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/string-os/string' },
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ slug: 'start/quickstart' },
						{ slug: 'start/agent-integration' },
						{ slug: 'start/writing-an-app' },
					],
				},
				{
					label: 'Runtime',
					items: [
						{ slug: 'runtime/overview' },
						{ slug: 'runtime/why' },
						{ slug: 'runtime/model' },
						{ slug: 'runtime/ai-loop' },
						{ slug: 'runtime/topics' },
						{ slug: 'runtime/navigation' },
						{ slug: 'runtime/actions' },
						{ slug: 'runtime/state' },
						{ slug: 'runtime/tools' },
						{ slug: 'runtime/packages' },
						{ slug: 'runtime/editing' },
						{ slug: 'runtime/authoring' },
						{ slug: 'runtime/shell' },
						{ slug: 'runtime/errors' },
					],
				},
				{
					label: 'SFMD Specification',
					items: [
						{ slug: 'sfmd/overview' },
						{ slug: 'sfmd/frontmatter' },
						{ slug: 'sfmd/blocks' },
						{ slug: 'sfmd/directives' },
						{ slug: 'sfmd/shortcuts' },
						{ slug: 'sfmd/actions' },
						{ slug: 'sfmd/variables' },
						{ slug: 'sfmd/trust' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ slug: 'reference/protocol' },
						{ slug: 'reference/transport' },
						{ slug: 'reference/response-format' },
					],
				},
				{
					label: 'Cookbook',
					link: 'https://github.com/string-os/cookbook',
				},
			],
		}),
	],
});
