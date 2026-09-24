import { derived, get, writable, type Readable } from 'svelte/store';
import type { ParsedDocument } from './docParser/types';
import { ParseError, type ParseErrorKind, type ParseStage } from './docParser/mineruClient';

/**
 * Background parsing, one document at a time.
 *
 * Rules:
 *  - Opening a document requests a parse after a short debounce, so flipping
 *    through several files doesn't start a parse for each.
 *  - One parse runs at a time: a local parser is a single pipeline, and
 *    parallel jobs just slow each other down.
 *  - Switching documents never cancels a running parse. Results are cached by
 *    document and users flip back and forth; killing a nearly finished parse is
 *    the worst outcome. The newly opened document goes to the front instead.
 *  - The queue is short: the oldest waiting jobs are dropped past the cap.
 *  - Transient failures (parser unreachable, 5xx, timeouts) retry with backoff;
 *    anything else — bad key, unsupported file, no usable tier — fails at once.
 *  - A cached result is only used if its fingerprint matches the open file.
 */

export type ParseJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ParseJobState {
	pdfKey: string;
	status: ParseJobStatus;
	stage?: ParseStage;
	startedAt?: number;
	finishedAt?: number;
	attempts: number;
	error?: { kind: ParseErrorKind | 'unknown'; message: string };
}

export interface ParseRequest {
	pdfKey: string;
	/** pdf.js content fingerprint of the open file. */
	fingerprint: string;
	filename: string;
	getBytes: () => Promise<Uint8Array>;
}

export interface ParseQueueDeps {
	cache: {
		get(pdfKey: string): Promise<ParsedDocument | null>;
		put(doc: ParsedDocument): Promise<void>;
	};
	parse(
		req: ParseRequest,
		options: { signal: AbortSignal; onStage: (stage: ParseStage) => void }
	): Promise<ParsedDocument>;
	now?: () => number;
	debounceMs?: number;
	maxQueued?: number;
	/** Delay before each retry of a transient failure; its length is the retry count. */
	retryDelaysMs?: number[];
}

export interface ParseQueue {
	jobs: Readable<Map<string, ParseJobState>>;
	documents: Readable<Map<string, ParsedDocument>>;
	/**
	 * Ask for a document to be parsed. `manual` skips the debounce; `cacheOnly`
	 * loads a cached parse if there is one but never starts a new one.
	 */
	request(req: ParseRequest, options?: { manual?: boolean; cacheOnly?: boolean }): void;
	cancel(pdfKey: string): void;
	retry(pdfKey: string): void;
	/** The parsed document for this key, only if it was parsed from this file. */
	documentFor(pdfKey: string, fingerprint: string): ParsedDocument | null;
	dispose(): void;
}

