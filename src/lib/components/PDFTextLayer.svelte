<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { PDFDocumentProxy } from 'pdfjs-dist';
	import type { TextLayer as PDFJSTextLayer } from 'pdfjs-dist';
	import type { RotationAngle } from '$lib/utils/rotationUtils';
	import { buildPageTextIndex, type PageTextIndex } from '$lib/utils/textAnchor';

	export let pdfDocument: PDFDocumentProxy | null;
	export let pageNumber: number;
	export let scale: number;
	export let rotation: RotationAngle;
	export let onIndexReady: ((idx: PageTextIndex, textDivs: HTMLElement[]) => void) | undefined =
		undefined;

	let containerEl: HTMLDivElement;
	let layer: PDFJSTextLayer | null = null;
	let builtFor = '';
	let buildToken = 0;

	// Rebuild only when the document, page or rotation changes. Zoom is a
	// CSS-variable update: pdf.js positions spans as percentages and sizes fonts
	// from --total-scale-factor, so a re-render would be wasted work.
	// The fingerprint matters: a different PDF at the same page and rotation
	// must still rebuild.
	$: key = pdfDocument ? `${pdfDocument.fingerprints[0]}:${pageNumber}:${rotation}` : '';
	$: if (containerEl && key !== builtFor) build();

	// Set the scale variable property-by-property. Binding a `style` attribute
	// instead makes Svelte rewrite the whole attribute on every zoom, wiping the
	// inline width/height pdf.js wrote in setLayerDimensions — invisible at 0°/180°
	// (inset:0 happens to give the same box) but it swaps the axes at 90°/270°.
	$: containerEl?.style.setProperty('--total-scale-factor', String(scale));

	async function build() {
		const token = ++buildToken;
		builtFor = key;
		cancel();
		window.getSelection()?.removeAllRanges();
		if (!pdfDocument) return;

		try {
			const [{ TextLayer }, page] = await Promise.all([
				import('pdfjs-dist'),
				pdfDocument.getPage(pageNumber)
			]);
			if (token !== buildToken) return;
			const viewport = page.getViewport({ scale, rotation });
			const textContent = await page.getTextContent();
			if (token !== buildToken) return;

			const next = new TextLayer({ textContentSource: textContent, container: containerEl, viewport });
			layer = next;
			await next.render();
			if (token !== buildToken) return;

			// pdf.js creates exactly one span per item that has `str` and none for
			// marked-content items, so this filter is index-aligned with textDivs.
			// It stops creating spans past MAX_TEXT_DIVS_TO_RENDER; truncate to match.
			const items = textContent.items
				.filter((item): item is typeof item & { str: string } => 'str' in item)
				.slice(0, next.textDivs.length)
				.map((item) => ({ str: item.str, hasEOL: 'hasEOL' in item ? item.hasEOL : false }));
			onIndexReady?.(buildPageTextIndex(pageNumber, items), next.textDivs);
		} catch (error) {
			// A superseded build is cancelled on purpose; anything else is worth knowing.
			if (token === buildToken) console.error('Text layer render failed:', error);
		}
	}

	function cancel() {
		layer?.cancel();
		layer = null;
		containerEl?.replaceChildren();
	}

	onDestroy(() => {
		buildToken++;
		cancel();
	});
</script>

<!--
	pdf.js owns this element's inline style: it writes width/height and
	data-main-rotation via setLayerDimensions. Never bind `style` here — see the
	setProperty call above.
-->
<div bind:this={containerEl} class="textLayer leed-text-layer"></div>

<style>
	/*
	 * Vendored from pdfjs-dist 5.7.284 web/pdf_viewer.css — only the rules the text
	 * layer needs. Importing the whole stylesheet would also pull in annotation
	 * layer, page container and editor styles and leak them into the app.
	 */
	.leed-text-layer {
		/* setLayerDimensions sizes the container with round(down, …, var(--scale-round-x)).
		   The pdf.js viewer defines these from JS; without them the width is invalid. */
		--scale-round-x: 1px;
		--scale-round-y: 1px;
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));

		position: absolute;
		inset: 0;
		overflow: clip;
		opacity: 1;
		line-height: 1;
		text-align: initial;
		-webkit-text-size-adjust: none;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		color-scheme: only light;
		/* Above every existing overlay; only mounted while the ask tool is active. */
		z-index: 11;
		user-select: text;
		-webkit-user-select: text;
	}

	/*
	 * TextLayer positions spans in UNROTATED page space and only tags the
	 * container with data-main-rotation; the rotation itself is this CSS. pdf.js
	 * ships these rules unscoped — scoped here so they can't reach anything else.
	 *
	 * The attribute is :global because pdf.js sets it at runtime. Svelte can't see
	 * it in the template, so a plain attribute selector is treated as unused and
	 * silently stripped from the compiled CSS — leaving rotated pages unrotated.
	 */
	.leed-text-layer:global([data-main-rotation='90']) {
		transform: rotate(90deg) translateY(-100%);
	}
	.leed-text-layer:global([data-main-rotation='180']) {
		transform: rotate(180deg) translate(-100%, -100%);
	}
	.leed-text-layer:global([data-main-rotation='270']) {
		transform: rotate(270deg) translateX(-100%);
	}

	.leed-text-layer :global(:is(span, br)) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
	}

	.leed-text-layer > :global(:not(.markedContent)),
	.leed-text-layer :global(.markedContent span:not(.markedContent)) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}

	.leed-text-layer :global(.markedContent) {
		display: contents;
	}

	.leed-text-layer :global(span[role='img']) {
		user-select: none;
		cursor: default;
	}

	.leed-text-layer :global(::selection) {
		background: rgb(99 102 241 / 0.35);
	}
</style>
