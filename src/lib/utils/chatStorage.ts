/**
 * IndexedDB persistence for the chat assistant.
 *
 * A database of its own rather than a new version of LeedPDFStorage: that
 * store's connection is cached without an onversionchange handler, so bumping
 * its version would let any other open tab block the upgrade — and its failure
 * mode is "the PDF won't load". The lifecycles differ too: uploaded files are
 * garbage-collected on a timer; transcripts must never be.
 */

export const CHAT_DB_NAME = 'LeedPDFChat';
const CHAT_DB_VERSION = 1;

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

		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			const req = this.factory!.open(this.dbName, CHAT_DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				// v1. Future versions add migrations here, keyed on event.oldVersion.
				const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
				sessions.createIndex('by_pdf', 'pdfKey');
				sessions.createIndex('by_pdf_created', ['pdfKey', 'createdAt']);
				sessions.createIndex('by_highlight', 'highlightId', { unique: true });
				sessions.createIndex('by_summary_state', ['pdfKey', 'summaryState']);

				const messages = db.createObjectStore('messages', { keyPath: 'id' });
				messages.createIndex('by_session_seq', ['sessionId', 'seq'], { unique: true });
				messages.createIndex('by_pdf', 'pdfKey');

				// Parsed-document cache for the chat context (one row per PDF). Created
				// now so adding the parser later doesn't need a schema upgrade.
				db.createObjectStore('documents', { keyPath: 'pdfKey' });
				db.createObjectStore('meta', { keyPath: 'key' });
			};
			req.onsuccess = () => {
				const db = req.result;
				// Step aside if another tab needs to upgrade the schema, instead of
				// blocking it indefinitely — the next call reopens at the new version.
				db.onversionchange = () => {
					db.close();
					this.db = null;
				};
				resolve(db);
			};
			req.onerror = () =>
				reject(new ChatStorageError('Could not open chat storage', { cause: req.error }));
			req.onblocked = () =>
				reject(new ChatStorageError('Chat storage upgrade is blocked by another open tab'));
		});

		this.db = opening;
		// Don't cache a failure — let the next call retry.
		opening.catch(() => {
			if (this.db === opening) this.db = null;
		});
		return opening;
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

	/** Test/maintenance helper: close the connection. */
	close() {
		this.db?.then((db) => db.close()).catch(() => {});
		this.db = null;
	}
}

export const chatStorage = new ChatStorageManager();
