import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createParseQueue, type ParseRequest } from '../../../src/lib/services/parseQueue';
import { ParseError, type ParseErrorKind } from '../../../src/lib/services/docParser/mineruClient';
import type { ParsedDocument } from '../../../src/lib/services/docParser/types';

const doc = (pdfKey: string, fp = `fp-${pdfKey}`): ParsedDocument => ({
	schemaVersion: 1,
	pdfKey,
	parsedAt: 0,
	sourceFingerprint: fp,
	parser: { name: 'mineru' },
	pageCount: 1,
	blocks: [],
	outline: [],
	references: []
});

const req = (pdfKey: string, fp = `fp-${pdfKey}`): ParseRequest => ({
	pdfKey,
	fingerprint: fp,
	filename: pdfKey,
	getBytes: async () => new Uint8Array()
});

function harness() {
	const cache = new Map<string, ParsedDocument>();
	const parses: {
		req: ParseRequest;
		signal: AbortSignal;
		resolve: (d: ParsedDocument) => void;
		reject: (e: unknown) => void;
	}[] = [];
	const deps = {
		cache: {
			get: vi.fn(async (k: string) => cache.get(k) ?? null),
			put: vi.fn(async (d: ParsedDocument) => {
				cache.set(d.pdfKey, d);
			})
		},
		parse: vi.fn(
			(r: ParseRequest, { signal }: { signal: AbortSignal }) =>
				new Promise<ParsedDocument>((resolve, reject) => {
					parses.push({ req: r, signal, resolve, reject });
					signal.addEventListener('abort', () => reject(new ParseError('aborted', 'cancelled')));
				})
		),
		debounceMs: 2000,
		maxQueued: 3,
		retryDelaysMs: [100, 200]
	};
	const q = createParseQueue(deps);
	const status = (k: string) => get(q.jobs).get(k)?.status;
	const settle = () => vi.advanceTimersByTimeAsync(0);
	/** Finish the running parse successfully. */
	const finish = async (i: number) => {
		parses[i].resolve(doc(parses[i].req.pdfKey, parses[i].req.fingerprint));
		await settle();
	};
	const fail = async (i: number, kind: ParseErrorKind) => {
		parses[i].reject(new ParseError(kind, `${kind} failure`));
		await settle();
	};
	return { q, deps, cache, parses, status, settle, finish, fail };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('parse queue: starting', () => {
	it('waits out the debounce before parsing a newly opened document', async () => {
		const h = harness();
		h.q.request(req('a'));
		await vi.advanceTimersByTimeAsync(1999);
		expect(h.parses).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a']);
		expect(h.status('a')).toBe('running');
	});

	it('only parses the last of several documents flipped through quickly', async () => {
		const h = harness();
		h.q.request(req('a'));
		await vi.advanceTimersByTimeAsync(500);
		h.q.request(req('b'));
		await vi.advanceTimersByTimeAsync(500);
		h.q.request(req('c'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['c']);
	});

	it('skips the debounce for a manual request', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		await h.settle();
		expect(h.parses).toHaveLength(1);
	});

	it('uses a cached parse of the same file without parsing again', async () => {
		const h = harness();
		h.cache.set('a', doc('a'));
		h.q.request(req('a'), { manual: true });
		await h.settle();
		expect(h.deps.parse).not.toHaveBeenCalled();
		expect(h.status('a')).toBe('done');
		expect(h.q.documentFor('a', 'fp-a')).toEqual(doc('a'));
	});

	it('loads a cached parse without ever parsing when asked for cache only', async () => {
		const h = harness();
		h.cache.set('cached', doc('cached'));
		h.q.request(req('cached'), { cacheOnly: true });
		h.q.request(req('uncached'), { cacheOnly: true });
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.deps.parse).not.toHaveBeenCalled();
		expect(h.q.documentFor('cached', 'fp-cached')).not.toBeNull();
		expect(h.status('uncached')).toBeUndefined();
	});

	it('ignores a cached parse of a different file under the same key', async () => {
		const h = harness();
		h.cache.set('same-name.pdf_0', doc('same-name.pdf_0', 'fp-other-paper'));
		h.q.request(req('same-name.pdf_0', 'fp-this-paper'), { manual: true });
		await h.settle();
		expect(h.parses).toHaveLength(1);
		expect(h.q.documentFor('same-name.pdf_0', 'fp-this-paper')).toBeNull();
	});
});

