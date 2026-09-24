import { get } from 'svelte/store';
import { chatSettings } from '$lib/stores/chatSettingsStore';
import {
	activePDFKey,
	addChatHighlight,
	chatHighlights,
	deleteChatHighlight,
	updateChatHighlight
} from '$lib/stores/drawingStore';
import { chatLoadState, chatSessions, pendingSelection } from '$lib/stores/chatStore';
import { chatStorage } from '$lib/utils/chatStorage';
import { createChatController } from './chatController';
import { openDocument, openParsedDocument } from './documentParsing';
import { streamChat } from './openRouter';
import { createSummaryScheduler } from './summaryScheduler';

/** The app's conversation controller, wired to real storage and OpenRouter. */
export const chat = createChatController({
	storage: chatStorage,
	stream: streamChat,
	getSettings: () => get(chatSettings),
	getDocument: () => {
		const open = get(openDocument);
		return open ? { pdfKey: open.pdfKey, parsed: get(openParsedDocument) } : null;
	},
	highlights: {
		all: () => [...get(chatHighlights).values()].flat(),
		add: addChatHighlight,
		update: updateChatHighlight,
		remove: deleteChatHighlight
	}
});

/** Hover-card summaries: after an idle minute, or as soon as a new passage is selected. */
export const summaries = createSummaryScheduler({
	getSettings: () => get(chatSettings),
	stream: streamChat,
	getSession: async (id) => get(chatSessions).find((s) => s.id === id) ?? chatStorage.getSession(id),
	saveSession: async (session) => {
		chatSessions.update((list) => list.map((s) => (s.id === session.id ? session : s)));
		await chatStorage.putSession(session);
	},
	listMessages: (id) => chatStorage.listMessages(id),
	highlights: {
		all: () => [...get(chatHighlights).values()].flat(),
		update: updateChatHighlight
	}
});

if (typeof window !== 'undefined') {
	chat.answerCompleted.subscribe((event) => {
		if (event) void summaries.onAnswerComplete(event.sessionId);
	});
	// "A second selection is made and active": summarise what's pending now.
	pendingSelection.subscribe((selection) => {
		if (selection) summaries.onNewSelection();
	});
	activePDFKey.subscribe(() => summaries.reset());
	chatLoadState.subscribe((state) => {
		if (state === 'ready') void summaries.attach(get(chatSessions));
	});
}
