/**
 * Server-side relay to OpenRouter.
 *
 * The API key and models come from server config (OPENROUTER_API_KEY,
 * OPENROUTER_MODEL, OPENROUTER_SUMMARY_MODEL), so none of them is typed into
 * or stored by the browser. Only the routes the chat needs are relayed, so
 * this can't be used as an open proxy to the rest of the OpenRouter API.
 *
 * `summary/completions` is not an OpenRouter route: it is a chat completion
 * sent upstream with the summary model instead of the chat model.
 */

export interface OpenRouterProxyConfig {
	apiKey: string | undefined;
	/** Used when a chat request names no model. */
	model: string | undefined;
	/** Used for summary requests; falls back to `model` when unset. */
	summaryModel?: string | undefined;
	/** Defaults to https://openrouter.ai/api/v1. */
	upstream?: string;
	fetchImpl?: typeof fetch;
}

export const DEFAULT_OPENROUTER_UPSTREAM = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'LeedPDF';

/** What the browser needs to know to enable chat; never the key itself. */
export interface OpenRouterStatus {
	configured: boolean;
	model: string | null;
	/** The model summaries use: OPENROUTER_SUMMARY_MODEL, else the chat model. */
	summaryModel: string | null;
	missing: ('OPENROUTER_API_KEY' | 'OPENROUTER_MODEL')[];
}

export function relayStatus(
	config: Pick<OpenRouterProxyConfig, 'apiKey' | 'model' | 'summaryModel'>
): OpenRouterStatus {
	const apiKey = config.apiKey?.trim();
	const model = config.model?.trim() || null;
	const missing: OpenRouterStatus['missing'] = [];
	if (!apiKey) missing.push('OPENROUTER_API_KEY');
	if (!model) missing.push('OPENROUTER_MODEL');
	return { configured: missing.length === 0, model, summaryModel: summaryModelFor(config), missing };
}

function summaryModelFor(config: Pick<OpenRouterProxyConfig, 'model' | 'summaryModel'>): string | null {
	return config.summaryModel?.trim() || config.model?.trim() || null;
}

/** Errors in OpenRouter's own shape, so the client handles one format. */
function errorResponse(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export async function forwardToOpenRouter(
	request: Request,
	path: string,
	config: OpenRouterProxyConfig
): Promise<Response> {
	if (request.method === 'GET' && path === 'status') {
		return new Response(JSON.stringify(relayStatus(config)), {
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
		});
	}

	const isSummary = request.method === 'POST' && path === 'summary/completions';
	const isChat = isSummary || (request.method === 'POST' && path === 'chat/completions');
	const isKeyCheck = request.method === 'GET' && path === 'key';
	if (!isChat && !isKeyCheck) {
		return errorResponse(404, 'route_not_allowed', 'Not a chat route.');
	}

	const apiKey = config.apiKey?.trim();
	if (!apiKey) {
		return errorResponse(503, 'not_configured', 'OPENROUTER_API_KEY is not set on the server.');
	}

	let body: string | undefined;
	if (isChat) {
		let payload: Record<string, unknown>;
		try {
			payload = await request.json();
		} catch {
			return errorResponse(400, 'bad_request', 'The chat request was not valid JSON.');
		}
		if (typeof payload.model !== 'string' || !payload.model.trim()) {
			const model = isSummary ? summaryModelFor(config) : config.model?.trim();
			if (!model) return errorResponse(503, 'not_configured', 'OPENROUTER_MODEL is not set on the server.');
			payload.model = model;
		}
		body = JSON.stringify(payload);
	}

	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'X-Title': APP_TITLE };
	if (body) headers['Content-Type'] = 'application/json';
	const origin = request.headers.get('origin');
	if (origin) headers['HTTP-Referer'] = origin;

	const upstream = (config.upstream?.trim() || DEFAULT_OPENROUTER_UPSTREAM).replace(/\/+$/, '');
	const fetchImpl = config.fetchImpl ?? fetch;
	let res: Response;
	try {
		// The browser's signal: pressing Stop ends the upstream request too.
		res = await fetchImpl(`${upstream}/${isChat ? 'chat/completions' : path}`, {
			method: request.method,
			headers,
			body,
			signal: request.signal
		});
	} catch (error) {
		if (request.signal.aborted) return errorResponse(499, 'aborted', 'Request cancelled.');
		console.warn('[OpenRouter Proxy] Upstream unreachable:', error);
		return errorResponse(502, 'unreachable', 'Could not reach OpenRouter.');
	}

	// Content-Type only: the body arrives decompressed, so upstream length and
	// encoding headers would be wrong (see mineruProxy.ts).
	const out = new Headers();
	const contentType = res.headers.get('content-type');
	if (contentType) out.set('content-type', contentType);
	if (contentType?.includes('text/event-stream')) out.set('cache-control', 'no-cache');
	return new Response(res.body, { status: res.status, headers: out });
}
