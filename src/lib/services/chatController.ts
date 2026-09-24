import { get, writable, type Readable } from 'svelte/store';
import type { ChatHighlight } from '$lib/stores/drawingStore';
import type { ChatSettings } from '$lib/stores/chatSettingsStore';
import {
	activeSessionId,
	chatMessages,
	chatSessions,
	clearPendingSelection,
	type PendingSelection
} from '$lib/stores/chatStore';
import type { ChatMessage, ChatSession, ChatStorageManager } from '$lib/utils/chatStorage';
import { buildMessages, buildSessionContext } from './chatContext';
import type { ParsedDocument } from './docParser/types';
import { OpenRouterError, type StreamEvent, type StreamRequest } from './openRouter';

/**
 * Conversations: starting one from a selected passage, asking follow-ups,
 * streaming answers into the transcript and persisting everything.
 *
 * The highlight and the session are created when the first question is sent,
 * not when "Ask" is clicked — clicking and walking away leaves nothing behind.
 */

export type ChatErrorKind = 'no_api_key' | 'not_parsed' | 'no_document' | 'unknown_session' | 'busy';

export class ChatError extends Error {
	constructor(
		readonly kind: ChatErrorKind,
		message: string
	) {
		super(message);
		this.name = 'ChatError';
	}
}

export interface ChatControllerDeps {
	storage: Pick<ChatStorageManager, 'putSession' | 'putMessage' | 'getSession'>;
	stream: (req: StreamRequest) => AsyncGenerator<StreamEvent>;
	getSettings: () => ChatSettings;
	/** The open document's key and parsed content (null until parsed). */
	getDocument: () => { pdfKey: string; parsed: ParsedDocument | null } | null;
	highlights: {
		all(): ChatHighlight[];
		add(h: ChatHighlight): void;
		update(h: ChatHighlight): void;
	};
	now?: () => number;
	newId?: () => string;
	/** How often a streaming answer is written to storage. */
	persistIntervalMs?: number;
}

export interface SendOptions {
	/** Send the whole paper, not just the passage's surroundings. */
	wholePaper?: boolean;
	/** data: URL of the rendered page, for multimodal models. */
	pageImage?: string;
}

export interface ChatController {
	/** Sessions with an answer currently streaming. */
	generating: Readable<Set<string>>;
	/** Fires after each finished answer — the summary scheduler listens for it. */
	answerCompleted: Readable<{ sessionId: string; at: number } | null>;
	startConversation(selection: PendingSelection, question: string, options?: SendOptions): Promise<string>;
	sendMessage(sessionId: string, question: string, options?: SendOptions): Promise<void>;
	stop(sessionId: string): void;
}

const TITLE_MAX = 60;

