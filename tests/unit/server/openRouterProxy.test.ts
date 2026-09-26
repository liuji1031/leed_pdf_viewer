import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_OPENROUTER_UPSTREAM,
	forwardToOpenRouter,
	relayStatus
} from '../../../src/lib/server/openRouterProxy';

const CONFIG = { apiKey: 'sk-or-server', model: 'moonshotai/kimi-k3:nitro' };

function upstream(body = 'data: [DONE]\n\n', status = 200, contentType = 'text/event-stream') {
	return vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType, 'Set-Cookie': 'x=1' } }));
}

function chat(body: unknown, headers: Record<string, string> = {}, path = 'chat/completions') {
	return new Request(`http://app.local/api/openrouter/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

const get = (path: string) => new Request(`http://app.local/api/openrouter/${path}`);

async function errorOf(res: Response) {
	return (await res.json()).error;
}

describe('relayStatus', () => {
	it('is configured only with both a key and a model, and never exposes the key', () => {
		expect(relayStatus(CONFIG)).toEqual({
			configured: true,
			model: 'moonshotai/kimi-k3:nitro',
			summaryModel: 'moonshotai/kimi-k3:nitro',
			missing: []
		});
		expect(relayStatus({ apiKey: ' ', model: 'm' })).toEqual({
			configured: false,
			model: 'm',
			summaryModel: 'm',
			missing: ['OPENROUTER_API_KEY']
		});
		expect(relayStatus({ apiKey: undefined, model: undefined }).missing).toEqual([
			'OPENROUTER_API_KEY',
			'OPENROUTER_MODEL'
		]);
		expect(JSON.stringify(relayStatus(CONFIG))).not.toContain('sk-or-server');
	});

	it('reports the summary model, falling back to the chat model', () => {
		expect(relayStatus({ ...CONFIG, summaryModel: ' anthropic/claude-haiku-4.5 ' }).summaryModel).toBe(
			'anthropic/claude-haiku-4.5'
		);
		expect(relayStatus({ ...CONFIG, summaryModel: '' }).summaryModel).toBe('moonshotai/kimi-k3:nitro');
		expect(relayStatus({ apiKey: 'k', model: undefined }).summaryModel).toBeNull();
	});

	it('is served at GET status without calling upstream', async () => {
		const fetchImpl = upstream();
		const res = await forwardToOpenRouter(get('status'), 'status', { ...CONFIG, fetchImpl });
		expect(await res.json()).toEqual({
			configured: true,
			model: 'moonshotai/kimi-k3:nitro',
			summaryModel: 'moonshotai/kimi-k3:nitro',
			missing: []
		});
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('forwardToOpenRouter', () => {
	it("adds the server's key and default model, and streams the answer back", async () => {
		const fetchImpl = upstream('data: {"choices":[]}\n\ndata: [DONE]\n\n');
		const res = await forwardToOpenRouter(
			chat({ messages: [{ role: 'user', content: 'hi' }], stream: true }, { Origin: 'http://localhost:5173' }),
			'chat/completions',
			{ ...CONFIG, fetchImpl }
		);

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${DEFAULT_OPENROUTER_UPSTREAM}/chat/completions`);
		expect(init.headers).toEqual({
			Authorization: 'Bearer sk-or-server',
			'X-Title': 'LeedPDF',
			'Content-Type': 'application/json',
			'HTTP-Referer': 'http://localhost:5173'
		});
		expect(JSON.parse(init.body as string)).toEqual({
			model: 'moonshotai/kimi-k3:nitro',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true
		});
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(await res.text()).toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
	});

	it('sends summaries upstream as chat completions with the summary model', async () => {
		const fetchImpl = upstream();
		await forwardToOpenRouter(chat({ messages: [] }, {}, 'summary/completions'), 'summary/completions', {
			...CONFIG,
			summaryModel: 'anthropic/claude-haiku-4.5',
			fetchImpl
		});
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${DEFAULT_OPENROUTER_UPSTREAM}/chat/completions`);
		expect(JSON.parse(init.body as string).model).toBe('anthropic/claude-haiku-4.5');
	});

	it('summarises with the chat model when no summary model is set', async () => {
		const fetchImpl = upstream();
		await forwardToOpenRouter(chat({ messages: [] }, {}, 'summary/completions'), 'summary/completions', {
			...CONFIG,
			fetchImpl
		});
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).model).toBe('moonshotai/kimi-k3:nitro');
	});

	it('keeps a model the request names', async () => {
		const fetchImpl = upstream();
		await forwardToOpenRouter(chat({ model: 'anthropic/claude-haiku-4.5', messages: [] }), 'chat/completions', {
			...CONFIG,
			fetchImpl
		});
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).model).toBe('anthropic/claude-haiku-4.5');
	});

	it('uses another upstream when configured', async () => {
		const fetchImpl = upstream();
		await forwardToOpenRouter(get('key'), 'key', { ...CONFIG, upstream: 'https://proxy.test/v1/', fetchImpl });
		expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://proxy.test/v1/key');
	});

	it('explains a missing key or model without calling upstream', async () => {
		const fetchImpl = upstream();
		const noKey = await forwardToOpenRouter(chat({ messages: [] }), 'chat/completions', {
			apiKey: '',
			model: 'm',
			fetchImpl
		});
		expect(noKey.status).toBe(503);
		expect(await errorOf(noKey)).toEqual({ code: 'not_configured', message: 'OPENROUTER_API_KEY is not set on the server.' });

		const noModel = await forwardToOpenRouter(chat({ messages: [] }), 'chat/completions', {
			apiKey: 'k',
			model: undefined,
			fetchImpl
		});
		expect(await errorOf(noModel)).toMatchObject({ code: 'not_configured', message: expect.stringContaining('OPENROUTER_MODEL') });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		['GET', 'models'],
		['GET', 'credits'],
		['POST', 'key'],
		['GET', 'chat/completions'],
		['GET', 'summary/completions'],
		['POST', '../admin']
	])('refuses %s %s', async (method, path) => {
		const fetchImpl = upstream();
		const res = await forwardToOpenRouter(
			new Request(`http://app.local/api/openrouter/x`, { method, ...(method === 'POST' && { body: '{}' }) }),
			path,
			{ ...CONFIG, fetchImpl }
		);
		expect(res.status).toBe(404);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejects a chat body that is not JSON', async () => {
		const res = await forwardToOpenRouter(chat('{nope'), 'chat/completions', { ...CONFIG, fetchImpl: upstream() });
		expect(res.status).toBe(400);
	});

	it('passes upstream errors through with their status', async () => {
		const fetchImpl = upstream(JSON.stringify({ error: { message: 'No credits', code: 402 } }), 402, 'application/json');
		const res = await forwardToOpenRouter(chat({ messages: [] }), 'chat/completions', { ...CONFIG, fetchImpl });
		expect(res.status).toBe(402);
		expect((await errorOf(res)).message).toBe('No credits');
	});

	it('reports an unreachable upstream as 502', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await forwardToOpenRouter(get('key'), 'key', { ...CONFIG, fetchImpl });
		expect(res.status).toBe(502);
		expect((await errorOf(res)).code).toBe('unreachable');
		warn.mockRestore();
	});
});
