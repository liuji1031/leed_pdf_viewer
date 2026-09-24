/**
 * IndexedDB persistence for the chat assistant.
 *
 * A database of its own rather than a new version of LeedPDFStorage: that
 * store's connection is cached without an onversionchange handler, so bumping
 * its version would let any other open tab block the upgrade — and its failure
 * mode is "the PDF won't load". The lifecycles differ too: uploaded files are
 * garbage-collected on a timer; transcripts must never be.
 */

import type { ParsedDocument } from '$lib/services/docParser/types';

export const CHAT_DB_NAME = 'LeedPDFChat';
const BLOCKED_TIMEOUT_MS = 10_000;

/**
 * The schema, declared rather than migrated step by step: on open, anything
 * missing is created. That also heals a database that exists without its
 * stores — e.g. one created by a bare indexedDB.open() elsewhere, which would
 * otherwise leave chat storage broken for good in that browser.
 */
const SCHEMA: Record<string, { keyPath: string; indexes: [string, string | string[], boolean?][] }> = {
	sessions: {
		keyPath: 'id',
		indexes: [
			['by_pdf', 'pdfKey'],
			['by_pdf_created', ['pdfKey', 'createdAt']],
			['by_highlight', 'highlightId', true],
			['by_summary_state', ['pdfKey', 'summaryState']]
		]
	},
	messages: {
		keyPath: 'id',
		indexes: [
			['by_session_seq', ['sessionId', 'seq'], true],
			['by_pdf', 'pdfKey']
		]
	},
	// Parsed-document cache for the chat context, one row per PDF.
	documents: { keyPath: 'pdfKey', indexes: [] },
	meta: { keyPath: 'key', indexes: [] }
};

function schemaComplete(db: IDBDatabase): boolean {
	const names = Object.keys(SCHEMA);
	if (!names.every((n) => db.objectStoreNames.contains(n))) return false;
	const tx = db.transaction(names);
	return names.every((n) => {
		const store = tx.objectStore(n);
		return SCHEMA[n].indexes.every(([index]) => store.indexNames.contains(index));
	});
}

function applySchema(db: IDBDatabase, tx: IDBTransaction) {
	for (const [name, def] of Object.entries(SCHEMA)) {
		const store = db.objectStoreNames.contains(name)
			? tx.objectStore(name)
			: db.createObjectStore(name, { keyPath: def.keyPath });
		for (const [index, keyPath, unique] of def.indexes) {
			if (!store.indexNames.contains(index)) store.createIndex(index, keyPath, { unique: !!unique });
		}
	}
}

export type SummaryState = 'idle' | 'armed' | 'generating' | 'ready' | 'failed' | 'skipped';

export interface ChatSession {
	id: string;
	/** Same key the annotation stores use: `${fileName}_${fileSize}`. */
	pdfKey: string;
	/** 1:1 with the highlight the conversation is anchored to. */
	highlightId: string;
	pageNumber: number;
	/** The selected passage, denormalised so prompts don't need a join. */
	quotedText: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	model: string;
	messageCount: number;
	summaryState: SummaryState;
	/** Epoch ms; persisted so a pending summary survives a reload. */
	summaryDueAt?: number;
	summaryAttempts: number;
	summary?: string;
	summaryError?: string;
	/**
	 * The passage's context (location, surrounding text, citations), frozen when
	 * the conversation started so every follow-up sends it byte-identically.
	 */
	contextSnapshot?: string;
	/** The parsed block the passage sits in; focuses the outline for huge papers. */
	focusBlockIdx?: number | null;
}

export type ChatRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'error';

export interface ChatMessage {
	id: string;
	sessionId: string;
	pdfKey: string;
	/** Monotonic per session; defines transcript order. */
	seq: number;
	role: ChatRole;
	content: string;
	createdAt: number;
	status: MessageStatus;
	usage?: { promptTokens: number; completionTokens: number };
}

export class ChatStorageError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ChatStorageError';
	}
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () =>
			reject(new ChatStorageError(req.error?.message ?? 'Request failed', { cause: req.error }));
	});
}

/**
 * Resolves when the transaction commits. On failure the cause is the failing
 * request's error: when the error event reaches the transaction, tx.error is
 * still null — it's only set once the transaction aborts.
 */
function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		let failure: DOMException | null = null;
		tx.oncomplete = () => resolve();
		tx.onerror = (event) => {
			failure ??= (event.target as IDBRequest | null)?.error ?? tx.error;
		};
		tx.onabort = () => {
			const cause = failure ?? tx.error;
			reject(new ChatStorageError(cause?.message ?? 'Transaction aborted', { cause }));
		};
	});
}

export class ChatStorageManager {
	private db: Promise<IDBDatabase> | null = null;

	/** Pass `null` for an environment without IndexedDB. */
	constructor(
		private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null,
		private readonly dbName = CHAT_DB_NAME
	) {}

	async isAvailable(): Promise<boolean> {
		if (!this.factory) return false;
		try {
			await this.open();
			return true;
		} catch {
			return false;
		}
	}

	private open(): Promise<IDBDatabase> {
		if (!this.factory) return Promise.reject(new ChatStorageError('IndexedDB is not available'));
		if (this.db) return this.db;

		const opening = this.openAt(undefined).then((db) => {
			if (schemaComplete(db)) return db;
			// Created elsewhere, or by an older build: upgrade once to fill the gaps.
			const next = db.version + 1;
			db.close();
			return this.openAt(next);
		});

		this.db = opening;
		// Don't cache a failure — let the next call retry.
		opening.catch(() => {
			if (this.db === opening) this.db = null;
		});
		return opening;
	}

