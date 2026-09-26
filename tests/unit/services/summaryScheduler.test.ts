import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildSummaryMessages,
	createSummaryScheduler,
	SUMMARY_PROMPT
} from '../../../src/lib/services/summaryScheduler';
import { OpenRouterError, type StreamEvent, type StreamRequest } from '../../../src/lib/services/openRouter';
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '../../../src/lib/stores/chatSettingsStore';
import type { ChatMessage, ChatSession } from '../../../src/lib/utils/chatStorage';
import type { ChatHighlight } from '../../../src/lib/stores/drawingStore';

const IDLE = 60_000;

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
	return {
		id,
		pdfKey: 'p',
		highlightId: `h-${id}`,
		pageNumber: 1,
		quotedText: `passage ${id}`,
		title: id,
		createdAt: 1,
		updatedAt: 1,
		model: 'm',
		messageCount: 2,
		summaryState: 'idle',
		summaryAttempts: 0,
		...overrides
	};
}

const exchange = (sessionId: string): ChatMessage[] => [
	{ id: `${sessionId}-1`, sessionId, pdfKey: 'p', seq: 1, role: 'user', content: 'Why scale?', createdAt: 1, status: 'complete' },
	{ id: `${sessionId}-2`, sessionId, pdfKey: 'p', seq: 2, role: 'assistant', content: 'To keep gradients healthy.', createdAt: 2, status: 'complete' }
];

