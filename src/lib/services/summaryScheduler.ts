import type { ChatSession } from '$lib/utils/chatStorage';
import type { ChatMessage } from '$lib/utils/chatStorage';
import type { ChatHighlight } from '$lib/stores/drawingStore';
import type { ChatSettings } from '$lib/stores/chatSettingsStore';
import { OpenRouterError, type StreamEvent, type StreamRequest } from './openRouter';

/**
 * When to summarise a conversation for its highlight's hover card.
 *
 * A summary is due once an answer has finished and EITHER the conversation has
 * been idle for `summaryIdleMs` (default 1 minute) OR a new passage has been
 * selected — whichever comes first.
 *
 * States (persisted on the session, so a pending summary survives a reload):
 *   idle ─answer done─▶ armed ─deadline or new selection─▶ generating ─▶ ready
 *                         ▲ another answer pushes the deadline out   └─▶ failed ─retry after 30 s─▶ skipped
 *
 * What counts as activity: finishing an answer (re-arms the deadline).
 * What doesn't: hovering highlights, scrolling, paging, zooming, opening the
 * panel — none of those end a conversation or continue it.
 *
 * Cost control: short conversations are skipped, the transcript is clipped,
 * answers are capped at ~25 words, at most two attempts, and when a document
 * is reopened only the three most recent overdue summaries are caught up.
 *
 * Reasoning is turned off: reasoning tokens count against the 120-token cap,
 * and a reasoning model (Kimi K2.6, measured) spends all of it thinking and
 * returns nothing. A model that can't turn reasoning off rejects the request;
 * it is then asked again with reasoning and room for it.
 */

export const SUMMARY_PROMPT =
	'In at most 25 words, state what the user wanted to know about the quoted passage and the ' +
	'conclusion of the answer. No preamble, no quotation marks.';

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 30_000;
const SUMMARY_MAX_TOKENS = 120;
const REASONING_MAX_TOKENS = 2_000;
const CATCH_UP_LIMIT = 3;
const MIN_MESSAGES = 2;
const TRANSCRIPT_MESSAGES = 8;
const MESSAGE_CLIP = 1200;
const QUOTE_CLIP = 500;

export interface SummarySchedulerDeps {
	getSettings: () => ChatSettings;
	stream: (req: StreamRequest) => AsyncGenerator<StreamEvent>;
	/** Latest copy of a session (in memory first), or null. */
	getSession: (id: string) => Promise<ChatSession | null>;
	/** Persist a session and reflect it in the UI. */
	saveSession: (session: ChatSession) => Promise<void>;
	listMessages: (sessionId: string) => Promise<ChatMessage[]>;
	highlights: { all(): ChatHighlight[]; update(h: ChatHighlight): void };
	now?: () => number;
}

export interface SummaryScheduler {
	/** A document's sessions are loaded: re-arm what was pending, catch up what's overdue. */
	attach(sessions: ChatSession[]): Promise<void>;
	/** Leaving the document: stop timers and in-flight work; persisted states stay as they are. */
	reset(): void;
	onAnswerComplete(sessionId: string): Promise<void>;
	/** A new passage was selected: everything armed is summarised now. */
	onNewSelection(): void;
	/** Manual retry from the hover card. */
	requestNow(sessionId: string): Promise<void>;
	/** Resolves when in-flight summaries are done (tests). */
	idle(): Promise<void>;
}

/** The model refused to turn reasoning off. */
function mustReason(error: unknown): boolean {
	return error instanceof OpenRouterError && error.kind === 'bad_request' && /reason/i.test(error.message);
}