export function createParseQueue(deps: ParseQueueDeps): ParseQueue {
	const now = deps.now ?? Date.now;
	const debounceMs = deps.debounceMs ?? 2000;
	const maxQueued = deps.maxQueued ?? 3;
	const retryDelays = deps.retryDelaysMs ?? [2000, 8000];

	const jobs = writable<Map<string, ParseJobState>>(new Map());
	const documents = writable<Map<string, ParsedDocument>>(new Map());

	const requests = new Map<string, ParseRequest>(); // latest request per key
	const queue: string[] = []; // waiting keys, front first
	let running: { pdfKey: string; controller: AbortController } | null = null;
	let pendingDebounce: { pdfKey: string; timer: ReturnType<typeof setTimeout> } | null = null;
	const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let disposed = false;

	const setJob = (pdfKey: string, patch: Partial<ParseJobState>) =>
		jobs.update((m) => {
			const prev = m.get(pdfKey) ?? { pdfKey, status: 'queued' as const, attempts: 0 };
			return new Map(m).set(pdfKey, { ...prev, ...patch });
		});

	const hasDocument = (req: ParseRequest) => {
		const doc = get(documents).get(req.pdfKey);
		return !!doc && doc.sourceFingerprint === req.fingerprint;
	};

	async function admit(pdfKey: string, cacheOnly = false) {
		const req = requests.get(pdfKey);
		if (!req || disposed || hasDocument(req)) return;
		if (running?.pdfKey === pdfKey) return;

		let cached: ParsedDocument | null = null;
		try {
			cached = await deps.cache.get(pdfKey);
		} catch (error) {
			console.warn('Parsed-document cache unavailable:', error);
		}
		if (disposed || requests.get(pdfKey) !== req) return; // superseded meanwhile
		if (cached && cached.sourceFingerprint === req.fingerprint) {
			documents.update((m) => new Map(m).set(pdfKey, cached!));
			setJob(pdfKey, { status: 'done', finishedAt: now(), error: undefined });
			return;
		}
		if (cacheOnly || running?.pdfKey === pdfKey) return;

		// Newest first; one entry per document.
		const existing = queue.indexOf(pdfKey);
		if (existing !== -1) queue.splice(existing, 1);
		queue.unshift(pdfKey);
		while (queue.length > maxQueued) {
			const dropped = queue.pop()!;
			jobs.update((m) => {
				const next = new Map(m);
				next.delete(dropped);
				return next;
			});
		}
		setJob(pdfKey, { status: 'queued', error: undefined, stage: undefined });
		pump();
	}

	function pump() {
		if (running || disposed) return;
		const pdfKey = queue.shift();
		if (!pdfKey) return;
		const req = requests.get(pdfKey)!;
		const controller = new AbortController();
		running = { pdfKey, controller };
		const attempts = (get(jobs).get(pdfKey)?.attempts ?? 0) + 1;
		setJob(pdfKey, { status: 'running', startedAt: now(), attempts, stage: 'uploading' });

		deps
			.parse(req, { signal: controller.signal, onStage: (stage) => setJob(pdfKey, { stage }) })
			.then(async (doc) => {
				documents.update((m) => new Map(m).set(pdfKey, doc));
				setJob(pdfKey, { status: 'done', finishedAt: now(), stage: undefined, error: undefined });
				try {
					await deps.cache.put(doc);
				} catch (error) {
					// Still usable this session; it just won't survive a reload.
					console.warn('Could not cache parsed document:', error);
				}
			})
			.catch((error: unknown) => {
				const parseError = error instanceof ParseError ? error : null;
				if (controller.signal.aborted || parseError?.kind === 'aborted') {
					setJob(pdfKey, { status: 'cancelled', finishedAt: now(), stage: undefined });
					return;
				}
				const retryIn = parseError?.transient ? retryDelays[attempts - 1] : undefined;
				const failure = {
					kind: parseError?.kind ?? ('unknown' as const),
					message: error instanceof Error ? error.message : String(error)
				};
				// Background work has no one watching: always leave a trace.
				console.warn(`Parsing ${pdfKey} failed (${failure.kind}):`, failure.message);
				if (retryIn !== undefined) {
					setJob(pdfKey, { status: 'queued', stage: undefined, error: failure });
					retryTimers.set(
						pdfKey,
						setTimeout(() => {
							retryTimers.delete(pdfKey);
							void admit(pdfKey);
						}, retryIn)
					);
				} else {
					setJob(pdfKey, { status: 'failed', finishedAt: now(), stage: undefined, error: failure });
				}
			})
			.finally(() => {
				if (running?.pdfKey === pdfKey) running = null;
				pump();
			});
	}

	function request(req: ParseRequest, options: { manual?: boolean; cacheOnly?: boolean } = {}) {
		if (disposed || hasDocument(req)) return;
		if (options.cacheOnly) {
			requests.set(req.pdfKey, req);
			void admit(req.pdfKey, true);
			return;
		}
		const previous = requests.get(req.pdfKey);
		requests.set(req.pdfKey, req);
		// Already waiting or running for the same file: nothing new to do.
		const state = get(jobs).get(req.pdfKey)?.status;
		if (
			previous?.fingerprint === req.fingerprint &&
			!options.manual &&
			(state === 'queued' || state === 'running')
		) {
			return;
		}

		if (pendingDebounce) {
			clearTimeout(pendingDebounce.timer);
			pendingDebounce = null;
		}
		if (options.manual) {
			void admit(req.pdfKey);
			return;
		}
		pendingDebounce = {
			pdfKey: req.pdfKey,
			timer: setTimeout(() => {
				pendingDebounce = null;
				void admit(req.pdfKey);
			}, debounceMs)
		};
	}

	function cancel(pdfKey: string) {
		if (pendingDebounce?.pdfKey === pdfKey) {
			clearTimeout(pendingDebounce.timer);
			pendingDebounce = null;
		}
		const retryTimer = retryTimers.get(pdfKey);
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimers.delete(pdfKey);
		}
		const queued = queue.indexOf(pdfKey);
		if (queued !== -1) queue.splice(queued, 1);
		if (running?.pdfKey === pdfKey) running.controller.abort();
		else if (get(jobs).has(pdfKey)) setJob(pdfKey, { status: 'cancelled', finishedAt: now(), stage: undefined });
	}

	function retry(pdfKey: string) {
		const req = requests.get(pdfKey);
		if (!req) return;
		setJob(pdfKey, { attempts: 0, error: undefined });
		request(req, { manual: true });
	}

	function documentFor(pdfKey: string, fingerprint: string) {
		const doc = get(documents).get(pdfKey);
		return doc && doc.sourceFingerprint === fingerprint ? doc : null;
	}

	function dispose() {
		disposed = true;
		if (pendingDebounce) clearTimeout(pendingDebounce.timer);
		for (const timer of retryTimers.values()) clearTimeout(timer);
		running?.controller.abort();
	}

	return {
		jobs: { subscribe: jobs.subscribe },
		documents: { subscribe: documents.subscribe },
		request,
		cancel,
		retry,
		documentFor,
		dispose
	};
}

/** Current status for one document key, for UI. */
export function jobFor(queue: ParseQueue, pdfKey: Readable<string | null>) {
	return derived([queue.jobs, pdfKey], ([$jobs, $key]) => ($key ? ($jobs.get($key) ?? null) : null));
}
