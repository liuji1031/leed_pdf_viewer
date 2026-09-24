/**
 * Server-side relay to a MinerU parse API.
 *
 * Browsers can't call MinerU directly: neither the local server nor
 * mineru.net answers CORS preflights (both return 405), so the app talks to
 * this same-origin route instead. The upstream comes from server config —
 * never from the request — and only the routes the parse flow needs are
 * relayed, so this can't be used as an open proxy.
 */

export interface MinerUProxyConfig {
	/** e.g. http://mineru:8000 or https://mineru.net/api. Unset: parsing is off. */
	upstream: string | undefined;
	/** Used when the browser sends no Authorization of its own. */
	apiKey?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const ID = '[A-Za-z0-9_-]{1,128}';
const ROUTES: Array<[method: string, pattern: RegExp]> = [
	['GET', /^v1\/health$/],
	['GET', /^v1\/tiers$/],
	['POST', /^v1\/uploads$/],
	['PUT', new RegExp(`^v1/uploads/${ID}/content$`)],
	['POST', new RegExp(`^v1/uploads/${ID}/(complete|cancel)$`)],
	['POST', /^v1\/parse\/jobs$/],
	['GET', new RegExp(`^v1/parse/jobs/${ID}$`)],
	['DELETE', new RegExp(`^v1/parse/jobs/${ID}$`)],
	['GET', new RegExp(`^v1/files/${ID}/content$`)],
	['DELETE', new RegExp(`^v1/files/${ID}$`)]
];

export function isAllowedRoute(method: string, path: string): boolean {
	return ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

/** Errors in MinerU's own shape, so the client handles one format. */
function errorResponse(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type: 'proxy_error', code, message } }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export async function forwardToMinerU(
	request: Request,
	path: string,
	config: MinerUProxyConfig
): Promise<Response> {
	const upstream = config.upstream?.trim().replace(/\/+$/, '');
	if (!upstream) {
		return errorResponse(
			503,
			'parser_not_configured',
			'Document parsing is not configured on this server (set MINERU_URL).'
		);
	}
	if (!isAllowedRoute(request.method, path)) {
		return errorResponse(404, 'route_not_allowed', 'Not a document-parser route.');
	}

	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > MAX_UPLOAD_BYTES) {
		return errorResponse(413, 'file_too_large', 'That file is too large to parse.');
	}

	const headers: Record<string, string> = {};
	const contentType = request.headers.get('content-type');
	if (contentType) headers['Content-Type'] = contentType;
	const auth = request.headers.get('authorization') || (config.apiKey ? `Bearer ${config.apiKey}` : '');
	if (auth) headers['Authorization'] = auth;
	// Deliberately nothing else: no cookies, no forwarding of client identity.

	let body: ArrayBuffer | undefined;
	if (request.method !== 'GET' && request.method !== 'DELETE') {
		body = await request.arrayBuffer();
		if (body.byteLength > MAX_UPLOAD_BYTES) {
			return errorResponse(413, 'file_too_large', 'That file is too large to parse.');
		}
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const fetchImpl = config.fetchImpl ?? fetch;
	const search = new URL(request.url).search;

	let res: Response;
	try {
		res = await fetchImpl(`${upstream}/${path}${search}`, {
			method: request.method,
			headers,
			body,
			signal: controller.signal
		});
	} catch (error) {
		console.warn('[MinerU Proxy] Upstream unreachable:', upstream, error);
		return controller.signal.aborted
			? errorResponse(504, 'parser_timeout', 'The document parser took too long to respond.')
			: errorResponse(502, 'parser_unreachable', 'Could not reach the document parser.');
	} finally {
		clearTimeout(timer);
	}

	const out = new Headers();
	for (const name of ['content-type', 'content-length', 'content-disposition']) {
		const value = res.headers.get(name);
		if (value) out.set(name, value);
	}
	return new Response(res.body, { status: res.status, headers: out });
}
