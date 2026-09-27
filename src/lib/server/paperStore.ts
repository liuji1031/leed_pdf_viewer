import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ParsedDocument } from '$lib/services/docParser/types';
import type { AnnotationPages, PaperImport } from '$lib/services/paperApi';
import type { ChatMessage, ChatSession } from '$lib/utils/chatStorage';

export type { AnnotationPages, PaperImport };

/**
 * Server-side storage for everything the app keeps per paper: the parsed
 * document, chat sessions and messages, and each annotation kind. One SQLite
 * file, so a paper opened in any browser pointed at this server finds it all.
 *
 * Rows are keyed like the browser stores (pdfKey is `${fileName}_${fileSize}`)
 * and hold the same JSON objects, so the client can swap storage backends
 * without translating records. Only the columns queries need are broken out.
 */

export interface PaperStore {
	getDocument(pdfKey: string): ParsedDocument | null;
	putDocument(doc: ParsedDocument): void;
	deleteDocument(pdfKey: string): void;

	/** Newest first. */
	listSessions(pdfKey: string): ChatSession[];
	getSession(id: string): ChatSession | null;
	putSession(session: ChatSession): void;
	/** The session and all of its messages, atomically. */
	deleteSession(id: string): void;
	/** In transcript order. */
	listMessages(sessionId: string): ChatMessage[];
	putMessage(message: ChatMessage): void;
	/** Every session and message for one paper. */
	deleteByPdfKey(pdfKey: string): void;

	getAnnotations(pdfKey: string): Record<string, AnnotationPages>;
	putAnnotations(pdfKey: string, kind: string, data: AnnotationPages): void;

