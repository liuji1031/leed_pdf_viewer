/**
 * OpenRouter client: streaming chat completions straight from the browser.
 *
 * Verified against the live API: CORS allows any origin with Authorization,
 * HTTP-Referer and X-Title; errors arrive as JSON `{ error: { message, code } }`
 * with the HTTP status, before any streaming starts. Mid-stream failures arrive
 * as a `data:` payload carrying an `error` object instead of a delta.
 */

export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | ContentPart[];
}

export type OpenRouterErrorKind =
	| 'auth' // bad or missing API key
	| 'credits' // out of credits
	| 'rate_limit'
	| 'bad_request' // unknown model, context too long, malformed request
	| 'server' // OpenRouter or upstream 5xx
	| 'provider' // the model's provider failed mid-stream
	| 'network'
	| 'truncated' // the stream ended without [DONE]
	| 'aborted';

export class OpenRouterError extends Error {
	constructor(
		readonly kind: OpenRouterErrorKind,
		message: string,
		readonly status?: number,
		options?: { cause?: unknown }
	) {
		super(message, options);
		this.name = 'OpenRouterError';
	}
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
}

export type StreamEvent = { type: 'delta'; text: string } | { type: 'done'; usage?: Usage };

export interface StreamRequest {
	endpoint: string;
	apiKey: string;
	model: string;
	messages: OpenRouterMessage[];
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

const APP_TITLE = 'LeedPDF';

function kindForStatus(status: number): OpenRouterErrorKind {
	if (status === 401 || status === 403) return 'auth';
	if (status === 402) return 'credits';
	if (status === 429) return 'rate_limit';
	if (status >= 500) return 'server';
	return 'bad_request';
}

function headers(apiKey: string): Record<string, string> {
	const h: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		'X-Title': APP_TITLE
	};
	if (typeof window !== 'undefined' && window.location?.origin) {
		h['HTTP-Referer'] = window.location.origin;
	}
	return h;
}

function joinUrl(endpoint: string, path: string): string {
	return `${endpoint.replace(/\/+$/, '')}/${path}`;
}

async function errorFromResponse(res: Response): Promise<OpenRouterError> {
	let message = `${res.status} ${res.statusText}`.trim();
	try {
		const body = await res.json();
		if (body?.error?.message) message = body.error.message;
	} catch {
		// Not JSON — keep the status line.
	}
	return new OpenRouterError(kindForStatus(res.status), message, res.status);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

/**
 * Incremental SSE parser. Returns the `data:` payloads completed by each chunk,
 * buffering a partial line until the chunk that finishes it — network chunks
 * don't respect line boundaries. Comment lines (OpenRouter sends
 * ": OPENROUTER PROCESSING" keep-alives) and other fields are dropped.
 */
export function createSseParser() {
	let buffer = '';
	return {
		push(chunk: string): string[] {
			buffer += chunk;
			const lines = buffer.split(/\r\n|\r|\n/);
			buffer = lines.pop() ?? '';
			const payloads: string[] = [];
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				payloads.push(line.slice(line.startsWith('data: ') ? 6 : 5));
			}
			return payloads;
		},
		/** Anything left once the stream has ended. */
		flush(): string[] {
			const rest = buffer;
			buffer = '';
			return rest.startsWith('data:') ? [rest.slice(rest.startsWith('data: ') ? 6 : 5)] : [];
		}
	};
}

