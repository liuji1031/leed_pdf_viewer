import { writable } from 'svelte/store';
import { askRequest } from './chatStore';
import { drawingState } from './drawingStore';

/**
 * Chat panel layout state. The width is remembered per browser; whether the
 * panel is open follows the ask tool: it opens when the tool is chosen and
 * closes when another tool is.
 */

const WIDTH_KEY = 'leedpdf_chat_panel_width';

export const CHAT_PANEL_MIN_WIDTH = 300;
export const CHAT_PANEL_DEFAULT_WIDTH = 400;

export function clampPanelWidth(width: number, viewportWidth: number): number {
	const max = Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(900, Math.round(viewportWidth * 0.6)));
	return Math.round(Math.min(max, Math.max(CHAT_PANEL_MIN_WIDTH, width)));
}

function stored<T>(key: string, fallback: T, parse: (raw: string) => T | undefined) {
	let initial = fallback;
	if (typeof window !== 'undefined') {
		try {
			const raw = localStorage.getItem(key);
			if (raw !== null) initial = parse(raw) ?? fallback;
		} catch {
			// storage unavailable: use the default
		}
	}
	const store = writable<T>(initial);
	store.subscribe((value) => {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(key, String(value));
		} catch {
			// not critical
		}
	});
	return store;
}

export const chatPanelOpen = writable(false);
export const chatPanelWidth = stored(WIDTH_KEY, CHAT_PANEL_DEFAULT_WIDTH, (raw) => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
});
export const chatSettingsOpen = writable(false);

// only a change of tool opens or closes the panel, so other drawing-state
// updates (color, line width) leave it as the user left it.
let lastTool: string | undefined;
drawingState.subscribe(({ tool }) => {
	if (tool === lastTool) return;
	const entering = tool === 'ask';
	const leaving = lastTool === 'ask';
	lastTool = tool;
	if (entering) chatPanelOpen.set(true);
	else if (leaving) chatPanelOpen.set(false);
});

// clicking "Ask" on a selection opens the panel on that question.
askRequest.subscribe((request) => {
	if (request) chatPanelOpen.set(true);
});
