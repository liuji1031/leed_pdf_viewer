<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { currentPageChatHighlights, type ChatHighlight } from '$lib/stores/drawingStore';
	import {
		clientPointToNormPoint,
		hitTestHighlights,
		normRectToDisplay,
		type RectLike
	} from '$lib/utils/textAnchor';
	import type { RotationAngle } from '$lib/utils/rotationUtils';

	export let scale: number;
	export let rotation: RotationAngle;
	export let basePageWidth: number;
	export let basePageHeight: number;
	export let canvasWidth: number;
	export let canvasHeight: number;

	const CARD_WIDTH = 260;
	const CARD_GAP = 12;
	// Enter delay so sweeping the mouse across the page doesn't flash cards.
	const HOVER_DELAY_MS = 120;
	const QUOTE_MAX = 140;

	let overlayEl: HTMLDivElement;
	let hovered: ChatHighlight | null = null;
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	// Whether the page leaves room for the card in its left margin.
	let cardInMargin = true;

	$: rendered = $currentPageChatHighlights.map((h) => {
		const rects = h.rects.map((r) =>
			normRectToDisplay(r, rotation, basePageWidth, basePageHeight, scale)
		);
		// The ordinal badge marks where the passage ends: the lowest line, rightmost.
		const last = rects.reduce<RectLike | null>(
			(a, b) =>
				!a || b.top > a.top + a.height / 2 || (Math.abs(b.top - a.top) < a.height / 2 && b.left > a.left)
					? b
					: a,
			null
		);
		return { h, rects, last };
	});

	// Keep the card pointing at live data if the highlight updates while hovered
	// (e.g. its summary arrives), and drop it if the highlight disappears.
	$: if (hovered) {
		hovered = $currentPageChatHighlights.find((h) => h.id === hovered!.id) ?? null;
	}

	$: hoveredRects = rendered.find((r) => r.h.id === hovered?.id)?.rects ?? [];
	$: cardTop = hoveredRects.length
		? Math.max(0, Math.min(Math.min(...hoveredRects.map((r) => r.top)), canvasHeight - 140))
		: 0;

	$: quote =
		hovered && hovered.anchor.text.length > QUOTE_MAX
			? `${hovered.anchor.text.slice(0, QUOTE_MAX).trimEnd()}…`
			: (hovered?.anchor.text ?? '');

	/*
	 * Hover is hit-tested from mouse events on the page wrapper rather than by
	 * making the highlights interactive. The highlights stay pointer-events:none,
	 * so they can never intercept drawing, pinching or text selection — and these
	 * listeners are passive: they never preventDefault or stopPropagation.
	 */
	function onMouseMove(event: MouseEvent) {
		const page = overlayEl?.getBoundingClientRect();
		const point =
			page &&
			clientPointToNormPoint(event.clientX, event.clientY, page, rotation, basePageWidth, basePageHeight);
		const hit = point ? hitTestHighlights(point, $currentPageChatHighlights) : null;

		if (hit?.id === hovered?.id) {
			clearTimeout(hoverTimer);
			hoverTimer = undefined;
			return;
		}
		clearTimeout(hoverTimer);
		if (!hit) {
			hovered = null;
			return;
		}
		hoverTimer = setTimeout(() => {
			hovered = hit;
			cardInMargin = hasMarginRoom();
		}, HOVER_DELAY_MS);
	}

	function onMouseLeave() {
		clearTimeout(hoverTimer);
		hovered = null;
	}

	/** Room to the left of the page, inside the viewer, for the card. */
	function hasMarginRoom(): boolean {
		const viewer = overlayEl?.closest('.pdf-viewer');
		if (!overlayEl || !viewer) return false;
		const space = overlayEl.getBoundingClientRect().left - viewer.getBoundingClientRect().left;
		return space >= CARD_WIDTH + CARD_GAP * 2;
	}

	let wrapper: HTMLElement | null = null;
	onMount(() => {
		// The page wrapper: everything over the page bubbles through it.
		wrapper = overlayEl.parentElement;
		wrapper?.addEventListener('mousemove', onMouseMove, { passive: true });
		wrapper?.addEventListener('mouseleave', onMouseLeave, { passive: true });
	});

	onDestroy(() => {
		clearTimeout(hoverTimer);
		wrapper?.removeEventListener('mousemove', onMouseMove);
		wrapper?.removeEventListener('mouseleave', onMouseLeave);
	});
</script>

<div
	bind:this={overlayEl}
	class="chat-highlight-overlay pointer-events-none absolute left-0 top-0"
	style="width: {canvasWidth}px; height: {canvasHeight}px;"
	aria-hidden="true"
>
	{#each rendered as { h, rects, last } (h.id)}
		{#each rects as r, i (i)}
			<div
				class="chat-highlight-rect absolute"
				class:hovered={hovered?.id === h.id}
				data-highlight-id={h.id}
				style="left: {r.left}px; top: {r.top}px; width: {r.width}px; height: {r.height}px;"
			></div>
		{/each}
		{#if last}
			<div
				class="chat-highlight-badge absolute"
				style="left: {last.left + last.width + 2}px; top: {last.top - 7}px;"
			>
				{h.ordinal}
			</div>
		{/if}
	{/each}
</div>

<!-- Margin note: to the left of the page, level with the highlight. -->
{#if hovered}
	<div
		class="chat-highlight-card pointer-events-none absolute rounded-lg border border-indigo-200 bg-white p-3 text-sm text-charcoal shadow-xl dark:border-indigo-500/40 dark:bg-gray-800 dark:text-gray-100"
		class:in-margin={cardInMargin}
		style="top: {cardTop}px; width: {CARD_WIDTH}px; {cardInMargin
			? `right: calc(100% + ${CARD_GAP}px);`
			: 'left: 8px;'}"
		role="tooltip"
		data-testid="chat-highlight-card"
	>
		<div class="mb-1 flex items-center gap-2 text-xs font-semibold text-indigo-600 dark:text-indigo-300">
			<span class="chat-highlight-badge static-badge">{hovered.ordinal}</span>
			{#if hovered.messageCount}
				<span>{hovered.messageCount} message{hovered.messageCount === 1 ? '' : 's'}</span>
			{/if}
		</div>
		{#if hovered.summaryStatus === 'ready' && hovered.summary}
			<p class="leading-snug">{hovered.summary}</p>
		{:else if hovered.summaryStatus === 'pending'}
			<p class="italic text-gray-500 dark:text-gray-400">Summarizing…</p>
		{/if}
		<p class="mt-1 border-l-2 border-indigo-300 pl-2 text-xs italic text-gray-600 dark:text-gray-300">
			“{quote}”
		</p>
		<p class="mt-2 text-[11px] text-gray-400">Double-click to open the conversation</p>
	</div>
{/if}

<style>
	.chat-highlight-overlay {
		/* Above the drawing canvas, below text boxes and notes; never interactive. */
		z-index: 3;
	}

	.chat-highlight-rect {
		background: rgb(99 102 241 / 0.16);
		border-bottom: 2px solid rgb(99 102 241 / 0.85);
		border-radius: 2px;
		mix-blend-mode: multiply;
		transition: background-color 120ms;
	}

	.chat-highlight-rect.hovered {
		background: rgb(99 102 241 / 0.3);
	}

	.chat-highlight-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 9999px;
		background: rgb(79 70 229);
		color: white;
		font-size: 9px;
		font-weight: 700;
		line-height: 1;
	}

	.static-badge {
		position: static;
	}

	.chat-highlight-card {
		z-index: 14;
	}
</style>