/** Stream a chat completion as text deltas, ending with a `done` event. */
export async function* streamChat(req: StreamRequest): AsyncGenerator<StreamEvent> {
	const fetchImpl = req.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await fetchImpl(joinUrl(req.endpoint, 'chat/completions'), {
			method: 'POST',
			headers: headers(req.apiKey),
			body: JSON.stringify({
				model: req.model,
				messages: req.messages,
				stream: true,
				usage: { include: true },
				...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
				...(req.temperature !== undefined && { temperature: req.temperature })
			}),
			signal: req.signal
		});
	} catch (error) {
		if (isAbort(error, req.signal)) throw new OpenRouterError('aborted', 'Request cancelled', undefined, { cause: error });
		throw new OpenRouterError('network', 'Could not reach OpenRouter', undefined, { cause: error });
	}

	if (!res.ok) throw await errorFromResponse(res);
	if (!res.body) throw new OpenRouterError('truncated', 'Response had no body');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const parser = createSseParser();
	let usage: Usage | undefined;
	let finished = false;

	const handle = (payload: string): string | null => {
		if (payload === '[DONE]') {
			finished = true;
			return null;
		}
		let json;
		try {
			json = JSON.parse(payload);
		} catch {
			return null; // A malformed line shouldn't sink an otherwise good answer.
		}
		if (json.error) {
			throw new OpenRouterError('provider', json.error.message ?? 'The model provider failed', json.error.code);
		}
		if (json.usage) {
			usage = {
				promptTokens: json.usage.prompt_tokens ?? 0,
				completionTokens: json.usage.completion_tokens ?? 0
			};
		}
		const choice = json.choices?.[0];
		if (choice?.finish_reason === 'error') {
			throw new OpenRouterError('provider', 'The model provider failed mid-answer');
		}
		const text = choice?.delta?.content;
		return typeof text === 'string' && text.length > 0 ? text : null;
	};

	try {
		while (!finished) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				if (isAbort(error, req.signal)) throw new OpenRouterError('aborted', 'Request cancelled', undefined, { cause: error });
				throw new OpenRouterError('network', 'Connection lost mid-answer', undefined, { cause: error });
			}
			const payloads = chunk.done
				? [...parser.push(decoder.decode()), ...parser.flush()]
				: parser.push(decoder.decode(chunk.value, { stream: true }));
			for (const payload of payloads) {
				const text = handle(payload);
				if (text) yield { type: 'delta', text };
				if (finished) break;
			}
			if (chunk.done) break;
		}
	} finally {
		// Stop the download if the consumer stopped early or something threw.
		reader.cancel().catch(() => {});
	}

	if (!finished) {
		if (req.signal?.aborted) throw new OpenRouterError('aborted', 'Request cancelled');
		throw new OpenRouterError('truncated', 'The answer was cut off before it finished');
	}
	yield { type: 'done', usage };
}

export interface ModelInfo {
	id: string;
	name: string;
	contextLength: number;
	/** Whether the model accepts image input — needed for sending page images. */
	acceptsImages: boolean;
	/** USD per million prompt tokens. */
	promptPricePerM: number;
}

/** The public model catalogue. Needs no API key. */
export async function listModels(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
	let res: Response;
	try {
		res = await fetchImpl(joinUrl(endpoint, 'models'));
	} catch (error) {
		throw new OpenRouterError('network', 'Could not reach OpenRouter', undefined, { cause: error });
	}
	if (!res.ok) throw await errorFromResponse(res);
	const body = await res.json();
	return (body?.data ?? []).map(
		(m: {
			id: string;
			name?: string;
			context_length?: number;
			architecture?: { input_modalities?: string[] };
			pricing?: { prompt?: string };
		}): ModelInfo => ({
			id: m.id,
			name: m.name ?? m.id,
			contextLength: m.context_length ?? 0,
			acceptsImages: m.architecture?.input_modalities?.includes('image') ?? false,
			promptPricePerM: Number(m.pricing?.prompt ?? 0) * 1e6
		})
	);
}

/** Check an API key; resolves with its label, rejects with an `auth` error if invalid. */
export async function checkApiKey(
	endpoint: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch
): Promise<{ label: string }> {
	let res: Response;
	try {
		res = await fetchImpl(joinUrl(endpoint, 'key'), { headers: headers(apiKey) });
	} catch (error) {
		throw new OpenRouterError('network', 'Could not reach OpenRouter', undefined, { cause: error });
	}
	if (!res.ok) throw await errorFromResponse(res);
	const body = await res.json();
	return { label: body?.data?.label ?? 'API key' };
}
