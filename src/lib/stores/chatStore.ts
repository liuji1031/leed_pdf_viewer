import { writable } from 'svelte/store';
import type { NormRect, TextAnchor } from '$lib/utils/textAnchor';

/** A passage selected with the ask tool, captured as pure data. */
export interface PendingSelection {
	pageNumber: number;
	anchor: TextAnchor;
	rects: NormRect[];
}

/**
 * The passage currently selected for asking about. Captured eagerly when the
 * selection is made, so it outlives the DOM selection: it survives zoom and
 * rotation (rects are in rotation-0 storage space), page flips, and focus
 * moving elsewhere — clicking into a chat composer must not lose the quote.
 */
export const pendingSelection = writable<PendingSelection | null>(null);

/** A request to start a conversation about a selection. Consumed by the chat panel. */
export const askRequest = writable<(PendingSelection & { requestedAt: number }) | null>(null);

export function clearPendingSelection() {
	pendingSelection.set(null);
}

export function requestAsk(selection: PendingSelection) {
	askRequest.set({ ...selection, requestedAt: Date.now() });
}
