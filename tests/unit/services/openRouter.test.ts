import { describe, expect, it, vi } from 'vitest';
import {
	checkApiKey,
	createSseParser,
	listModels,
	OpenRouterError,
	streamChat,
	type StreamEvent,
	type StreamRequest
} from '../../../src/lib/services/openRouter';

const enc = new TextEncoder();

/** A streaming response built from raw chunks, recording whether it was cancelled. */
function sseResponse(chunks: (string | Uint8Array)[]) {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
			controller.close();
		},
		cancel() {
			cancelled = true;
		}
	});
	return {
		response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
		wasCancelled: () => cancelled
	};
}

const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const usageChunk = `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`;
const DONE = 'data: [DONE]\n\n';

function request(fetchImpl: typeof fetch, overrides: Partial<StreamRequest> = {}): StreamRequest {
	return {
		endpoint: 'https://openrouter.ai/api/v1/',
		apiKey: 'sk-test',
		model: 'anthropic/claude-sonnet-5',
		messages: [{ role: 'user', content: 'Why scale by √dk?' }],
		fetchImpl,
		...overrides
	};
}

async function collect(gen: AsyncGenerator<StreamEvent>) {
	const events: StreamEvent[] = [];
	for await (const e of gen) events.push(e);
	return events;
}

const text = (events: StreamEvent[]) =>
	events.map((e) => (e.type === 'delta' ? e.text : '')).join('');

async function expectError(promise: Promise<unknown>, kind: string) {
	const error = await promise.then(
		() => null,
		(e) => e
	);
	expect(error).toBeInstanceOf(OpenRouterError);
	expect((error as OpenRouterError).kind).toBe(kind);
	return error as OpenRouterError;
}

describe('createSseParser', () => {
	it('reassembles a data line split across chunks', () => {
		const p = createSseParser();
		expect(p.push('data: {"a"')).toEqual([]);
		expect(p.push(':1}\n\ndata: [DO')).toEqual(['{"a":1}']);
		expect(p.push('NE]\n\n')).toEqual(['[DONE]']);
	});

	it('handles CRLF, several events per chunk, and drops comments and other fields', () => {
		const p = createSseParser();
		expect(p.push(': OPENROUTER PROCESSING\r\n\r\nevent: x\r\ndata: 1\r\n\r\ndata:2\r\n\r\n')).toEqual([
			'1',
			'2'
		]);
	});

	it('flushes a final line that had no trailing newline', () => {
		const p = createSseParser();
		expect(p.push('data: [DONE]')).toEqual([]);
		expect(p.flush()).toEqual(['[DONE]']);
	});
});

