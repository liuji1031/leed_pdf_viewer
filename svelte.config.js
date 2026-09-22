import vercelAdapter from '@sveltejs/adapter-vercel';
import nodeAdapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// adapter-vercel emits .vercel/output, which has no entrypoint a container can
// run. Setting ADAPTER=node switches to adapter-node for the Docker image.
// The default is unchanged, so Vercel deploys are unaffected.
const adapter = process.env.ADAPTER === 'node' ? nodeAdapter() : vercelAdapter();

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter
	}
};

export default config;
