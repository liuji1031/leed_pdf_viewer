import type { ParsedDocument } from './docParser/types';
import type { ChatMessage, ChatSession, ChatStorage } from '$lib/utils/chatStorage';
import { ChatStorageError } from '$lib/utils/chatStorage';

/**
 * Client for the server's paper store (/api/papers), which keeps each paper's
 * parse, chats and annotations in one database shared by every browser.
 */

export const PAPERS_API = '/api/papers';

/** Annotations of one kind for one paper: page number → items. */
export type AnnotationPages = Record<string, unknown[]>;

export interface PaperImport {
	documents?: ParsedDocument[];
	sessions?: ChatSession[];
	messages?: ChatMessage[];
	annotations?: { pdfKey: string; kind: string; data: AnnotationPages }[];
}

export class PaperApi {
	private enabledProbe: Promise<boolean> | null = null;
	private enabledResult: boolean | undefined;

	/** The answer to `enabled()` once known; undefined while the first probe is out. */
	get knownEnabled(): boolean | undefined {
		return this.enabledResult;
	}

	constructor(
		private readonly base = PAPERS_API,
		private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
	) {}

	/**
	 * Whether this server stores papers. Asked once per page load; a server
	 * without the route (the desktop build, a static host) counts as no.
	 */
	enabled(): Promise<boolean> {
		this.enabledProbe ??= Promise.resolve()
			.then(() => this.fetchImpl(`${this.base}/status`))
			.then(async (res) => res.ok && (await res.json())?.enabled === true)
			.catch(() => false)
			.then((enabled) => (this.enabledResult = enabled));
		return this.enabledProbe;
	}

	private async call<T>(method: string, route: string, query: Record<string, string>, body?: unknown, keepalive = false) {
		const url = `${this.base}/${route}?${new URLSearchParams(query)}`;
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
				...(keepalive && { keepalive: true })
			});
		} catch (error) {
			throw new ChatStorageError('Could not reach paper storage', { cause: error });
		}
		if (!res.ok) {
			let message = `${res.status} ${res.statusText}`.trim();
			try {
				message = (await res.json())?.error?.message ?? message;
			} catch {
				// not json — keep the status line.
			}
			throw new ChatStorageError(`Paper storage: ${message}`);
		}
		return (await res.json()) as T;
	}

	getDocument = (pdfKey: string) => this.call<ParsedDocument | null>('GET', 'document', { key: pdfKey });
	putDocument = (doc: ParsedDocument) => this.call<unknown>('PUT', 'document', {}, doc).then(() => {});
	deleteDocument = (pdfKey: string) => this.call<unknown>('DELETE', 'document', { key: pdfKey }).then(() => {});

	listSessions = (pdfKey: string) => this.call<ChatSession[]>('GET', 'sessions', { key: pdfKey });
	deleteByPdfKey = (pdfKey: string) => this.call<unknown>('DELETE', 'sessions', { key: pdfKey }).then(() => {});
	getSession = (id: string) => this.call<ChatSession | null>('GET', 'session', { id });
	putSession = (session: ChatSession) => this.call<unknown>('PUT', 'session', {}, session).then(() => {});
	deleteSession = (id: string) => this.call<unknown>('DELETE', 'session', { id }).then(() => {});
	listMessages = (sessionId: string) => this.call<ChatMessage[]>('GET', 'messages', { session: sessionId });
	putMessage = (message: ChatMessage) => this.call<unknown>('PUT', 'message', {}, message).then(() => {});

	getAnnotations = (pdfKey: string) => this.call<Record<string, AnnotationPages>>('GET', 'annotations', { key: pdfKey });
	/** `keepalive` lets the save finish while the page is closing (small bodies only). */
	putAnnotations = (pdfKey: string, kind: string, data: AnnotationPages, options: { keepalive?: boolean } = {}) =>
		this.call<unknown>('PUT', 'annotations', { key: pdfKey, kind }, data, options.keepalive).then(() => {});

	importMissing = (data: PaperImport) => this.call<{ added: number }>('POST', 'import', {}, data);
}

/** Chat and parse storage on the server, with the same behaviour as the IndexedDB store. */
export class ServerChatStorage implements ChatStorage {
	constructor(private readonly api: PaperApi) {}

	isAvailable = () => this.api.enabled();
	listSessions = (pdfKey: string) => this.api.listSessions(pdfKey);
	getSession = (id: string) => this.api.getSession(id);
	putSession = (session: ChatSession) => this.api.putSession(session);
	deleteSession = (id: string) => this.api.deleteSession(id);
	putMessage = (message: ChatMessage) => this.api.putMessage(message);
	deleteByPdfKey = (pdfKey: string) => this.api.deleteByPdfKey(pdfKey);
	getDocument = (pdfKey: string) => this.api.getDocument(pdfKey);
	putDocument = (doc: ParsedDocument) => this.api.putDocument(doc);
	deleteDocument = (pdfKey: string) => this.api.deleteDocument(pdfKey);

	/**
	 * A message still marked 'streaming' was cut off mid-answer: shown as
	 * complete if it has content, hidden if empty. Unlike the local store this
	 * doesn't write the fix back — another browser may be streaming it right now.
	 */
	async listMessages(sessionId: string): Promise<ChatMessage[]> {
		const messages = await this.api.listMessages(sessionId);
		return messages
			.filter((m) => m.status !== 'streaming' || m.content)
			.map((m) => (m.status === 'streaming' ? { ...m, status: 'complete' as const } : m));
	}
}

export const paperApi = new PaperApi();