describe('streamChat', () => {
	it('streams deltas in order and finishes with usage', async () => {
		const { response } = sseResponse([delta('Scaling '), delta('keeps '), delta('softmax sane.'), usageChunk, DONE]);
		const events = await collect(streamChat(request(async () => response)));
		expect(text(events)).toBe('Scaling keeps softmax sane.');
		expect(events.at(-1)).toEqual({ type: 'done', usage: { promptTokens: 12, completionTokens: 3 } });
	});

	it('sends the model, messages, streaming flags and identifying headers', async () => {
		const fetchImpl = vi.fn(async () => sseResponse([DONE]).response);
		await collect(streamChat(request(fetchImpl, { maxTokens: 120, temperature: 0.2 })));

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions'); // trailing slash handled
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-test');
		expect(headers['X-Title']).toBe('LeedPDF');
		expect(JSON.parse(init.body as string)).toEqual({
			model: 'anthropic/claude-sonnet-5',
			messages: [{ role: 'user', content: 'Why scale by √dk?' }],
			stream: true,
			usage: { include: true },
			max_tokens: 120,
			temperature: 0.2
		});
	});

	it('reassembles a multi-byte character split across network chunks', async () => {
		const bytes = enc.encode(delta('1/√dk'));
		const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte "√"
		const { response } = sseResponse([bytes.slice(0, cut), bytes.slice(cut), DONE]);
		expect(text(await collect(streamChat(request(async () => response))))).toBe('1/√dk');
	});

	it('ignores keep-alive comments and malformed lines', async () => {
		const { response } = sseResponse([': OPENROUTER PROCESSING\n\n', 'data: {not json\n\n', delta('ok'), DONE]);
		expect(text(await collect(streamChat(request(async () => response))))).toBe('ok');
	});

	it.each([
		[401, 'auth'],
		[403, 'auth'],
		[402, 'credits'],
		[429, 'rate_limit'],
		[400, 'bad_request'],
		[404, 'bad_request'],
		[502, 'server']
	])('maps HTTP %i to a "%s" error carrying the provider message', async (status, kind) => {
		const res = new Response(JSON.stringify({ error: { message: 'User not found.', code: status } }), { status });
		const error = await expectError(collect(streamChat(request(async () => res))), kind);
		expect(error.status).toBe(status);
		expect(error.message).toBe('User not found.');
	});

	it('falls back to the status line for a non-JSON error body', async () => {
		const res = new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' });
		const error = await expectError(collect(streamChat(request(async () => res))), 'server');
		expect(error.message).toBe('502 Bad Gateway');
	});

	it('surfaces a provider error sent mid-stream', async () => {
		const failure = `data: ${JSON.stringify({ error: { message: 'Upstream overloaded', code: 502 } })}\n\n`;
		const { response } = sseResponse([delta('Partial '), failure]);
		const error = await expectError(collect(streamChat(request(async () => response))), 'provider');
		expect(error.message).toBe('Upstream overloaded');
	});

	it('reports a stream that ends without [DONE] as truncated, after yielding what arrived', async () => {
		const { response } = sseResponse([delta('Half an ans')]);
		const received: string[] = [];
		const run = (async () => {
			for await (const e of streamChat(request(async () => response))) {
				if (e.type === 'delta') received.push(e.text);
			}
		})();
		await expectError(run, 'truncated');
		expect(received).toEqual(['Half an ans']);
	});

	it('reports an unreachable endpoint as a network error', async () => {
		const fetchImpl = async () => {
			throw new TypeError('Failed to fetch');
		};
		await expectError(collect(streamChat(request(fetchImpl))), 'network');
	});

	it('reports cancellation before the response arrives as aborted', async () => {
		const controller = new AbortController();
		const fetchImpl = (_: unknown, init?: RequestInit) =>
			new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
			});
		const run = collect(streamChat(request(fetchImpl as typeof fetch, { signal: controller.signal })));
		controller.abort();
		await expectError(run, 'aborted');
	});

	it('stops cleanly when cancelled mid-answer', async () => {
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(delta('Stream')));
				controller.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
			}
		});
		const received: string[] = [];
		const run = (async () => {
			for await (const e of streamChat(request(async () => new Response(body), { signal: controller.signal }))) {
				if (e.type === 'delta') {
					received.push(e.text);
					controller.abort();
				}
			}
		})();
		await expectError(run, 'aborted');
		expect(received).toEqual(['Stream']);
	});

	it('cancels the download when the consumer stops reading early', async () => {
		const { response, wasCancelled } = sseResponse([delta('a'), delta('b'), delta('c'), DONE]);
		for await (const e of streamChat(request(async () => response))) {
			if (e.type === 'delta') break;
		}
		expect(wasCancelled()).toBe(true);
	});
});

describe('model catalogue and key check', () => {
	it('lists models with image support and price per million tokens', async () => {
		const res = new Response(
			JSON.stringify({
				data: [
					{
						id: 'anthropic/claude-sonnet-5',
						name: 'Claude Sonnet 5',
						context_length: 1_000_000,
						architecture: { input_modalities: ['text', 'image', 'file'] },
						pricing: { prompt: '0.000002' }
					},
					{ id: 'text/only', architecture: { input_modalities: ['text'] } }
				]
			})
		);
		const models = await listModels('https://openrouter.ai/api/v1', async () => res);
		expect(models[0]).toEqual({
			id: 'anthropic/claude-sonnet-5',
			name: 'Claude Sonnet 5',
			contextLength: 1_000_000,
			acceptsImages: true,
			promptPricePerM: 2
		});
		expect(models[1]).toMatchObject({ id: 'text/only', name: 'text/only', acceptsImages: false });
	});

	it('checks a key: label on success, auth error on rejection', async () => {
		const ok = new Response(JSON.stringify({ data: { label: 'sk-or-v1-abc...xyz' } }));
		expect(await checkApiKey('https://openrouter.ai/api/v1', 'k', async () => ok)).toEqual({
			label: 'sk-or-v1-abc...xyz'
		});

		const bad = new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), {
			status: 401
		});
		await expectError(checkApiKey('https://openrouter.ai/api/v1', 'k', async () => bad), 'auth');
	});
});