describe('parse queue: scheduling', () => {
	it('runs one parse at a time', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		h.q.request(req('b'), { manual: true });
		await h.settle();
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a']);
		expect(h.status('b')).toBe('queued');

		await h.finish(0);
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a', 'b']);
		expect(h.status('a')).toBe('done');
	});

	it('does not cancel a running parse when another document is opened, and puts the new one first', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		h.q.request(req('c'), { manual: true });
		await h.settle();
		h.q.request(req('b'), { manual: true }); // opened most recently
		await h.settle();
		expect(h.parses[0].signal.aborted).toBe(false);

		await h.finish(0);
		await h.finish(1);
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a', 'b', 'c']);
	});

	it('drops the oldest waiting job past the queue cap', async () => {
		const h = harness();
		h.q.request(req('running'), { manual: true });
		await h.settle();
		for (const k of ['b', 'c', 'd', 'e']) {
			h.q.request(req(k), { manual: true });
			await h.settle();
		}
		expect(h.status('b')).toBeUndefined();
		expect(['c', 'd', 'e'].map(h.status)).toEqual(['queued', 'queued', 'queued']);
	});

	it('does not start a second job for a document already queued', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		await h.settle();
		h.q.request(req('a'));
		await vi.advanceTimersByTimeAsync(3000);
		expect(h.parses).toHaveLength(1);
	});
});

describe('parse queue: failures', () => {
	it('retries transient failures with backoff, then gives up', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		await h.settle();

		await h.fail(0, 'unreachable');
		expect(h.status('a')).toBe('queued');
		expect(get(h.q.jobs).get('a')?.error?.kind).toBe('unreachable');
		await vi.advanceTimersByTimeAsync(100);
		expect(h.parses).toHaveLength(2);

		await h.fail(1, 'server');
		await vi.advanceTimersByTimeAsync(200);
		expect(h.parses).toHaveLength(3);

		await h.fail(2, 'timeout');
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.parses).toHaveLength(3);
		expect(h.status('a')).toBe('failed');
		expect(get(h.q.jobs).get('a')?.attempts).toBe(3);
	});

	it.each<ParseErrorKind>(['auth', 'tier_unavailable', 'failed', 'too_large', 'not_configured'])(
		'fails at once, without retrying, on "%s"',
		async (kind) => {
			const h = harness();
			h.q.request(req('a'), { manual: true });
			await h.settle();
			await h.fail(0, kind);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.parses).toHaveLength(1);
			expect(h.status('a')).toBe('failed');
		}
	);

	it('parses again on retry after a failure', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		await h.settle();
		await h.fail(0, 'auth');
		h.q.retry('a');
		await h.settle();
		expect(h.parses).toHaveLength(2);
		expect(get(h.q.jobs).get('a')?.attempts).toBe(1);
	});

	it('keeps a parsed document usable this session when caching it fails', async () => {
		const h = harness();
		h.deps.cache.put.mockRejectedValueOnce(new Error('quota'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		h.q.request(req('a'), { manual: true });
		await h.settle();
		await h.finish(0);
		expect(h.status('a')).toBe('done');
		expect(h.q.documentFor('a', 'fp-a')).not.toBeNull();
		warn.mockRestore();
	});
});

describe('parse queue: cancelling', () => {
	it('cancels a running parse and moves on to the next', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		h.q.request(req('b'), { manual: true });
		await h.settle();

		h.q.cancel('a');
		await h.settle();
		expect(h.parses[0].signal.aborted).toBe(true);
		expect(h.status('a')).toBe('cancelled');
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a', 'b']);
	});

	it('removes a queued job so it never runs', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		h.q.request(req('b'), { manual: true });
		await h.settle();
		h.q.cancel('b');
		await h.finish(0);
		expect(h.parses.map((p) => p.req.pdfKey)).toEqual(['a']);
		expect(h.status('b')).toBe('cancelled');
	});

	it('cancels a pending debounce', async () => {
		const h = harness();
		h.q.request(req('a'));
		h.q.cancel('a');
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.parses).toHaveLength(0);
	});

	it('stops everything on dispose', async () => {
		const h = harness();
		h.q.request(req('a'), { manual: true });
		await h.settle();
		h.q.dispose();
		expect(h.parses[0].signal.aborted).toBe(true);
		h.q.request(req('b'), { manual: true });
		await h.settle();
		expect(h.parses).toHaveLength(1);
	});
});
