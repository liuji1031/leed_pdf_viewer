<script lang="ts">
	import SvelteMarkdown, { allowHtmlOnly } from '@humanspeak/svelte-markdown';
	import { KatexRenderer, markedKatex } from '@humanspeak/svelte-markdown/extensions';
	// Bundled rather than from a CDN, so math also renders offline (desktop build).
	import 'katex/dist/katex.min.css';

	export let source: string;

	// Model output is untrusted. The renderer already strips script URLs and
	// event handlers; on top of that, allow only the inline tags an answer about
	// a paper needs (MinerU text and model answers both use <sup>/<sub>).
	const renderers = {
		html: allowHtmlOnly(['strong', 'em', 'sup', 'sub', 'code', 'br', 'kbd', 'a']),
		inlineKatex: KatexRenderer,
		blockKatex: KatexRenderer
	};
	// The system prompt asks for $…$ inline math; this rule is whitespace-bounded,
	// so prices like "$5 and $10" don't turn into formulas.
	const extensions = [markedKatex({ singleDollarInline: true })];
</script>

<div class="chat-markdown prose prose-sm max-w-none dark:prose-invert">
	<!-- The library's renderer types don't cover extension renderers. -->
	<SvelteMarkdown {source} renderers={renderers as never} {extensions} />
</div>

<style>
	.chat-markdown :global(pre) {
		overflow-x: auto;
	}
	.chat-markdown :global(.katex-display) {
		overflow-x: auto;
		overflow-y: hidden;
	}
</style>
