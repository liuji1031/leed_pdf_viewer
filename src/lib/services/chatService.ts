import { get } from 'svelte/store';
import { chatSettings } from '$lib/stores/chatSettingsStore';
import { addChatHighlight, chatHighlights, updateChatHighlight } from '$lib/stores/drawingStore';
import { chatStorage } from '$lib/utils/chatStorage';
import { createChatController } from './chatController';
import { openDocument, openParsedDocument } from './documentParsing';
import { streamChat } from './openRouter';

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
		update: updateChatHighlight
	}
});
