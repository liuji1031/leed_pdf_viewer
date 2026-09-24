import { writable } from 'svelte/store';
import { askRequest } from './chatStore';

/** Chat panel layout state, remembered per browser. */

const OPEN_KEY = 'leedpdf_chat_panel_open';
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

export const chatPanelOpen = stored(OPEN_KEY, false, (raw) => raw === 'true');
export const chatPanelWidth = stored(WIDTH_KEY, CHAT_PANEL_DEFAULT_WIDTH, (raw) => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
});
export const chatSettingsOpen = writable(false);

export function toggleChatPanel() {
	chatPanelOpen.update((open) => !open);
}

// Clicking "Ask" on a selection opens the panel on that question.
askRequest.subscribe((request) => {
	if (request) chatPanelOpen.set(true);
});
