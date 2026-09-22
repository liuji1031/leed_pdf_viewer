import { sveltekit } from '@sveltejs/kit/vite';
import { enhancedImages } from '@sveltejs/enhanced-img';
import { defineConfig } from 'vite';

export const dropConsoleAndDebug = (import.meta.env?.VITE_BUILDING_TAURI === 'true') as boolean || !((import.meta.env?.VITE_DEV_MODE === 'true') as boolean)

export default defineConfig({
	plugins: [
		enhancedImages(),
		sveltekit()
	],
	optimizeDeps: {
		include: ['pdfjs-dist'],
		exclude: ['pdfjs-dist/build/pdf.worker.mjs']
	},
	worker: {
		format: 'es'
	},
	server: {
		// Bind all interfaces so the dev server is reachable when it runs inside
		// a container. Harmless outside one — Vite still serves on localhost.
		host: true,
		fs: {
			allow: ['..', 'node_modules/pdfjs-dist']
		},
		headers: {
			'Cache-Control': 'public, max-age=31536000',
		},
		hmr: {
			// The HMR websocket address is resolved by the *browser*, so in a
			// container it must be the host's address, not the container's.
			port: Number(process.env.VITE_HMR_PORT ?? 5173),
			host: process.env.VITE_HMR_HOST ?? 'localhost'
		}
	},
	build: {
		target: 'esnext',
		chunkSizeWarningLimit: 1000,
		assetsInlineLimit: 0,
		minify: 'terser',
		terserOptions: {
			compress: {
				drop_console: dropConsoleAndDebug,
				drop_debugger: dropConsoleAndDebug,
				dead_code: false,
				inline: false,
				join_vars: false
			},
			mangle: {
				keep_classnames: true,
				keep_fnames: true,
			reserved: []
			},
		}
	},
	assetsInclude: ['**/*.svg']
});
