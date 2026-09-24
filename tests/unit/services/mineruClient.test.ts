import { describe, expect, it, vi } from 'vitest';
import {
	MinerUClient,
	ParseError,
	pickTier,
	type ParseStage
} from '../../../src/lib/services/docParser/mineruClient';

const RESULT = { pages: [{ page_idx: 0, blocks: [{ type: 'text', bbox: [0.1, 0.1, 0.5, 0.12], content: 'hi' }] }] };

/**
 * A fake MinerU 4 server behaving like the real one: upload responses carry an
 * absolute upload_url on an internal host, jobs go queued → running → done.
 */
function fakeMinerU(options: { jobOutcome?: 'completed' | 'failed'; runningPolls?: number } = {}) {
	const calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
	let polls = 0;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

	const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
		const path = url.replace(/^\/api\/mineru\//, '');
		const method = init.method ?? 'GET';
		const headers = (init.headers ?? {}) as Record<string, string>;
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
		calls.push({ method, path, body, headers });

		if (method === 'POST' && path === 'v1/uploads') {
			return json({ id: 'upload_1', status: 'pending', upload_url: 'http://mineru:8000/v1/uploads/upload_1/content' });
		}
		if (method === 'PUT' && path === 'v1/uploads/upload_1/content') return json({});
		if (method === 'POST' && path === 'v1/uploads/upload_1/complete') {
			return json({ id: 'upload_1', status: 'completed', file: { id: 'file-1' } });
		}
		if (method === 'POST' && path === 'v1/parse/jobs') return json({ job_id: 'job_1', status: 'queued' }, 202);
		if (method === 'GET' && path === 'v1/parse/jobs/job_1') {
			polls++;
			if (polls <= (options.runningPolls ?? 2)) return json({ job_id: 'job_1', status: 'running' });
			if (options.jobOutcome === 'failed') {
				return json({
					job_id: 'job_1',
					status: 'failed',
					files: [{ status: 'failed', error: { code: 'pdf_encrypted', message: 'The PDF is encrypted' } }]
				});
			}
			return json({
				job_id: 'job_1',
				status: 'completed',
				files: [{ status: 'completed', output_files: { structured_content: { file_id: 'file-out', bytes: 99 } } }]
			});
		}
		if (method === 'DELETE' && path === 'v1/parse/jobs/job_1') return json({ job_id: 'job_1', status: 'canceled' });
		if (method === 'GET' && path === 'v1/files/file-out/content') return json(RESULT);
		if (method === 'GET' && path === 'v1/tiers') return json({ data: [{ id: 'flash' }, { id: 'basic' }] });
		return json({ error: { code: 'not_found', message: path } }, 404);
	});
	return { fetchImpl, calls };
}

const pdf = new Uint8Array([37, 80, 68, 70, 45]);

async function kindOf(p: Promise<unknown>) {
	const error = await p.then(
		() => null,
		(e) => e
	);
	expect(error).toBeInstanceOf(ParseError);
	return (error as ParseError).kind;
}

