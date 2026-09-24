import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatError, createChatController } from '../../../src/lib/services/chatController';
import { structuredContentToDocument } from '../../../src/lib/services/docParser/mineruContent';
import { OpenRouterError, type StreamEvent, type StreamRequest } from '../../../src/lib/services/openRouter';
import { ChatStorageManager } from '../../../src/lib/utils/chatStorage';
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '../../../src/lib/stores/chatSettingsStore';
import {
	activeSessionId,
	chatMessages,
	chatSessions,
	pendingSelection,
	resetChatStoreForTests,
	type PendingSelection
} from '../../../src/lib/stores/chatStore';
import type { ChatHighlight } from '../../../src/lib/stores/drawingStore';

const paper = structuredContentToDocument(
	JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/mineru/synthetic-paper.structured_content.json'), 'utf8')),
	'paper.pdf_1'
);
const scaled = paper.blocks.find((b) => b.text.startsWith('Scaled dot-product attention divides'))!;

const selection: PendingSelection = {
	pageNumber: 2,
	rects: [{ x: scaled.bbox!.x + 0.01, y: scaled.bbox!.y + 0.005, w: 0.2, h: 0.01 }],
	anchor: {
		pageNumber: 2,
		text: 'divides the logits by the square root of the key dimension',
		charStart: 0,
		charEnd: 10,
		itemStart: 0,
		itemEnd: 0,
		prefix: '',
		suffix: '',
		textHash: 'x'
	}
};

/** A scripted OpenRouter stream: yields the chunks, or throws after them. */
function scriptedStream(script: { chunks: string[]; error?: Error; hangAfter?: number }[]) {
	const requests: StreamRequest[] = [];
	let call = 0;
	const stream = async function* (req: StreamRequest): AsyncGenerator<StreamEvent> {
		requests.push(req);
		const { chunks, error, hangAfter } = script[Math.min(call++, script.length - 1)];
		for (const [i, text] of chunks.entries()) {
			if (hangAfter !== undefined && i === hangAfter) {
				await new Promise((_, reject) =>
					req.signal?.addEventListener('abort', () => reject(new OpenRouterError('aborted', 'stopped')))
				);
			}
			yield { type: 'delta', text };
		}
		if (error) throw error;
		yield { type: 'done', usage: { promptTokens: 100, completionTokens: chunks.length } };
	};
	return { stream, requests };
}

let storage: ChatStorageManager;
let highlights: ChatHighlight[];
let settings: ChatSettings;
let parsed: typeof paper | null;
let ids: number;

function controller(stream: (r: StreamRequest) => AsyncGenerator<StreamEvent>, extra = {}) {
	return createChatController({
		storage,
		stream,
		getSettings: () => settings,
		getDocument: () => ({ pdfKey: 'paper.pdf_1', parsed }),
		highlights: {
			all: () => highlights,
			add: (h) => highlights.push(h),
			update: (h) => (highlights = highlights.map((x) => (x.id === h.id ? h : x)))
		},
		newId: () => `id-${++ids}`,
		...extra
	});
}

beforeEach(() => {
	resetChatStoreForTests();
	storage = new ChatStorageManager(new IDBFactory());
	highlights = [];
	settings = { ...DEFAULT_CHAT_SETTINGS, apiKey: 'sk-or-test' };
	parsed = paper;
	ids = 0;
});

afterEach(() => {
	storage.close();
	vi.useRealTimers();
});

describe('starting a conversation', () => {
	it('anchors a highlight, saves the session and streams the first answer', async () => {
		const { stream } = scriptedStream([{ chunks: ['Scaling ', 'keeps softmax ', 'sane.'] }]);
		pendingSelection.set(selection);

		const sessionId = await controller(stream).startConversation(selection, 'Why scale?');

		expect(highlights).toHaveLength(1);
		expect(highlights[0]).toMatchObject({ sessionId, ordinal: 1, pageNumber: 2, rects: selection.rects, messageCount: 2 });
		expect(get(activeSessionId)).toBe(sessionId);
		expect(get(pendingSelection)).toBeNull();

		const saved = (await storage.getSession(sessionId))!;
		expect(saved).toMatchObject({
			highlightId: highlights[0].id,
			quotedText: selection.anchor.text,
			model: settings.chatModel,
			messageCount: 2,
			focusBlockIdx: scaled.idx
		});
		expect(saved.contextSnapshot).toContain('3.1 Scaled Dot-Product Attention');

		const stored = await storage.listMessages(sessionId);
		expect(stored.map((m) => [m.seq, m.role, m.status, m.content])).toEqual([
			[1, 'user', 'complete', 'Why scale?'],
			[2, 'assistant', 'complete', 'Scaling keeps softmax sane.']
		]);
		expect(stored[1].usage).toEqual({ promptTokens: 100, completionTokens: 3 });
		expect(get(chatMessages).get(sessionId)).toEqual(stored);
	});

	it('numbers highlights in creation order', async () => {
		const { stream } = scriptedStream([{ chunks: ['a'] }]);
		const c = controller(stream);
		await c.startConversation(selection, 'one');
		await c.startConversation(selection, 'two');
		expect(highlights.map((h) => h.ordinal)).toEqual([1, 2]);
		expect(get(chatSessions)).toHaveLength(2);
	});

	it('refuses without an API key, before creating anything', async () => {
		settings = { ...settings, apiKey: '  ' };
		const { stream } = scriptedStream([{ chunks: ['a'] }]);
		const error = await controller(stream).startConversation(selection, 'q').catch((e) => e);
		expect(error).toBeInstanceOf(ChatError);
		expect((error as ChatError).kind).toBe('no_api_key');
		expect(highlights).toEqual([]);
		expect(get(chatSessions)).toEqual([]);
	});

	it('refuses while the document has not been parsed', async () => {
		parsed = null;
		const { stream } = scriptedStream([{ chunks: ['a'] }]);
		const error = await controller(stream).startConversation(selection, 'q').catch((e) => e);
		expect((error as ChatError).kind).toBe('not_parsed');
		expect(highlights).toEqual([]);
	});
});

