<script lang="ts">
	import { MessageSquareQuote } from 'lucide-svelte';
	import { pendingSelection, requestAsk } from '$lib/stores/chatStore';
	import { normRectToDisplay } from '$lib/utils/textAnchor';
	import type { RotationAngle } from '$lib/utils/rotationUtils';

	export let pageNumber: number;
	export let scale: number;
	export let rotation: RotationAngle;
	export let basePageWidth: number;
	export let basePageHeight: number;
	export let canvasWidth: number;
	export let canvasHeight: number;

	const QUOTE_MAX = 48;
	const CHIP_HEIGHT = 32;
	const GAP = 6;

	// Rendered from stored rects, not the live DOM selection: it follows zoom and
	// rotation, and stays put after the native selection is gone.
	$: selection = $pendingSelection?.pageNumber === pageNumber ? $pendingSelection : null;
	$: rects = selection
		? selection.rects.map((r) => normRectToDisplay(r, rotation, basePageWidth, basePageHeight, scale))
		: [];

	$: quote = selection
		? selection.anchor.text.length > QUOTE_MAX
			? `${selection.anchor.text.slice(0, QUOTE_MAX).trimEnd()}…`
			: selection.anchor.text
		: '';

	// Below the lowest line of the selection; above the highest if that would
	// run off the bottom of the page.
	$: chipPosition = (() => {
		if (rects.length === 0) return null;
		const lowest = rects.reduce((a, b) => (b.top + b.height > a.top + a.height ? b : a));
		const highest = rects.reduce((a, b) => (b.top < a.top ? b : a));
		const below = lowest.top + lowest.height + GAP;
		const top = below + CHIP_HEIGHT <= canvasHeight ? below : Math.max(0, highest.top - CHIP_HEIGHT - GAP);
		const anchorRect = top === below ? lowest : highest;
		return { left: Math.max(0, Math.min(anchorRect.left, canvasWidth - 40)), top };
	})();

	function ask() {
		if (selection) requestAsk(selection);
	}
</script>

{#if selection && chipPosition}
	<div class="ask-selection pointer-events-none absolute inset-0" aria-hidden="true">
		{#each rects as r, i (i)}
			<div
				class="ask-selection-rect absolute"
				style="left: {r.left}px; top: {r.top}px; width: {r.width}px; height: {r.height}px;"
			></div>
		{/each}
	</div>

	<!--
		mousedown is prevented so clicking the chip doesn't clear the native
		selection; pointerdown stops at the chip so a touch can't start a page pan.
	-->
	<button
		type="button"
		class="ask-chip absolute flex items-center gap-1.5 rounded-full bg-sage px-3 text-sm font-medium text-white shadow-lg hover:brightness-110"
		style="left: {chipPosition.left}px; top: {chipPosition.top}px; height: {CHIP_HEIGHT}px;"
		on:mousedown|preventDefault
		on:pointerdown|stopPropagation
		on:click={ask}
		aria-label={`Ask about "${selection.anchor.text}"`}
		data-testid="ask-selection-chip"
	>
		<MessageSquareQuote size={14} />
		<span class="ask-chip-quote">Ask about “{quote}”</span>
	</button>
{/if}

<style>
	.ask-selection {
		z-index: 12;
	}

	.ask-selection-rect {
		background: rgb(99 102 241 / 0.12);
		border-bottom: 2px dashed rgb(99 102 241 / 0.7);
		border-radius: 2px;
	}

	.ask-chip {
		z-index: 13;
		max-width: 22rem;
		white-space: nowrap;
	}

	.ask-chip-quote {
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