export function buildSummaryMessages(session: ChatSession, messages: ChatMessage[]) {
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
	const transcript = messages
		.filter((m) => m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'))
		.slice(-TRANSCRIPT_MESSAGES)
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.content, MESSAGE_CLIP)}`)
		.join('\n\n');
	return [
		{ role: 'system' as const, content: SUMMARY_PROMPT },
		{
			role: 'user' as const,
			content: `Passage: "${clip(session.quotedText, QUOTE_CLIP)}"\n\nConversation:\n${transcript}`
		}
	];
}

export function createSummaryScheduler(deps: SummarySchedulerDeps): SummaryScheduler {
	const now = deps.now ?? Date.now;
	const armed = new Map<string, number>(); // sessionId → due time
	const inFlight = new Map<string, Promise<void>>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller = new AbortController();

	function reschedule() {
		clearTimeout(timer);
		timer = undefined;
		if (armed.size === 0) return;
		const next = Math.min(...armed.values());
		timer = setTimeout(fireDue, Math.max(250, next - now()));
	}

	function fireDue() {
		timer = undefined;
		const t = now();
		for (const [id, due] of armed) if (due <= t) void generate(id);
		reschedule();
	}

	function setHighlight(highlightId: string, patch: Partial<ChatHighlight>) {
		const h = deps.highlights.all().find((x) => x.id === highlightId);
		if (h) deps.highlights.update({ ...h, ...patch });
	}

	async function arm(session: ChatSession, dueAt: number) {
		armed.set(session.id, dueAt);
		await deps.saveSession({ ...session, summaryState: 'armed', summaryDueAt: dueAt });
		reschedule();
	}

	function generate(sessionId: string): Promise<void> {
		const existing = inFlight.get(sessionId);
		if (existing) return existing;
		armed.delete(sessionId);
		const signal = controller.signal;
		const run = (async () => {
			const settings = deps.getSettings();
			if (!settings.autoSummarize) return;

			// Compare-and-set against the latest copy: never summarise twice.
			const session = await deps.getSession(sessionId);
			if (!session) return;
			const eligible =
				session.summaryState === 'armed' ||
				(session.summaryState === 'failed' && session.summaryAttempts < MAX_ATTEMPTS);
			if (!eligible) return;

			const messages = await deps.listMessages(sessionId);
			const complete = messages.filter((m) => m.status === 'complete');
			if (complete.length < MIN_MESSAGES) {
				await deps.saveSession({ ...session, summaryState: 'skipped', summaryDueAt: undefined });
				return;
			}

			await deps.saveSession({ ...session, summaryState: 'generating' });
			setHighlight(session.highlightId, { summaryStatus: 'pending' });

			const collect = async (req: StreamRequest) => {
				let text = '';
				for await (const event of deps.stream(req)) {
					if (event.type === 'delta') text += event.text;
				}
				return text;
			};
			const base = {
				purpose: 'summary',
				messages: buildSummaryMessages(session, messages),
				temperature: 0.2,
				signal
			} satisfies StreamRequest;

			let summary = '';
			try {
				try {
					summary = await collect({ ...base, maxTokens: SUMMARY_MAX_TOKENS, disableReasoning: true });
				} catch (error) {
					if (!mustReason(error)) throw error;
					summary = await collect({ ...base, maxTokens: REASONING_MAX_TOKENS });
				}
				summary = summary.trim().replace(/^["“]|["”]$/g, '');
				if (!summary) throw new Error('Empty summary');

				const latest = (await deps.getSession(sessionId)) ?? session;
				// Another answer may have finished while this ran and re-armed the
				// session: keep this summary for now, but stay armed for the newer one.
				const rearmedFor = armed.get(sessionId);
				await deps.saveSession({
					...latest,
					summaryState: rearmedFor ? 'armed' : 'ready',
					summary,
					summaryDueAt: rearmedFor,
					summaryError: undefined
				});
				setHighlight(session.highlightId, { summaryStatus: 'ready', summary });
			} catch (error) {
				if (signal.aborted) {
					// Left the document mid-call: leave it armed to catch up next time.
					const latest = (await deps.getSession(sessionId)) ?? session;
					await deps.saveSession({ ...latest, summaryState: 'armed', summaryDueAt: now() });
					return;
				}
				const attempts = session.summaryAttempts + 1;
				const latest = (await deps.getSession(sessionId)) ?? session;
				const retryAt = attempts < MAX_ATTEMPTS ? now() + RETRY_DELAY_MS : undefined;
				await deps.saveSession({
					...latest,
					summaryState: retryAt ? 'failed' : 'skipped',
					summaryAttempts: attempts,
					summaryDueAt: retryAt,
					summaryError: error instanceof Error ? error.message : String(error)
				});
				setHighlight(session.highlightId, { summaryStatus: 'failed' });
				if (retryAt) {
					armed.set(sessionId, retryAt);
					reschedule();
				}
				console.warn(`Summary for ${sessionId} failed:`, error);
			}
		})().finally(() => inFlight.delete(sessionId));
		inFlight.set(sessionId, run);
		return run;
	}

	return {
		async attach(sessions) {
			const t = now();
			const pending = sessions.filter(
				(s) =>
					s.summaryState === 'armed' ||
					s.summaryState === 'generating' ||
					(s.summaryState === 'failed' && s.summaryAttempts < MAX_ATTEMPTS)
			);
			// A summary cut off mid-call by a reload is due immediately.
			const withDue = pending.map((s) => ({
				s,
				due: s.summaryState === 'generating' ? t : (s.summaryDueAt ?? t)
			}));
			const overdue = withDue.filter((x) => x.due <= t).sort((a, b) => b.s.updatedAt - a.s.updatedAt);
			for (const [i, { s }] of overdue.entries()) {
				if (i < CATCH_UP_LIMIT) armed.set(s.id, t);
				else await deps.saveSession({ ...s, summaryState: 'skipped', summaryDueAt: undefined });
			}
			for (const { s, due } of withDue) {
				if (due > t) armed.set(s.id, due);
				else if (s.summaryState === 'generating' && armed.has(s.id)) {
					await deps.saveSession({ ...s, summaryState: 'armed', summaryDueAt: t });
				}
			}
			fireDue();
		},

		reset() {
			clearTimeout(timer);
			timer = undefined;
			armed.clear();
			controller.abort();
			controller = new AbortController();
		},

		async onAnswerComplete(sessionId) {
			const settings = deps.getSettings();
			if (!settings.autoSummarize) return;
			const session = await deps.getSession(sessionId);
			if (!session) return;
			// Another answer on a summarised conversation makes its summary stale.
			await arm({ ...session, summaryAttempts: 0 }, now() + settings.summaryIdleMs);
		},

		onNewSelection() {
			for (const id of [...armed.keys()]) void generate(id);
			reschedule();
		},

		async requestNow(sessionId) {
			const session = await deps.getSession(sessionId);
			if (!session) return;
			if (session.summaryState !== 'armed') {
				await deps.saveSession({ ...session, summaryState: 'armed', summaryAttempts: 0 });
			}
			await generate(sessionId);
		},

		async idle() {
			await Promise.all([...inFlight.values()]);
		}
	};
}