describe('MinerUClient.parse', () => {
	it('uploads, parses with the requested tier, and returns the structured content', async () => {
		const { fetchImpl, calls } = fakeMinerU();
		const stages: ParseStage[] = [];
		const client = new MinerUClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

		const result = await client.parse(pdf, 'paper.pdf', { tier: 'flash', pollIntervalMs: 0, onStage: (s) => stages.push(s) });

		expect(result).toEqual(RESULT);
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST v1/uploads',
			'PUT v1/uploads/upload_1/content', // the relay route, never the absolute upload_url
			'POST v1/uploads/upload_1/complete',
			'POST v1/parse/jobs',
			'GET v1/parse/jobs/job_1',
			'GET v1/parse/jobs/job_1',
			'GET v1/parse/jobs/job_1',
			'GET v1/files/file-out/content'
		]);
		expect(calls[0].body).toEqual({ filename: 'paper.pdf', bytes: 5, mime_type: 'application/pdf', purpose: 'parse' });
		expect(calls[1].headers['Content-Type']).toBe('application/pdf');
		expect(calls[3].body).toEqual({
			files: [{ source: { type: 'file_id', file_id: 'file-1' } }],
			tier: 'flash',
			output_formats: ['structured_content']
		});
		expect(stages[0]).toBe('uploading');
		expect(stages).toContain('parsing');
		expect(stages.at(-1)).toBe('downloading');
	});

	it('sends the API key on every request when one is set', async () => {
		const { fetchImpl, calls } = fakeMinerU({ runningPolls: 0 });
		await new MinerUClient({ apiKey: ' sk_cloud ', fetchImpl: fetchImpl as unknown as typeof fetch }).parse(pdf, 'p.pdf', {
			tier: 'flash',
			pollIntervalMs: 0
		});
		expect(calls.every((c) => c.headers.Authorization === 'Bearer sk_cloud')).toBe(true);
	});

	it('reports a failed job with the parser’s own reason', async () => {
		const { fetchImpl } = fakeMinerU({ jobOutcome: 'failed', runningPolls: 0 });
		const client = new MinerUClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const error = (await client.parse(pdf, 'p.pdf', { tier: 'flash', pollIntervalMs: 0 }).catch((e) => e)) as ParseError;
		expect(error).toBeInstanceOf(ParseError);
		expect(error.kind).toBe('failed');
		expect(error.message).toBe('The PDF is encrypted');
		expect(error.transient).toBe(false);
	});

	it('cancels the server-side job when aborted while parsing', async () => {
		const { fetchImpl, calls } = fakeMinerU({ runningPolls: 1000 });
		const controller = new AbortController();
		const client = new MinerUClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
		const run = client.parse(pdf, 'p.pdf', {
			tier: 'flash',
			pollIntervalMs: 5,
			signal: controller.signal,
			onStage: (s) => s === 'parsing' && controller.abort()
		});
		expect(await kindOf(run)).toBe('aborted');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === 'v1/parse/jobs/job_1')).toBe(true));
	});
});

describe('MinerUClient errors', () => {
	const failingWith = (status: number, code?: string) =>
		new MinerUClient({
			fetchImpl: (async () =>
				new Response(JSON.stringify({ error: { code, message: `boom ${code}` } }), { status })) as unknown as typeof fetch
		});

	it.each([
		[503, 'parser_not_configured', 'not_configured', false],
		[502, 'parser_unreachable', 'unreachable', true],
		[504, 'parser_timeout', 'timeout', true],
		[503, 'quality_tier_unavailable', 'tier_unavailable', false],
		[413, 'file_too_large', 'too_large', false],
		[401, undefined, 'auth', false],
		[400, 'unsupported_source', 'rejected', false],
		[500, undefined, 'server', true]
	])('maps HTTP %i %s to "%s" (transient: %s)', async (status, code, kind, transient) => {
		const error = (await failingWith(status, code)
			.parse(pdf, 'p.pdf', { tier: 'flash', pollIntervalMs: 0 })
			.catch((e) => e)) as ParseError;
		expect(error).toBeInstanceOf(ParseError);
		expect(error.kind).toBe(kind);
		expect(error.transient).toBe(transient);
	});

	it('maps a network failure to "unreachable"', async () => {
		const client = new MinerUClient({
			fetchImpl: (async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch
		});
		expect(await kindOf(client.tiers())).toBe('unreachable');
	});
});

describe('tiers', () => {
	it('lists the tiers the server runs', async () => {
		const { fetchImpl } = fakeMinerU();
		expect(await new MinerUClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).tiers()).toEqual(['flash', 'basic']);
	});

	it.each([
		[['flash'], undefined, 'flash'],
		[['flash', 'basic', 'standard', 'advanced'], 'auto', 'standard'],
		[['flash', 'basic'], undefined, 'basic'],
		[['flash', 'standard'], 'flash', 'flash'], // user override honoured
		[['flash'], 'standard', 'flash'], // override not offered: best available
		[[], undefined, null]
	])('picks from %j with preference %s → %s', (available, preferred, expected) => {
		expect(pickTier(available, preferred)).toBe(expected);
	});
});