function friendlyError(error: unknown): string {
	if (error instanceof OpenRouterError) {
		switch (error.kind) {
			case 'auth':
				return 'OpenRouter rejected the API key. Check it in chat settings.';
			case 'credits':
				return 'Your OpenRouter account is out of credits.';
			case 'rate_limit':
				return 'OpenRouter is rate-limiting requests. Try again in a moment.';
			case 'bad_request':
				return `The request was rejected: ${error.message}`;
			case 'network':
				return 'Could not reach OpenRouter. Check your connection.';
			case 'truncated':
				return 'The answer was cut off. Try asking again.';
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

export function createChatController(deps: ChatControllerDeps): ChatController {
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const persistEvery = deps.persistIntervalMs ?? 1000;

	const generating = writable<Set<string>>(new Set());
	const answerCompleted = writable<{ sessionId: string; at: number } | null>(null);
	const controllers = new Map<string, AbortController>();

	const messagesOf = (sessionId: string) => get(chatMessages).get(sessionId) ?? [];

	function setMessage(message: ChatMessage) {
		chatMessages.update((map) => {
			const list = map.get(message.sessionId) ?? [];
			const i = list.findIndex((m) => m.id === message.id);
			const next = i === -1 ? [...list, message] : list.map((m, j) => (j === i ? message : m));
			return new Map(map).set(message.sessionId, next);
		});
	}

	async function saveSession(session: ChatSession) {
		chatSessions.update((list) => {
			const rest = list.filter((s) => s.id !== session.id);
			return [session, ...rest].sort((a, b) => b.createdAt - a.createdAt);
		});
		await deps.storage.putSession(session);
	}

	function requireReady(): { pdfKey: string; parsed: ParsedDocument; settings: ChatSettings } {
		const settings = deps.getSettings();
		if (!settings.apiKey.trim()) {
			throw new ChatError('no_api_key', 'Add your OpenRouter API key in chat settings to ask questions.');
		}
		const open = deps.getDocument();
		if (!open) throw new ChatError('no_document', 'Open a document first.');
		if (!open.parsed) {
			throw new ChatError('not_parsed', 'This document is still being prepared. Try again once parsing finishes.');
		}
		return { pdfKey: open.pdfKey, parsed: open.parsed, settings };
	}

	async function startConversation(selection: PendingSelection, question: string, options: SendOptions = {}) {
		const { pdfKey, parsed, settings } = requireReady();
		const context = buildSessionContext(parsed, selection);
		const createdAt = now();
		const sessionId = newId();
		const highlightId = newId();
		const quotedText = selection.anchor.text;

		const ordinal = deps.highlights.all().reduce((max, h) => Math.max(max, h.ordinal), 0) + 1;
		deps.highlights.add({
			id: highlightId,
			pageNumber: selection.pageNumber,
			sessionId,
			rects: selection.rects,
			anchor: selection.anchor,
			createdAt,
			ordinal,
			summaryStatus: 'none',
			messageCount: 0
		});

		await saveSession({
			id: sessionId,
			pdfKey,
			highlightId,
			pageNumber: selection.pageNumber,
			quotedText,
			title: quotedText.length > TITLE_MAX ? `${quotedText.slice(0, TITLE_MAX).trimEnd()}…` : quotedText,
			createdAt,
			updatedAt: createdAt,
			model: settings.chatModel,
			messageCount: 0,
			summaryState: 'idle',
			summaryAttempts: 0,
			contextSnapshot: context.snapshot,
			focusBlockIdx: context.blockIdx
		});
		chatMessages.update((map) => new Map(map).set(sessionId, []));
		activeSessionId.set(sessionId);
		clearPendingSelection();

		await sendMessage(sessionId, question, options);
		return sessionId;
	}

	async function sendMessage(sessionId: string, question: string, options: SendOptions = {}) {
		const { parsed, settings } = requireReady();
		if (get(generating).has(sessionId)) throw new ChatError('busy', 'Still answering the last question.');
		const session =
			get(chatSessions).find((s) => s.id === sessionId) ?? (await deps.storage.getSession(sessionId));
		if (!session) throw new ChatError('unknown_session', 'That conversation no longer exists.');

		const prior = messagesOf(sessionId).filter((m) => m.status === 'complete' && m.role !== 'system');
		let seq = messagesOf(sessionId).reduce((max, m) => Math.max(max, m.seq), 0);

		const userMessage: ChatMessage = {
			id: newId(),
			sessionId,
			pdfKey: session.pdfKey,
			seq: ++seq,
			role: 'user',
			content: question,
			createdAt: now(),
			status: 'complete'
		};
		setMessage(userMessage);
		await deps.storage.putMessage(userMessage);

		const answer: ChatMessage = {
			id: newId(),
			sessionId,
			pdfKey: session.pdfKey,
			seq: ++seq,
			role: 'assistant',
			content: '',
			createdAt: now(),
			status: 'streaming'
		};
		setMessage(answer);

		const controller = new AbortController();
		controllers.set(sessionId, controller);
		generating.update((s) => new Set(s).add(sessionId));

		const messages = buildMessages({
			doc: parsed,
			session: {
				snapshot: session.contextSnapshot ?? '<context>\n</context>',
				quotedText: session.quotedText,
				focusBlockIdx: session.focusBlockIdx ?? null
			},
			history: prior.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
			question,
			wholePaper: options.wholePaper,
			pageImage: options.pageImage
		});

		let lastPersist = now();
		let current = answer;
		try {
			for await (const event of deps.stream({
				endpoint: settings.endpoint,
				apiKey: settings.apiKey,
				model: settings.chatModel,
				messages,
				signal: controller.signal
			})) {
				if (event.type === 'delta') {
					current = { ...current, content: current.content + event.text };
					setMessage(current);
					// Persist a streaming answer occasionally, so a reload loses little.
					if (now() - lastPersist >= persistEvery) {
						lastPersist = now();
						await deps.storage.putMessage(current);
					}
				} else if (event.type === 'done') {
					current = { ...current, status: 'complete', ...(event.usage && { usage: event.usage }) };
				}
			}
		} catch (error) {
			const stopped = error instanceof OpenRouterError && error.kind === 'aborted';
			current = stopped
				? // Keep what arrived; an empty stopped answer says so.
					{ ...current, status: 'complete', content: current.content || '_(stopped)_' }
				: { ...current, status: 'error', content: current.content ? `${current.content}\n\n` : '' };
			if (!stopped) current = { ...current, content: `${current.content}⚠️ ${friendlyError(error)}` };
		} finally {
			controllers.delete(sessionId);
			generating.update((s) => {
				const next = new Set(s);
				next.delete(sessionId);
				return next;
			});
		}

		setMessage(current);
		await deps.storage.putMessage(current);

		const messageCount = messagesOf(sessionId).length;
		await saveSession({ ...session, messageCount, updatedAt: now(), model: settings.chatModel });
		const highlight = deps.highlights.all().find((h) => h.id === session.highlightId);
		if (highlight) deps.highlights.update({ ...highlight, messageCount });

		if (current.status === 'complete') answerCompleted.set({ sessionId, at: now() });
	}

	function stop(sessionId: string) {
		controllers.get(sessionId)?.abort();
	}

	return {
		generating: { subscribe: generating.subscribe },
		answerCompleted: { subscribe: answerCompleted.subscribe },
		startConversation,
		sendMessage,
		stop
	};
}