describe('follow-up questions', () => {
	it('sends the pinned context once and only the new question after it', async () => {
		const { stream, requests } = scriptedStream([{ chunks: ['First answer.'] }, { chunks: ['Second answer.'] }]);
		const c = controller(stream);
		const id = await c.startConversation(selection, 'Why scale?');
		await c.sendMessage(id, 'By how much?');

		const second = requests[1].messages;
		expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
		expect(String(second[1].content)).toContain('<context>');
		expect(String(second[1].content)).toContain('Why scale?');
		expect(second[2].content).toBe('First answer.');
		expect(second[3].content).toBe('By how much?');
		expect((await storage.listMessages(id)).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
		expect(highlights[0].messageCount).toBe(4);
	});

	it('uses the configured model, key and endpoint', async () => {
		settings = { ...settings, chatModel: 'anthropic/claude-haiku-4.5', endpoint: 'https://example.test/v1' };
		const { stream, requests } = scriptedStream([{ chunks: ['a'] }]);
		await controller(stream).startConversation(selection, 'q');
		expect(requests[0]).toMatchObject({
			model: 'anthropic/claude-haiku-4.5',
			apiKey: 'sk-or-test',
			endpoint: 'https://example.test/v1'
		});
	});

	it('passes whole-paper and page-image requests through to the prompt', async () => {
		const { stream, requests } = scriptedStream([{ chunks: ['a'] }]);
		await controller(stream).startConversation(selection, 'q', {
			wholePaper: true,
			pageImage: 'data:image/webp;base64,AAA'
		});
		const msgs = requests[0].messages;
		expect(String(msgs[0].content)).toContain('<full_text>');
		expect(Array.isArray(msgs.at(-1)!.content)).toBe(true);
	});
});

describe('streaming and failures', () => {
	it('writes a streaming answer to storage periodically, then marks it complete', async () => {
		let t = 0;
		const clock = () => t;
		const puts: string[] = [];
		const realPut = storage.putMessage.bind(storage);
		storage.putMessage = async (m) => {
			if (m.role === 'assistant') puts.push(`${m.status}:${m.content}`);
			return realPut(m);
		};
		const stream = async function* (): AsyncGenerator<StreamEvent> {
			for (const text of ['a', 'b', 'c', 'd']) {
				t += 600;
				yield { type: 'delta', text };
			}
			yield { type: 'done' };
		};
		await controller(stream, { now: clock, persistIntervalMs: 1000 }).startConversation(selection, 'q');
		expect(puts).toEqual(['streaming:ab', 'streaming:abcd', 'complete:abcd']);
	});

	it('keeps what arrived when the user stops the answer', async () => {
		const { stream } = scriptedStream([{ chunks: ['Partial ', 'answer ', 'never'], hangAfter: 2 }]);
		const c = controller(stream);
		const run = c.startConversation(selection, 'q');
		await vi.waitFor(() => expect(get(c.generating).size).toBe(1));
		await vi.waitFor(() => {
			const msgs = [...get(chatMessages).values()].flat();
			expect(msgs.some((m) => m.content === 'Partial answer ')).toBe(true);
		});
		c.stop([...get(c.generating)][0]);
		const id = await run;

		const [, answer] = await storage.listMessages(id);
		expect(answer).toMatchObject({ status: 'complete', content: 'Partial answer ' });
		expect(get(c.generating).size).toBe(0);
	});

	it('records a failed answer with a readable reason and keeps the question', async () => {
		const { stream } = scriptedStream([{ chunks: [], error: new OpenRouterError('auth', 'User not found.', 401) }]);
		const c = controller(stream);
		const completions: unknown[] = [];
		c.answerCompleted.subscribe((e) => e && completions.push(e));
		const id = await c.startConversation(selection, 'q');

		const [question, answer] = await storage.listMessages(id);
		expect(question.content).toBe('q');
		expect(answer.status).toBe('error');
		expect(answer.content).toContain('OpenRouter rejected the API key');
		expect(completions).toEqual([]); // nothing to summarise
	});

	it('announces each finished answer', async () => {
		const { stream } = scriptedStream([{ chunks: ['a'] }]);
		const c = controller(stream);
		const events: { sessionId: string }[] = [];
		c.answerCompleted.subscribe((e) => e && events.push(e));
		const id = await c.startConversation(selection, 'q');
		expect(events.map((e) => e.sessionId)).toEqual([id]);
	});

	it('refuses a second question while one is still streaming', async () => {
		const { stream } = scriptedStream([{ chunks: ['a', 'b'], hangAfter: 1 }]);
		const c = controller(stream);
		const run = c.startConversation(selection, 'q');
		await vi.waitFor(() => expect(get(c.generating).size).toBe(1));
		const id = [...get(c.generating)][0];
		const error = await c.sendMessage(id, 'again').catch((e) => e);
		expect((error as ChatError).kind).toBe('busy');
		c.stop(id);
		await run;
	});
});
