import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CHAT_DB_NAME,
	ChatStorageError,
	ChatStorageManager,
	type ChatMessage,
	type ChatSession
} from '../../../src/lib/utils/chatStorage';

let factory: IDBFactory;
let storage: ChatStorageManager;

function session(overrides: Partial<ChatSession> = {}): ChatSession {
	const id = overrides.id ?? `s-${Math.random().toString(36).slice(2)}`;
	return {
		id,
		pdfKey: 'paper.pdf_100',
		highlightId: `h-${id}`,
		pageNumber: 1,
		quotedText: 'scaled dot-product attention',
		title: 'scaled dot-product attention',
		createdAt: 1000,
		updatedAt: 1000,
		model: 'test/model',
		messageCount: 0,
		summaryState: 'idle',
		summaryAttempts: 0,
		...overrides
	};
}

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'sessionId' | 'seq'>): ChatMessage {
	return {
		id: `m-${overrides.sessionId}-${overrides.seq}`,
		pdfKey: 'paper.pdf_100',
		role: 'user',
		content: `message ${overrides.seq}`,
		createdAt: 1000 + overrides.seq,
		status: 'complete',
		...overrides
	};
}

beforeEach(() => {
	factory = new IDBFactory();
	storage = new ChatStorageManager(factory);
});

afterEach(() => {
	storage.close();
});

describe('ChatStorageManager', () => {
	it('creates the v1 schema', async () => {
		expect(await storage.isAvailable()).toBe(true);
		storage.close();

		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = factory.open(CHAT_DB_NAME);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		expect([...db.objectStoreNames].sort()).toEqual(['documents', 'messages', 'meta', 'sessions']);
		const tx = db.transaction(['sessions', 'messages']);
		expect([...tx.objectStore('sessions').indexNames].sort()).toEqual([
			'by_highlight',
			'by_pdf',
			'by_pdf_created',
			'by_summary_state'
		]);
		expect([...tx.objectStore('messages').indexNames].sort()).toEqual(['by_pdf', 'by_session_seq']);
		db.close();
	});

	describe('sessions', () => {
		it('round-trips a session', async () => {
			const s = session({ id: 'a' });
			await storage.putSession(s);
			expect(await storage.getSession('a')).toEqual(s);
			expect(await storage.getSession('missing')).toBeNull();
		});

		it('lists one document’s sessions, newest first', async () => {
			await storage.putSession(session({ id: 'old', createdAt: 1 }));
			await storage.putSession(session({ id: 'new', createdAt: 3 }));
			await storage.putSession(session({ id: 'mid', createdAt: 2 }));
			await storage.putSession(session({ id: 'other-doc', pdfKey: 'other.pdf_5', createdAt: 9 }));

			const ids = (await storage.listSessions('paper.pdf_100')).map((s) => s.id);
			expect(ids).toEqual(['new', 'mid', 'old']);
		});

		it('enforces one session per highlight', async () => {
			await storage.putSession(session({ id: 'a', highlightId: 'h1' }));
			await expect(storage.putSession(session({ id: 'b', highlightId: 'h1' }))).rejects.toBeInstanceOf(
				ChatStorageError
			);
			expect(await storage.getSession('b')).toBeNull();
		});
	});

	describe('messages', () => {
		it('returns a session’s messages in seq order', async () => {
			for (const seq of [3, 1, 2]) await storage.putMessage(message({ sessionId: 's1', seq }));
			await storage.putMessage(message({ sessionId: 's2', seq: 1 }));
			expect((await storage.listMessages('s1')).map((m) => m.seq)).toEqual([1, 2, 3]);
		});

		it('rejects a duplicate seq within a session', async () => {
			await storage.putMessage(message({ sessionId: 's1', seq: 1 }));
			await expect(
				storage.putMessage(message({ sessionId: 's1', seq: 1, id: 'different-id' }))
			).rejects.toBeInstanceOf(ChatStorageError);
		});

		it('settles messages left streaming by a reload: keeps content, drops empties', async () => {
			await storage.putMessage(message({ sessionId: 's1', seq: 1 }));
			await storage.putMessage(
				message({ sessionId: 's1', seq: 2, role: 'assistant', content: 'partial answ', status: 'streaming' })
			);
			await storage.putMessage(
				message({ sessionId: 's1', seq: 3, role: 'assistant', content: '', status: 'streaming' })
			);

			const listed = await storage.listMessages('s1');
			expect(listed.map((m) => [m.seq, m.status])).toEqual([
				[1, 'complete'],
				[2, 'complete']
			]);
			// And the fix-up was persisted, not just applied to the returned copy.
			const again = await storage.listMessages('s1');
			expect(again).toEqual(listed);
		});
	});

	describe('deletion', () => {
		it('deleting a session removes its messages and nothing else', async () => {
			await storage.putSession(session({ id: 's1' }));
			await storage.putSession(session({ id: 's2' }));
			for (const seq of [1, 2, 3]) await storage.putMessage(message({ sessionId: 's1', seq }));
			await storage.putMessage(message({ sessionId: 's2', seq: 1 }));

			await storage.deleteSession('s1');

			expect(await storage.getSession('s1')).toBeNull();
			expect(await storage.listMessages('s1')).toEqual([]);
			expect(await storage.getSession('s2')).not.toBeNull();
			expect(await storage.listMessages('s2')).toHaveLength(1);
		});

		it('clearing a document leaves other documents intact', async () => {
			await storage.putSession(session({ id: 'mine' }));
			await storage.putMessage(message({ sessionId: 'mine', seq: 1 }));
			await storage.putSession(session({ id: 'theirs', pdfKey: 'other.pdf_5' }));
			await storage.putMessage(message({ sessionId: 'theirs', seq: 1, pdfKey: 'other.pdf_5' }));

			await storage.deleteByPdfKey('paper.pdf_100');

			expect(await storage.listSessions('paper.pdf_100')).toEqual([]);
			expect(await storage.listMessages('mine')).toEqual([]);
			expect(await storage.listSessions('other.pdf_5')).toHaveLength(1);
			expect(await storage.listMessages('theirs')).toHaveLength(1);
		});
	});

	describe('availability', () => {
		it('reports unavailable, and rejects with a named error, without IndexedDB', async () => {
			const none = new ChatStorageManager(null);
			expect(await none.isAvailable()).toBe(false);
			await expect(none.listSessions('x')).rejects.toBeInstanceOf(ChatStorageError);
		});

		it('steps aside so another tab can upgrade the schema', async () => {
			await storage.isAvailable(); // hold an open v1 connection

			const upgraded = await new Promise<string>((resolve) => {
				const req = factory.open(CHAT_DB_NAME, 2);
				req.onsuccess = () => {
					req.result.close();
					resolve('upgraded');
				};
				req.onblocked = () => resolve('blocked');
				req.onerror = () => resolve('error');
			});
			expect(upgraded).toBe('upgraded');
		});
	});
});