	/** Open at a version (or the current one), applying the schema on upgrade. */
	private openAt(version: number | undefined): Promise<IDBDatabase> {
		return new Promise<IDBDatabase>((resolve, reject) => {
			let blockedTimer: ReturnType<typeof setTimeout> | undefined;
			const req =
				version === undefined ? this.factory!.open(this.dbName) : this.factory!.open(this.dbName, version);
			req.onupgradeneeded = () => applySchema(req.result, req.transaction!);
			req.onsuccess = () => {
				clearTimeout(blockedTimer);
				const db = req.result;
				// Step aside if another tab needs to upgrade the schema, instead of
				// blocking it indefinitely — the next call reopens at the new version.
				db.onversionchange = () => {
					db.close();
					this.db = null;
				};
				resolve(db);
			};
			req.onerror = () => {
				clearTimeout(blockedTimer);
				reject(new ChatStorageError('Could not open chat storage', { cause: req.error }));
			};
			// 'blocked' doesn't fail the request: it stays pending until the other
			// connections close, which ours do on versionchange. Only give up if a
			// connection that doesn't cooperate keeps holding on.
			req.onblocked = () => {
				blockedTimer ??= setTimeout(
					() => reject(new ChatStorageError('Chat storage upgrade is blocked by another open tab')),
					BLOCKED_TIMEOUT_MS
				);
			};
		});
	}

	async listSessions(pdfKey: string): Promise<ChatSession[]> {
		const db = await this.open();
		const index = db.transaction('sessions').objectStore('sessions').index('by_pdf_created');
		const range = IDBKeyRange.bound([pdfKey, -Infinity], [pdfKey, Infinity]);
		const sessions = await request<ChatSession[]>(index.getAll(range));
		return sessions.reverse(); // newest first
	}

	async getSession(id: string): Promise<ChatSession | null> {
		const db = await this.open();
		const session = await request<ChatSession | undefined>(
			db.transaction('sessions').objectStore('sessions').get(id)
		);
		return session ?? null;
	}

	async putSession(session: ChatSession): Promise<void> {
		const db = await this.open();
		const tx = db.transaction('sessions', 'readwrite');
		tx.objectStore('sessions').put(session);
		await transactionDone(tx);
	}

	/** Deletes the session and all of its messages, atomically. */
	async deleteSession(id: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(['sessions', 'messages'], 'readwrite');
		tx.objectStore('sessions').delete(id);
		const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
		const keys = await request(tx.objectStore('messages').index('by_session_seq').getAllKeys(range));
		for (const key of keys) tx.objectStore('messages').delete(key);
		await transactionDone(tx);
	}

	/**
	 * A session's messages in transcript order. A message still marked
	 * 'streaming' was cut off by a reload or crash: kept as complete if it has
	 * content, dropped if empty, so nothing looks live that isn't.
	 */
	async listMessages(sessionId: string): Promise<ChatMessage[]> {
		const db = await this.open();
		const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
		const messages = await request<ChatMessage[]>(
			db.transaction('messages').objectStore('messages').index('by_session_seq').getAll(range)
		);

		const stale = messages.filter((m) => m.status === 'streaming');
		if (stale.length === 0) return messages;

		const tx = db.transaction('messages', 'readwrite');
		const store = tx.objectStore('messages');
		for (const m of stale) {
			if (m.content) store.put({ ...m, status: 'complete' });
			else store.delete(m.id);
		}
		await transactionDone(tx);
		return messages
			.filter((m) => m.status !== 'streaming' || m.content)
			.map((m) => (m.status === 'streaming' ? { ...m, status: 'complete' as const } : m));
	}

	async putMessage(message: ChatMessage): Promise<void> {
		const db = await this.open();
		const tx = db.transaction('messages', 'readwrite');
		tx.objectStore('messages').put(message);
		await transactionDone(tx);
	}

	/** Removes every session and message for one document; other documents are untouched. */
	async deleteByPdfKey(pdfKey: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(['sessions', 'messages'], 'readwrite');
		for (const name of ['sessions', 'messages'] as const) {
			const store = tx.objectStore(name);
			const keys = await request(store.index('by_pdf').getAllKeys(IDBKeyRange.only(pdfKey)));
			for (const key of keys) store.delete(key);
		}
		await transactionDone(tx);
	}

	// -----------------------------------------------------------------------
	// Parsed-document cache
	// -----------------------------------------------------------------------

	async getDocument(pdfKey: string): Promise<ParsedDocument | null> {
		const db = await this.open();
		const doc = await request<ParsedDocument | undefined>(
			db.transaction('documents').objectStore('documents').get(pdfKey)
		);
		return doc ?? null;
	}

	async putDocument(doc: ParsedDocument): Promise<void> {
		const db = await this.open();
		const tx = db.transaction('documents', 'readwrite');
		tx.objectStore('documents').put(doc);
		await transactionDone(tx);
	}

	async deleteDocument(pdfKey: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction('documents', 'readwrite');
		tx.objectStore('documents').delete(pdfKey);
		await transactionDone(tx);
	}

	/** Test/maintenance helper: close the connection. */
	close() {
		this.db?.then((db) => db.close()).catch(() => {});
		this.db = null;
	}
}

export const chatStorage = new ChatStorageManager();
