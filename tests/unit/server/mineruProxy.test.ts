import { describe, expect, it, vi } from 'vitest';
import {
	forwardToMinerU,
	isAllowedRoute,
	MAX_UPLOAD_BYTES
} from '../../../src/lib/server/mineruProxy';

const UPSTREAM = 'http://mineru:8000';

function upstreamReturning(body: unknown, status = 200) {
	return vi.fn(
		async () =>
			new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=1' }
			})
	);
}

function req(method: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
	return new Request(`http://app.local/api/mineru/${path}`, { method, ...init });
}

async function errorCode(res: Response) {
	return (await res.json()).error.code;
}

describe('isAllowedRoute', () => {
	it.each([
		['GET', 'v1/health'],
		['GET', 'v1/tiers'],
		['POST', 'v1/uploads'],
		['PUT', 'v1/uploads/upload_abc123/content'],
		['POST', 'v1/uploads/upload_abc123/complete'],
		['POST', 'v1/parse/jobs'],
		['GET', 'v1/parse/jobs/job_d8799cf4'],
		['DELETE', 'v1/parse/jobs/job_d8799cf4'],
		['GET', 'v1/files/file-337bbb94/content']
	])('allows %s %s', (method, path) => {
		expect(isAllowedRoute(method, path)).toBe(true);
	});

	it.each([
		['GET', 'v1/usage'], // account data
		['GET', 'v1/files'], // lists everyone's files
		['GET', 'v1/parse/jobs'], // lists everyone's jobs
		['DELETE', 'v1/uploads'],
		['GET', 'v1/uploads/upload_abc/content'], // wrong method
		['GET', 'v1/files/../../etc/passwd/content'],
		['GET', 'v1/parse/jobs/job_1/../../admin'],
		['GET', 'health']
	])('rejects %s %s', (method, path) => {
		expect(isAllowedRoute(method, path)).toBe(false);
	});
});

describe('forwardToMinerU', () => {
	it('explains that parsing is off when no upstream is configured', async () => {
		const res = await forwardToMinerU(req('GET', 'v1/health'), 'v1/health', { upstream: '' });
		expect(res.status).toBe(503);
		expect(await errorCode(res)).toBe('parser_not_configured');
	});

	it('refuses routes outside the allowlist without calling upstream', async () => {
		const fetchImpl = upstreamReturning({});
		const res = await forwardToMinerU(req('GET', 'v1/usage'), 'v1/usage', { upstream: UPSTREAM, fetchImpl });
		expect(res.status).toBe(404);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('forwards method, path, query, body and content type to the configured upstream', async () => {
		const fetchImpl = upstreamReturning({ id: 'upload_1' });
		const bytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"
		const res = await forwardToMinerU(
			new Request('http://app.local/api/mineru/v1/uploads/upload_1/content?x=1', {
				method: 'PUT',
				body: bytes,
				headers: { 'Content-Type': 'application/pdf' }
			}),
			'v1/uploads/upload_1/content',
			{ upstream: `${UPSTREAM}/`, fetchImpl }
		);
		expect(res.status).toBe(200);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${UPSTREAM}/v1/uploads/upload_1/content?x=1`);
		expect(init.method).toBe('PUT');
		expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
		expect(init.headers).toEqual({ 'Content-Type': 'application/pdf' });
	});

	it('passes the browser’s own key through, and falls back to the server key', async () => {
		const fetchImpl = upstreamReturning({});
		await forwardToMinerU(
			req('GET', 'v1/tiers', { headers: { Authorization: 'Bearer user-key' } }),
			'v1/tiers',
			{ upstream: UPSTREAM, apiKey: 'server-key', fetchImpl }
		);
		await forwardToMinerU(req('GET', 'v1/tiers'), 'v1/tiers', { upstream: UPSTREAM, apiKey: 'server-key', fetchImpl });
		const auth = fetchImpl.mock.calls.map((c) => ((c as unknown[])[1] as RequestInit).headers as Record<string, string>);
		expect(auth[0].Authorization).toBe('Bearer user-key');
		expect(auth[1].Authorization).toBe('Bearer server-key');
	});

	it('never forwards cookies upstream, or upstream cookies back', async () => {
		const fetchImpl = upstreamReturning({ status: 'ok' });
		const res = await forwardToMinerU(
			req('GET', 'v1/health', { headers: { Cookie: 'session=secret' } }),
			'v1/health',
			{ upstream: UPSTREAM, fetchImpl }
		);
		const sent = ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).headers as Record<string, string>;
		expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain('cookie');
		expect(res.headers.get('set-cookie')).toBeNull();
	});

	it('passes upstream errors through unchanged', async () => {
		const body = { error: { code: 'quality_tier_unavailable', message: 'Pass tier=flash' } };
		const res = await forwardToMinerU(req('POST', 'v1/parse/jobs', { body: '{}' }), 'v1/parse/jobs', {
			upstream: UPSTREAM,
			fetchImpl: upstreamReturning(body, 503)
		});
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual(body);
	});

	it('reports an unreachable parser as 502', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await forwardToMinerU(req('GET', 'v1/health'), 'v1/health', {
			upstream: UPSTREAM,
			fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed'))
		});
		expect(res.status).toBe(502);
		expect(await errorCode(res)).toBe('parser_unreachable');
		warn.mockRestore();
	});

	it('reports a slow parser as 504', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const hang = vi.fn(
			(_: unknown, init?: RequestInit) =>
				new Promise<Response>((_, reject) =>
					init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
				)
		);
		const res = await forwardToMinerU(req('GET', 'v1/health'), 'v1/health', {
			upstream: UPSTREAM,
			fetchImpl: hang as unknown as typeof fetch,
			timeoutMs: 20
		});
		expect(res.status).toBe(504);
		expect(await errorCode(res)).toBe('parser_timeout');
		warn.mockRestore();
	});

	it('rejects uploads over the size limit', async () => {
		const fetchImpl = upstreamReturning({});
		const res = await forwardToMinerU(
			req('PUT', 'v1/uploads/u1/content', { headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 1) } }),
			'v1/uploads/u1/content',
			{ upstream: UPSTREAM, fetchImpl }
		);
		expect(res.status).toBe(413);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
