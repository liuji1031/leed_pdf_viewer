import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPaperStore, getPaperStore, type PaperStore } from '../../../src/lib/server/paperStore';
import type { ParsedDocument } from '../../../src/lib/services/docParser/types';
import type { ChatMessage, ChatSession } from '../../../src/lib/utils/chatStorage';

const KEY = '1706.03762_0';

function session(id: string, createdAt: number, pdfKey = KEY): ChatSession {
	return {
		id,
		pdfKey,
		highlightId: `h-${id}`,
		pageNumber: 1,
		quotedText: 'attention',
		title: 'attention',
		createdAt,
		updatedAt: createdAt,
		model: 'test/model',
		messageCount: 0,
		summaryState: 'idle',
		summaryAttempts: 0
	};
}

function message(sessionId: string, seq: number, pdfKey = KEY): ChatMessage {
	return {
		id: `${sessionId}-${seq}`,
		sessionId,
		pdfKey,
		seq,
		role: seq % 2 ? 'user' : 'assistant',
		content: `message ${seq}`,
		createdAt: seq,
		status: 'complete'
	};
}

const doc = (pdfKey = KEY, title = 'Attention Is All You Need') =>
	({
		schemaVersion: 1,
		pdfKey,
		parsedAt: 1,
		sourceFingerprint: 'fp-1',
		parser: { name: 'mineru', tier: 'standard' },
		pageCount: 15,
		title,
		blocks: [],
		outline: [],
		references: []
	}) satisfies ParsedDocument;

let store: PaperStore;

beforeEach(() => {
	store = createPaperStore(new DatabaseSync(':memory:'), () => 42);
});

describe('paper store', () => {
	it('keeps one parsed document per paper, replaced on put', () => {
		expect(store.getDocument(KEY)).toBeNull();
		store.putDocument(doc());
		store.putDocument(doc(KEY, 'Revised'));
		expect(store.getDocument(KEY)).toEqual(doc(KEY, 'Revised'));
		store.deleteDocument(KEY);
		expect(store.getDocument(KEY)).toBeNull();
	});

	it("lists a paper's sessions newest first, and only that paper's", () => {
		store.putSession(session('old', 1));
		store.putSession(session('new', 2));
		store.putSession(session('other', 3, 'other.pdf_9'));
		expect(store.listSessions(KEY).map((s) => s.id)).toEqual(['new', 'old']);
		store.putSession({ ...session('old', 1), title: 'renamed' });
		expect(store.getSession('old')?.title).toBe('renamed');
		expect(store.getSession('missing')).toBeNull();
	});

	it('returns messages in transcript order and upserts by id', () => {
		store.putMessage(message('s', 2));
		store.putMessage(message('s', 1));
		store.putMessage({ ...message('s', 2), content: 'streamed more' });
		expect(store.listMessages('s').map((m) => [m.seq, m.content])).toEqual([
			[1, 'message 1'],
			[2, 'streamed more']
		]);
	});

	it('rejects a second message at the same position in a session', () => {
		store.putMessage(message('s', 1));
		expect(() => store.putMessage({ ...message('s', 1), id: 'different' })).toThrow(/constraint/i);
	});

	it('deletes a session with its messages, or everything for a paper', () => {
		store.putSession(session('a', 1));
		store.putSession(session('b', 2));
		store.putSession(session('keep', 3, 'other.pdf_9'));
		store.putMessage(message('a', 1));
		store.putMessage(message('b', 1));
		store.putMessage(message('keep', 1, 'other.pdf_9'));

		store.deleteSession('a');
		expect(store.getSession('a')).toBeNull();
		expect(store.listMessages('a')).toEqual([]);
		expect(store.listMessages('b')).toHaveLength(1);

		store.deleteByPdfKey(KEY);
		expect(store.listSessions(KEY)).toEqual([]);
		expect(store.listMessages('b')).toEqual([]);
		expect(store.listSessions('other.pdf_9')).toHaveLength(1);
		expect(store.listMessages('keep')).toHaveLength(1);
	});

	it('keeps each annotation kind separately per paper', () => {
		store.putAnnotations(KEY, 'drawings', { '1': [{ id: 'd1' }] });
		store.putAnnotations(KEY, 'stickyNotes', { '2': [{ id: 'n1' }] });
		store.putAnnotations(KEY, 'drawings', { '1': [{ id: 'd1' }, { id: 'd2' }] });
		expect(store.getAnnotations(KEY)).toEqual({
			drawings: { '1': [{ id: 'd1' }, { id: 'd2' }] },
			stickyNotes: { '2': [{ id: 'n1' }] }
		});
		expect(store.getAnnotations('other.pdf_9')).toEqual({});
	});

	it('imports only what is missing, so data already on the server wins', () => {
		store.putDocument(doc(KEY, 'On the server'));
		store.putSession({ ...session('s', 1), title: 'server title' });
		store.putAnnotations(KEY, 'drawings', { '1': [{ id: 'server' }] });

		const { added } = store.importMissing({
			documents: [doc(KEY, 'From a browser'), doc('other.pdf_9')],
			sessions: [{ ...session('s', 1), title: 'browser title' }, session('t', 2)],
			messages: [message('t', 1)],
			annotations: [
				{ pdfKey: KEY, kind: 'drawings', data: { '1': [{ id: 'browser' }] } },
				{ pdfKey: KEY, kind: 'arrows', data: { '3': [{ id: 'a1' }] } }
			]
		});

		expect(added).toBe(4);
		expect(store.getDocument(KEY)?.title).toBe('On the server');
		expect(store.getDocument('other.pdf_9')).not.toBeNull();
		expect(store.getSession('s')?.title).toBe('server title');
		expect(store.listMessages('t')).toHaveLength(1);
		expect(store.getAnnotations(KEY)).toEqual({
			drawings: { '1': [{ id: 'server' }] },
			arrows: { '3': [{ id: 'a1' }] }
		});
	});

	it('is disabled without a path, and opened once per path', async () => {
		expect(getPaperStore(undefined)).toBeNull();
		expect(getPaperStore('  ')).toBeNull();
		const first = getPaperStore(':memory:');
		expect(getPaperStore(':memory:')).toBe(first);
		(await first!).putDocument(doc());
		expect((await getPaperStore(':memory:')!).getDocument(KEY)).not.toBeNull();
	});
});