function harness(opts: { settings?: Partial<ChatSettings>; fail?: boolean; hang?: boolean } = {}) {
	const sessions = new Map<string, ChatSession>();
	const messages = new Map<string, ChatMessage[]>();
	let highlights: ChatHighlight[] = [];
	const calls: StreamRequest[] = [];
	const settings: ChatSettings = { ...DEFAULT_CHAT_SETTINGS, summaryIdleMs: IDLE, ...opts.settings };

	const stream = async function* (req: StreamRequest): AsyncGenerator<StreamEvent> {
		calls.push(req);
		if (opts.hang) {
			await new Promise((_, reject) =>
				req.signal?.addEventListener('abort', () => reject(new OpenRouterError('aborted', 'x')))
			);
		}
		if (opts.fail) throw new OpenRouterError('server', 'boom');
		yield { type: 'delta', text: '"Asked why logits are scaled; ' };
		yield { type: 'delta', text: 'answer: to keep softmax gradients healthy."' };
		yield { type: 'done' };
	};

	const add = (s: ChatSession, withMessages = true) => {
		sessions.set(s.id, s);
		if (withMessages) messages.set(s.id, exchange(s.id));
		highlights.push({
			id: s.highlightId, pageNumber: 1, sessionId: s.id, rects: [], anchor: {} as ChatHighlight['anchor'],
			createdAt: 1, ordinal: highlights.length + 1, summaryStatus: 'none'
		});
	};

	const scheduler = createSummaryScheduler({
		getSettings: () => settings,
		stream,
		getSession: async (id) => sessions.get(id) ?? null,
		saveSession: async (s) => {
			sessions.set(s.id, s);
		},
		listMessages: async (id) => messages.get(id) ?? [],
		highlights: { all: () => highlights, update: (h) => (highlights = highlights.map((x) => (x.id === h.id ? h : x))) }
	});
	const state = (id: string) => sessions.get(id)?.summaryState;
	const highlight = (id: string) => highlights.find((h) => h.sessionId === id)!;
	return { scheduler, sessions, messages, calls, add, state, highlight, settings };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('summary scheduling', () => {
	it('summarises after the idle period following an answer', async () => {
		const h = harness();
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		expect(h.state('a')).toBe('armed');

		await vi.advanceTimersByTimeAsync(IDLE - 1);
		expect(h.calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await h.scheduler.idle();

		expect(h.calls).toHaveLength(1);
		expect(h.state('a')).toBe('ready');
		expect(h.sessions.get('a')?.summary).toBe('Asked why logits are scaled; answer: to keep softmax gradients healthy.');
		expect(h.highlight('a')).toMatchObject({ summaryStatus: 'ready', summary: h.sessions.get('a')?.summary });
	});

	it('pushes the deadline out when the conversation continues', async () => {
		const h = harness();
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		await vi.advanceTimersByTimeAsync(IDLE - 10_000);
		await h.scheduler.onAnswerComplete('a'); // another answer
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(IDLE - 10_000);
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(1);
	});

	it('summarises at once when a new passage is selected, and not again at the deadline', async () => {
		const h = harness();
		h.add(session('a'));
		h.add(session('b'));
		await h.scheduler.onAnswerComplete('a');
		await h.scheduler.onAnswerComplete('b');

		h.scheduler.onNewSelection();
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(2);
		expect([h.state('a'), h.state('b')]).toEqual(['ready', 'ready']);

		await vi.advanceTimersByTimeAsync(IDLE * 2);
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(2);
	});

	it('never summarises the same session twice, however the triggers race', async () => {
		const h = harness();
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		await vi.advanceTimersByTimeAsync(IDLE - 1);
		h.scheduler.onNewSelection();
		void h.scheduler.requestNow('a');
		await vi.advanceTimersByTimeAsync(1);
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(1);
	});

	it("uses a short, clipped prompt and leaves the model to the server's summary route", async () => {
		const h = harness();
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		h.scheduler.onNewSelection();
		await h.scheduler.idle();
		const req = h.calls[0];
		expect(req).toMatchObject({ purpose: 'summary', maxTokens: 120, temperature: 0.2 });
		expect(req).not.toHaveProperty('model');
		expect(req.messages[0]).toEqual({ role: 'system', content: SUMMARY_PROMPT });
		expect(req.messages[1].content).toContain('Passage: "passage a"');
		expect(req.messages[1].content).toContain('User: Why scale?');
	});

	it('keeps the fresh summary but stays armed if another answer lands while summarising', async () => {
		const h = harness();
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		h.scheduler.onNewSelection(); // generation starts
		await h.scheduler.onAnswerComplete('a'); // user asked again meanwhile
		await h.scheduler.idle();
		expect(h.state('a')).toBe('armed');
		expect(h.sessions.get('a')?.summary).toBeTruthy();
	});
});

describe('summary skips and failures', () => {
	it('skips a conversation too short to summarise, without calling the model', async () => {
		const h = harness();
		h.add(session('a'), false);
		await h.scheduler.onAnswerComplete('a');
		h.scheduler.onNewSelection();
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(0);
		expect(h.state('a')).toBe('skipped');
	});

	it('does nothing when auto-summarise is off', async () => {
		const h = harness({ settings: { autoSummarize: false } });
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		await vi.advanceTimersByTimeAsync(IDLE * 2);
		expect(h.calls).toHaveLength(0);
		expect(h.state('a')).toBe('idle');
	});

	it('marks a failure, allows one retry, then gives up', async () => {
		const h = harness({ fail: true });
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		h.scheduler.onNewSelection();
		await h.scheduler.idle();
		expect(h.state('a')).toBe('failed');
		expect(h.highlight('a').summaryStatus).toBe('failed');

		h.sessions.set('a', { ...h.sessions.get('a')!, summaryState: 'failed' });
		await vi.advanceTimersByTimeAsync(0);
		// A retry via the generic path: failed with attempts < max is eligible.
		await h.scheduler.requestNow('a');
		expect(h.state('a')).toBe('failed');
		expect(h.calls).toHaveLength(2);
	});

	it('leaves an interrupted summary armed when the document is left', async () => {
		const h = harness({ hang: true });
		h.add(session('a'));
		await h.scheduler.onAnswerComplete('a');
		h.scheduler.onNewSelection();
		await vi.advanceTimersByTimeAsync(0);
		h.scheduler.reset();
		await h.scheduler.idle();
		expect(h.state('a')).toBe('armed');
		await vi.advanceTimersByTimeAsync(IDLE * 2);
		expect(h.calls).toHaveLength(1); // the timer died with the reset
	});
});

describe('catching up when a document is reopened', () => {
	it('summarises only the three most recent overdue conversations', async () => {
		const h = harness();
		for (let i = 1; i <= 5; i++) h.add(session(`s${i}`, { summaryState: 'armed', summaryDueAt: 0, updatedAt: i }));
		await h.scheduler.attach([...h.sessions.values()]);
		await h.scheduler.idle();
		expect(h.calls).toHaveLength(3);
		expect(['s5', 's4', 's3'].map(h.state)).toEqual(['ready', 'ready', 'ready']);
		expect(['s2', 's1'].map(h.state)).toEqual(['skipped', 'skipped']);
	});

	it('re-arms one that is not yet due, and retries one cut off mid-call', async () => {
		vi.setSystemTime(1_000_000);
		const h = harness();
		h.add(session('later', { summaryState: 'armed', summaryDueAt: 1_000_000 + 30_000 }));
		h.add(session('cut', { summaryState: 'generating' }));
		await h.scheduler.attach([...h.sessions.values()]);
		await h.scheduler.idle();
		expect(h.state('cut')).toBe('ready');
		expect(h.state('later')).toBe('armed');

		await vi.advanceTimersByTimeAsync(30_000);
		await h.scheduler.idle();
		expect(h.state('later')).toBe('ready');
	});
});

describe('buildSummaryMessages', () => {
	it('keeps the last eight complete messages, clipped', () => {
		const long: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
			id: `m${i}`, sessionId: 's', pdfKey: 'p', seq: i, role: i % 2 ? 'assistant' : 'user',
			content: `msg ${i} ${'x'.repeat(2000)}`, createdAt: i, status: 'complete'
		}));
		const [, user] = buildSummaryMessages(session('s'), long);
		expect(user.content).not.toContain('msg 3 ');
		expect(user.content).toContain('msg 4 ');
		expect(user.content.length).toBeLessThan(8 * 1300 + 200);
	});
});
