import type { AnnotationPages, PaperImport, PaperStore } from './paperStore';

/**
 * HTTP interface to the paper store, served at /api/papers/*.
 *
 * Keys and ids travel in the query string rather than the path: a pdfKey is a
 * file name, which may contain characters a path segment can't carry cleanly.
 * Errors use the same `{ error: { code, message } }` shape as the other relays.
 */

const MAX_KEY_LENGTH = 1024;
const KIND = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
	});
}

function errorResponse(status: number, code: string, message: string): Response {
	return json({ error: { code, message } }, status);
}

class BadRequest extends Error {}

function param(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (!value || value.length > MAX_KEY_LENGTH) throw new BadRequest(`Missing or invalid "${name}".`);
	return value;
}

async function body(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = await request.json();
	} catch {
		throw new BadRequest('The request body was not valid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('Expected a JSON object.');
	return value as Record<string, unknown>;
}

const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LENGTH;

function requireFields(record: Record<string, unknown>, what: string, keys: string[], numbers: string[] = []) {
	for (const k of keys) if (!isKey(record[k])) throw new BadRequest(`${what} needs a "${k}".`);
	for (const k of numbers) if (!Number.isFinite(record[k])) throw new BadRequest(`${what} needs a numeric "${k}".`);
}

const checkDocument = (d: Record<string, unknown>) => requireFields(d, 'A document', ['pdfKey']);
const checkSession = (s: Record<string, unknown>) => requireFields(s, 'A session', ['id', 'pdfKey'], ['createdAt']);
const checkMessage = (m: Record<string, unknown>) =>
	requireFields(m, 'A message', ['id', 'sessionId', 'pdfKey'], ['seq']);

function checkPages(data: Record<string, unknown>) {
	for (const items of Object.values(data)) {
		if (!Array.isArray(items)) throw new BadRequest('Annotations must map page numbers to arrays.');
	}
}

function listOf(value: unknown, what: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((v) => v && typeof v === 'object')) {
		throw new BadRequest(`"${what}" must be an array of objects.`);
	}
	return value as Record<string, unknown>[];
}

function parseImport(raw: Record<string, unknown>): PaperImport {
	const documents = listOf(raw.documents, 'documents');
	const sessions = listOf(raw.sessions, 'sessions');
	const messages = listOf(raw.messages, 'messages');
	const annotations = listOf(raw.annotations, 'annotations');
	documents.forEach(checkDocument);
	sessions.forEach(checkSession);
	messages.forEach(checkMessage);
	for (const a of annotations) {
		requireFields(a, 'An annotation set', ['pdfKey', 'kind']);
		if (!KIND.test(a.kind as string)) throw new BadRequest('Invalid annotation kind.');
		if (!a.data || typeof a.data !== 'object' || Array.isArray(a.data)) throw new BadRequest('Invalid annotation data.');
		checkPages(a.data as Record<string, unknown>);
	}
	return { documents, sessions, messages, annotations } as unknown as PaperImport;
}

export async function handlePaperRequest(
	request: Request,
	path: string,
	store: Promise<PaperStore> | null
): Promise<Response> {
	const url = new URL(request.url);
	const route = `${request.method} ${path}`;

	if (route === 'GET status') return json({ enabled: store !== null });
	if (!store) return errorResponse(503, 'disabled', 'Paper storage is not configured on this server (PAPER_DB_PATH).');

	try {
		const db = await store;
		switch (route) {
			case 'GET document':
				return json(db.getDocument(param(url, 'key')));
			case 'PUT document': {
				const doc = await body(request);
				checkDocument(doc);
				db.putDocument(doc as never);
				return json({ ok: true });
			}
			case 'DELETE document':
				db.deleteDocument(param(url, 'key'));
				return json({ ok: true });

			case 'GET sessions':
				return json(db.listSessions(param(url, 'key')));
			case 'DELETE sessions':
				db.deleteByPdfKey(param(url, 'key'));
				return json({ ok: true });

			case 'GET session':
				return json(db.getSession(param(url, 'id')));
			case 'PUT session': {
				const session = await body(request);
				checkSession(session);
				db.putSession(session as never);
				return json({ ok: true });
			}
			case 'DELETE session':
				db.deleteSession(param(url, 'id'));
				return json({ ok: true });

			case 'GET messages':
				return json(db.listMessages(param(url, 'session')));
			case 'PUT message': {
				const message = await body(request);
				checkMessage(message);
				db.putMessage(message as never);
				return json({ ok: true });
			}

			case 'GET annotations':
				return json(db.getAnnotations(param(url, 'key')));
			case 'PUT annotations': {
				const key = param(url, 'key');
				const kind = param(url, 'kind');
				if (!KIND.test(kind)) throw new BadRequest('Invalid annotation kind.');
				const data = await body(request);
				checkPages(data);
				db.putAnnotations(key, kind, data as AnnotationPages);
				return json({ ok: true });
			}

			case 'POST import':
				return json(db.importMissing(parseImport(await body(request))));

			default:
				return errorResponse(404, 'route_not_allowed', 'Not a paper storage route.');
		}
	} catch (error) {
		if (error instanceof BadRequest) return errorResponse(400, 'bad_request', error.message);
		const message = error instanceof Error ? error.message : String(error);
		if (/constraint/i.test(message)) return errorResponse(409, 'conflict', message);
		console.error('[Paper Store] Request failed:', error);
		return errorResponse(500, 'storage_error', 'Paper storage failed.');
	}
}
