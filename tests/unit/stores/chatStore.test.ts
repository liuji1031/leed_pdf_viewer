import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	chatLoadState,
	chatMessages,
	chatSessions,
	ensureMessagesLoaded,
	resetChatStoreForTests,
	setChatPDFKey
} from '../../../src/lib/stores/chatStore';
import { setCurrentPDF } from '../../../src/lib/stores/drawingStore';
import {
	chatStorage,
	type ChatMessage,
	type ChatSession,
	type ChatStorageManager
} from '../../../src/lib/utils/chatStorage';

function session(id: string, pdfKey: string): ChatSession {
	return {
		id,
		pdfKey,
		highlightId: `h-${id}`,
		pageNumber: 1,
		quotedText: id,
		title: id,
		createdAt: 1,
		updatedAt: 1,
		model: 'm',
		messageCount: 0,
		summaryState: 'idle',
		summaryAttempts: 0
	};
}

/** A storage double whose loads resolve only when the test says so. */
function controllableStorage() {
	const pending = new Map<string, (sessions: ChatSession[]) => void>();
	const listMessages = vi.fn(async (sessionId: string): Promise<ChatMessage[]> => [
		{
			id: `${sessionId}-1`,
			sessionId,
			pdfKey: 'k',
			seq: 1,
			role: 'user',
			content: 'hi',
			createdAt: 1,
			status: 'complete'
		}
	]);
	const storage = {
		listSessions: vi.fn((pdfKey: string) => new Promise<ChatSession[]>((r) => pending.set(pdfKey, r))),
		listMessages
	} as unknown as ChatStorageManager;
	return { storage, resolve: (pdfKey: string, s: ChatSession[]) => pending.get(pdfKey)!(s), listMessages };
}

beforeEach(() => {
	resetChatStoreForTests();
});

afterEach(() => {
	resetChatStoreForTests();
});

describe('chatStore document switching', () => {
	it('loads the document’s sessions', async () => {
		const { storage, resolve } = controllableStorage();
		const done = setChatPDFKey('a.pdf_1', storage);
		expect(get(chatLoadState)).toBe('loading');
		resolve('a.pdf_1', [session('s1', 'a.pdf_1')]);
		await done;
		expect(get(chatLoadState)).toBe('ready');
		expect(get(chatSessions).map((s) => s.id)).toEqual(['s1']);
	});

	it('ignores a slow load for a document the user already left', async () => {
		const { storage, resolve } = controllableStorage();
		const loadA = setChatPDFKey('a.pdf_1', storage);
		const loadB = setChatPDFKey('b.pdf_2', storage);

		resolve('b.pdf_2', [session('from-b', 'b.pdf_2')]);
		await loadB;
		resolve('a.pdf_1', [session('from-a', 'a.pdf_1')]); // arrives late
		await loadA;

		expect(get(chatSessions).map((s) => s.id)).toEqual(['from-b']);
		expect(get(chatLoadState)).toBe('ready');
	});

	it('clears everything when no document is open', async () => {
		const { storage, resolve } = controllableStorage();
		const load = setChatPDFKey('a.pdf_1', storage);
		resolve('a.pdf_1', [session('s1', 'a.pdf_1')]);
		await load;

		await setChatPDFKey(null, storage);
		expect(get(chatSessions)).toEqual([]);
		expect(get(chatLoadState)).toBe('idle');
	});

	it('degrades to "unavailable" instead of throwing when storage fails', async () => {
		const broken = {
			listSessions: vi.fn().mockRejectedValue(new Error('quota'))
		} as unknown as ChatStorageManager;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(setChatPDFKey('a.pdf_1', broken)).resolves.toBeUndefined();
		expect(get(chatLoadState)).toBe('unavailable');
		warn.mockRestore();
	});

	it('does not reload when the same document is set again', async () => {
		const { storage, resolve } = controllableStorage();
		const load = setChatPDFKey('a.pdf_1', storage);
		resolve('a.pdf_1', []);
		await load;
		await setChatPDFKey('a.pdf_1', storage);
		expect(storage.listSessions).toHaveBeenCalledTimes(1);
	});
});

describe('chatStore lazy message loading', () => {
	it('loads a session’s messages once, sharing concurrent calls', async () => {
		const { storage, resolve, listMessages } = controllableStorage();
		const load = setChatPDFKey('a.pdf_1', storage);
		resolve('a.pdf_1', [session('s1', 'a.pdf_1')]);
		await load;

		await Promise.all([ensureMessagesLoaded('s1', storage), ensureMessagesLoaded('s1', storage)]);
		await ensureMessagesLoaded('s1', storage);

		expect(listMessages).toHaveBeenCalledTimes(1);
		expect(get(chatMessages).get('s1')?.map((m) => m.content)).toEqual(['hi']);
	});

	it('drops a message load that finishes after a document switch', async () => {
		const { storage, resolve } = controllableStorage();
		const load = setChatPDFKey('a.pdf_1', storage);
		resolve('a.pdf_1', [session('s1', 'a.pdf_1')]);
		await load;

		const messages = ensureMessagesLoaded('s1', storage);
		void setChatPDFKey('b.pdf_2', storage);
		await messages;
		expect(get(chatMessages).has('s1')).toBe(false);
	});
});

describe('chatStore follows the open document', () => {
	it('loads sessions from storage whenever setCurrentPDF switches document', async () => {
		await chatStorage.putSession(session('stored', 'paper.pdf_4242'));

		setCurrentPDF('paper.pdf', 4242);

		await vi.waitFor(() => expect(get(chatLoadState)).toBe('ready'));
		expect(get(chatSessions).map((s) => s.id)).toEqual(['stored']);
	});
});