	/** Adds what isn't stored yet; existing rows always win. */
	importMissing(data: PaperImport): { added: number };
	close(): void;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS documents (
		pdf_key TEXT PRIMARY KEY,
		data TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		pdf_key TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		data TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS sessions_by_pdf ON sessions (pdf_key, created_at);
	CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		pdf_key TEXT NOT NULL,
		seq INTEGER NOT NULL,
		data TEXT NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, seq);
	CREATE INDEX IF NOT EXISTS messages_by_pdf ON messages (pdf_key);
	CREATE TABLE IF NOT EXISTS annotations (
		pdf_key TEXT NOT NULL,
		kind TEXT NOT NULL,
		data TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (pdf_key, kind)
	);
`;

export function createPaperStore(db: DatabaseSync, now: () => number = Date.now): PaperStore {
	// wal lets readers carry on while a write commits; the busy timeout covers
	// two requests writing at the same moment.
	db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
	db.exec(SCHEMA);

	const q = {
		getDocument: db.prepare('SELECT data FROM documents WHERE pdf_key = ?'),
		putDocument: db.prepare(
			`INSERT INTO documents (pdf_key, data, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (pdf_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
		),
		addDocument: db.prepare('INSERT OR IGNORE INTO documents (pdf_key, data, updated_at) VALUES (?, ?, ?)'),
		deleteDocument: db.prepare('DELETE FROM documents WHERE pdf_key = ?'),

		listSessions: db.prepare('SELECT data FROM sessions WHERE pdf_key = ? ORDER BY created_at DESC, id DESC'),
		getSession: db.prepare('SELECT data FROM sessions WHERE id = ?'),
		putSession: db.prepare(
			`INSERT INTO sessions (id, pdf_key, created_at, data) VALUES (?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET pdf_key = excluded.pdf_key, created_at = excluded.created_at, data = excluded.data`
		),
		addSession: db.prepare('INSERT OR IGNORE INTO sessions (id, pdf_key, created_at, data) VALUES (?, ?, ?, ?)'),
		deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
		deleteSessionMessages: db.prepare('DELETE FROM messages WHERE session_id = ?'),

		listMessages: db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY seq'),
		putMessage: db.prepare(
			`INSERT INTO messages (id, session_id, pdf_key, seq, data) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, pdf_key = excluded.pdf_key,
			   seq = excluded.seq, data = excluded.data`
		),
		addMessage: db.prepare('INSERT OR IGNORE INTO messages (id, session_id, pdf_key, seq, data) VALUES (?, ?, ?, ?, ?)'),
		deletePdfSessions: db.prepare('DELETE FROM sessions WHERE pdf_key = ?'),
		deletePdfMessages: db.prepare('DELETE FROM messages WHERE pdf_key = ?'),

		getAnnotations: db.prepare('SELECT kind, data FROM annotations WHERE pdf_key = ?'),
		putAnnotations: db.prepare(
			`INSERT INTO annotations (pdf_key, kind, data, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (pdf_key, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
		),
		addAnnotations: db.prepare('INSERT OR IGNORE INTO annotations (pdf_key, kind, data, updated_at) VALUES (?, ?, ?, ?)')
	};

	const parse = <T>(row: unknown): T => JSON.parse((row as { data: string }).data) as T;

	function transaction<T>(fn: () => T): T {
		db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}

	return {
		getDocument(pdfKey) {
			const row = q.getDocument.get(pdfKey);
			return row ? parse<ParsedDocument>(row) : null;
		},
		putDocument(doc) {
			q.putDocument.run(doc.pdfKey, JSON.stringify(doc), now());
		},
		deleteDocument(pdfKey) {
			q.deleteDocument.run(pdfKey);
		},

		listSessions(pdfKey) {
			return q.listSessions.all(pdfKey).map((row) => parse<ChatSession>(row));
		},
		getSession(id) {
			const row = q.getSession.get(id);
			return row ? parse<ChatSession>(row) : null;
		},
		putSession(session) {
			q.putSession.run(session.id, session.pdfKey, session.createdAt, JSON.stringify(session));
		},
		deleteSession(id) {
			transaction(() => {
				q.deleteSession.run(id);
				q.deleteSessionMessages.run(id);
			});
		},
		listMessages(sessionId) {
			return q.listMessages.all(sessionId).map((row) => parse<ChatMessage>(row));
		},
		putMessage(message) {
			q.putMessage.run(message.id, message.sessionId, message.pdfKey, message.seq, JSON.stringify(message));
		},
		deleteByPdfKey(pdfKey) {
			transaction(() => {
				q.deletePdfSessions.run(pdfKey);
				q.deletePdfMessages.run(pdfKey);
			});
		},

		getAnnotations(pdfKey) {
			const out: Record<string, AnnotationPages> = {};
			for (const row of q.getAnnotations.all(pdfKey) as { kind: string; data: string }[]) {
				out[row.kind] = JSON.parse(row.data);
			}
			return out;
		},
		putAnnotations(pdfKey, kind, data) {
			q.putAnnotations.run(pdfKey, kind, JSON.stringify(data), now());
		},

		importMissing(data) {
			return transaction(() => {
				let added = 0;
				const t = now();
				for (const doc of data.documents ?? []) {
					added += Number(q.addDocument.run(doc.pdfKey, JSON.stringify(doc), t).changes);
				}
				for (const s of data.sessions ?? []) {
					added += Number(q.addSession.run(s.id, s.pdfKey, s.createdAt, JSON.stringify(s)).changes);
				}
				for (const m of data.messages ?? []) {
					added += Number(q.addMessage.run(m.id, m.sessionId, m.pdfKey, m.seq, JSON.stringify(m)).changes);
				}
				for (const a of data.annotations ?? []) {
					added += Number(q.addAnnotations.run(a.pdfKey, a.kind, JSON.stringify(a.data), t).changes);
				}
				return { added };
			});
		},

		close() {
			db.close();
		}
	};
}

let opened: { path: string; store: Promise<PaperStore> } | null = null;

/**
 * The store at `path` (PAPER_DB_PATH), opened once; null when unset, which
 * leaves the browser on its own storage. node:sqlite is loaded lazily so hosts
 * without it (or without a disk, like Vercel) never import it.
 */
export function getPaperStore(path: string | undefined): Promise<PaperStore> | null {
	const file = path?.trim();
	if (!file) return null;
	if (opened?.path === file) return opened.store;
	const store = import('node:sqlite').then(({ DatabaseSync }) => {
		if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
		return createPaperStore(new DatabaseSync(file));
	});
	// don't keep a failed open: the next request retries.
	store.catch(() => {
		if (opened?.store === store) opened = null;
	});
	opened = { path: file, store };
	return store;
}
