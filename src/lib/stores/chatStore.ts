import { get, writable } from 'svelte/store';
import type { NormRect, TextAnchor } from '$lib/utils/textAnchor';
import {
	chatStorage,
	type ChatMessage,
	type ChatSession,
	type ChatStorageManager
} from '$lib/utils/chatStorage';
import { activePDFKey } from '$lib/stores/drawingStore';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sessions and messages for the current document
// ---------------------------------------------------------------------------

export type ChatLoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

/** Sessions for the current document, newest first. */
export const chatSessions = writable<ChatSession[]>([]);
/** Messages by session id. Loaded lazily, one session at a time. */
export const chatMessages = writable<Map<string, ChatMessage[]>>(new Map());
export const activeSessionId = writable<string | null>(null);
export const chatLoadState = writable<ChatLoadState>('idle');

let generation = 0;
let loadedPdfKey: string | null = null;
const messageLoads = new Map<string, Promise<void>>();

/**
 * Switch the chat state to another document. Sessions load eagerly; messages
 * wait until a session is opened, since a document with dozens of
 * conversations would otherwise pull megabytes on open.
 *
 * A generation counter discards out-of-order results: if the user opens A then
 * quickly B, a slow load for A must not land on top of B.
 */
export async function setChatPDFKey(
	pdfKey: string | null,
	storage: ChatStorageManager = chatStorage
): Promise<void> {
	if (pdfKey === loadedPdfKey && get(chatLoadState) !== 'idle') return;
	const g = ++generation;
	loadedPdfKey = pdfKey;

	chatSessions.set([]);
	chatMessages.set(new Map());
	activeSessionId.set(null);
	messageLoads.clear();

	if (!pdfKey) {
		chatLoadState.set('idle');
		return;
	}

	chatLoadState.set('loading');
	try {
		const sessions = await storage.listSessions(pdfKey);
		if (g !== generation) return;
		chatSessions.set(sessions);
		chatLoadState.set('ready');
	} catch (error) {
		if (g !== generation) return;
		console.warn('Chat history unavailable; conversations will not be saved:', error);
		chatLoadState.set('unavailable');
	}
}

/** Load a session's messages once; concurrent and repeat calls share the first load. */
export function ensureMessagesLoaded(
	sessionId: string,
	storage: ChatStorageManager = chatStorage
): Promise<void> {
	if (get(chatMessages).has(sessionId)) return Promise.resolve();
	const existing = messageLoads.get(sessionId);
	if (existing) return existing;

	const g = generation;
	const load = storage
		.listMessages(sessionId)
		.then((messages) => {
			if (g !== generation) return;
			chatMessages.update((map) => new Map(map).set(sessionId, messages));
		})
		.finally(() => {
			if (messageLoads.get(sessionId) === load) messageLoads.delete(sessionId);
		});
	messageLoads.set(sessionId, load);
	return load;
}

/** Test helper: reset module state between tests. */
export function resetChatStoreForTests() {
	generation++;
	loadedPdfKey = null;
	messageLoads.clear();
	chatSessions.set([]);
	chatMessages.set(new Map());
	activeSessionId.set(null);
	chatLoadState.set('idle');
	pendingSelection.set(null);
	askRequest.set(null);
}

// Follow document switches wherever they come from — upload, URL, template,
// .lpdf import, or the last PDF restored on startup.
if (typeof window !== 'undefined') {
	activePDFKey.subscribe((key) => {
		void setChatPDFKey(key);
	});
}
