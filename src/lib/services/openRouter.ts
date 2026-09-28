/**
 * OpenRouter client: streaming chat completions through the app's
 * /api/openrouter relay, which adds the server's API key and default model.
 *
 * Verified against the live API: errors arrive as JSON
 * `{ error: { message, code } }` with the HTTP status, before any streaming
 * starts. Mid-stream failures arrive as a `data:` payload carrying an `error`
 * object instead of a delta.
 */

export const OPENROUTER_RELAY = '/api/openrouter';

export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | ContentPart[];
}

export type OpenRouterErrorKind =
	| 'not_configured' // the server has no API key or model
	| 'auth' // bad API key
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

/** A web page the model's search returned, from OpenRouter's `url_citation` annotations. */
export interface WebSource {
	url: string;
	title: string;
}

export type StreamEvent =
	| { type: 'delta'; text: string }
	/** Text streamed so far was the model narrating a web search, not the answer: drop it. */
	| { type: 'restart' }
	/**
	 * `model` is the one that actually answered, as reported by OpenRouter;
	 * `sources` the pages a web search returned, when one ran.
	 */
	| { type: 'done'; usage?: Usage; model?: string; sources?: WebSource[] };

/**
 * OpenRouter's web search server tool: the model decides whether to search
 * and writes its own queries. Capped at two searches of three results each —
 * uncapped, one question ran five searches and cost ~6 cents.
 */
export const WEB_SEARCH_TOOL = {
	type: 'openrouter:web_search',
	parameters: { max_results: 3, max_total_results: 6 }
} as const;
export const WEB_SEARCH_MAX_CALLS = 2;

export interface StreamRequest {
	/** Defaults to the app's relay. */
	endpoint?: string;
	/** Picks the server's model: OPENROUTER_MODEL for chat, OPENROUTER_SUMMARY_MODEL for summaries. */
	purpose?: 'chat' | 'summary';
	messages: OpenRouterMessage[];
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	/**
	 * How much the model may reason before answering. Reasoning tokens count
	 * against `maxTokens`, so a reasoning model given a small budget can spend
	 * all of it thinking and return no text. `minimal` keeps it to a few dozen
	 * tokens; `off` skips it, which models that must reason reject.
	 * Unset leaves the model's default.
	 */
	reasoning?: 'minimal' | 'off';
	/** Let the model search the web (costs extra per search). */
	webSearch?: boolean;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

function kindForStatus(status: number, code?: unknown): OpenRouterErrorKind {
	if (code === 'not_configured') return 'not_configured';
	if (status === 401 || status === 403) return 'auth';
	if (status === 402) return 'credits';
	if (status === 429) return 'rate_limit';
	if (status >= 500) return 'server';
	return 'bad_request';
}

function joinUrl(endpoint: string | undefined, path: string): string {
	return `${(endpoint ?? OPENROUTER_RELAY).replace(/\/+$/, '')}/${path}`;
}

async function errorFromResponse(res: Response): Promise<OpenRouterError> {
	let message = `${res.status} ${res.statusText}`.trim();
	let code: unknown;
	try {
		const body = await res.json();
		if (body?.error?.message) message = body.error.message;
		code = body?.error?.code;
	} catch {
		// Not JSON — keep the status line.
	}
	return new OpenRouterError(kindForStatus(res.status, code), message, res.status);
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
		const path = req.purpose === 'summary' ? 'summary/completions' : 'chat/completions';
		res = await fetchImpl(joinUrl(req.endpoint, path), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messages: req.messages,
				stream: true,
				usage: { include: true },
				...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
				...(req.temperature !== undefined && { temperature: req.temperature }),
				...(req.reasoning === 'minimal' && { reasoning: { effort: 'minimal' } }),
				...(req.reasoning === 'off' && { reasoning: { enabled: false } }),
				// max_uses is only honoured by native search; max_tool_calls caps every engine.
				...(req.webSearch && { tools: [WEB_SEARCH_TOOL], max_tool_calls: WEB_SEARCH_MAX_CALLS })
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
	let model: string | undefined;
	let finished = false;
	const sources = new Map<string, WebSource>();
	// the stream carries no marker for a search, but the model reasons again
	// after one: reasoning that follows answer text means that text came before
	// a search ("Let me look that up…") and the real answer is still to come.
	let sawText = false;
	let restart = false;

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
		if (typeof json.model === 'string' && json.model) model = json.model;
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
		for (const a of choice?.delta?.annotations ?? []) {
			const cite = a?.type === 'url_citation' ? a.url_citation : null;
			if (typeof cite?.url === 'string' && !sources.has(cite.url)) {
				sources.set(cite.url, { url: cite.url, title: typeof cite.title === 'string' && cite.title ? cite.title : cite.url });
			}
		}
		if (req.webSearch && sawText && typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning) {
			sawText = false;
			restart = true;
		}
		const text = choice?.delta?.content;
		if (typeof text !== 'string' || text.length === 0) return null;
		sawText = true;
		return text;
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
				if (restart) {
					restart = false;
					yield { type: 'restart' };
				}
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
	yield { type: 'done', usage, ...(model && { model }), ...(sources.size > 0 && { sources: [...sources.values()] }) };
}

export interface RelayStatus {
	configured: boolean;
	/** The server's OPENROUTER_MODEL. */
	model: string | null;
	/** OPENROUTER_SUMMARY_MODEL, or the chat model when that is unset. */
	summaryModel: string | null;
	missing: string[];
}

/** Whether the server has an API key and model; rejects if the relay is unreachable. */
export async function fetchRelayStatus(endpoint?: string, fetchImpl: typeof fetch = fetch): Promise<RelayStatus> {
	let res: Response;
	try {
		res = await fetchImpl(joinUrl(endpoint, 'status'));
	} catch (error) {
		throw new OpenRouterError('network', 'Could not reach the chat relay', undefined, { cause: error });
	}
	if (!res.ok) throw await errorFromResponse(res);
	const body = await res.json();
	return {
		configured: body?.configured === true,
		model: typeof body?.model === 'string' ? body.model : null,
		summaryModel: typeof body?.summaryModel === 'string' ? body.summaryModel : null,
		missing: Array.isArray(body?.missing) ? body.missing : []
	};
}

/** Check the server's API key; resolves with its label, rejects with an `auth` error if invalid. */
export async function checkConnection(endpoint?: string, fetchImpl: typeof fetch = fetch): Promise<{ label: string }> {
	let res: Response;
	try {
		res = await fetchImpl(joinUrl(endpoint, 'key'));
	} catch (error) {
		throw new OpenRouterError('network', 'Could not reach OpenRouter', undefined, { cause: error });
	}
	if (!res.ok) throw await errorFromResponse(res);
	const body = await res.json();
	return { label: body?.data?.label ?? 'API key' };
}
