import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePaperRequest } from '../../../src/lib/server/paperApi';
import { createPaperStore, type PaperStore } from '../../../src/lib/server/paperStore';

const KEY = 'my paper #1?.pdf_0';

let store: PaperStore;
let db: Promise<PaperStore>;

beforeEach(() => {
	store = createPaperStore(new DatabaseSync(':memory:'));
	db = Promise.resolve(store);
});

function call(method: string, path: string, query: Record<string, string> = {}, body?: unknown) {
	const url = `http://app.local/api/papers/${path}?${new URLSearchParams(query)}`;
	const request = new Request(url, {
		method,
		...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) })
	});
	return handlePaperRequest(request, path, db);
}

const session = { id: 's1', pdfKey: KEY, createdAt: 1, title: 't' };

describe('paper API', () => {
	it('reports whether storage is configured, and refuses everything else without it', async () => {
		expect(await (await call('GET', 'status')).json()).toEqual({ enabled: true });

		const off = (method: string, path: string) =>
			handlePaperRequest(new Request(`http://app.local/api/papers/${path}`, { method }), path, null);
		expect(await (await off('GET', 'status')).json()).toEqual({ enabled: false });
		const res = await off('GET', 'sessions');
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('disabled');
	});

	it('round-trips a document for a key with characters a path could not carry', async () => {
		expect(await (await call('GET', 'document', { key: KEY })).json()).toBeNull();
		expect((await call('PUT', 'document', {}, { pdfKey: KEY, title: 'T' })).status).toBe(200);
		expect(await (await call('GET', 'document', { key: KEY })).json()).toEqual({ pdfKey: KEY, title: 'T' });
		await call('DELETE', 'document', { key: KEY });
		expect(await (await call('GET', 'document', { key: KEY })).json()).toBeNull();
	});

	it('stores sessions and messages, and deletes a paper’s chats', async () => {
		await call('PUT', 'session', {}, session);
		await call('PUT', 'message', {}, { id: 'm1', sessionId: 's1', pdfKey: KEY, seq: 1, content: 'hi' });
		expect(await (await call('GET', 'sessions', { key: KEY })).json()).toEqual([session]);
		expect(await (await call('GET', 'session', { id: 's1' })).json()).toEqual(session);
		expect((await (await call('GET', 'messages', { session: 's1' })).json())[0].content).toBe('hi');

		await call('DELETE', 'sessions', { key: KEY });
		expect(await (await call('GET', 'sessions', { key: KEY })).json()).toEqual([]);
		expect(await (await call('GET', 'messages', { session: 's1' })).json()).toEqual([]);
	});

	it('saves annotations per kind', async () => {
		await call('PUT', 'annotations', { key: KEY, kind: 'drawings' }, { '1': [{ id: 'd' }] });
		expect(await (await call('GET', 'annotations', { key: KEY })).json()).toEqual({
			drawings: { '1': [{ id: 'd' }] }
		});
	});

	it('imports local data without overwriting', async () => {
		await call('PUT', 'session', {}, session);
		const res = await call('POST', 'import', {}, {
			sessions: [{ ...session, title: 'local' }],
			annotations: [{ pdfKey: KEY, kind: 'arrows', data: { '2': [] } }]
		});
		expect(await res.json()).toEqual({ added: 1 });
		expect(store.getSession('s1')?.title).toBe('t');
	});

	it.each<[string, string, Record<string, string>, unknown, string]>([
		['GET', 'document', {}, undefined, 'missing key'],
		['PUT', 'document', {}, '{nope', 'invalid JSON'],
		['PUT', 'document', {}, [1], 'not an object'],
		['PUT', 'session', {}, { id: 's', pdfKey: KEY }, 'no createdAt'],
		['PUT', 'message', {}, { id: 'm', sessionId: 's', pdfKey: KEY }, 'no seq'],
		['PUT', 'annotations', { key: KEY, kind: '../x' }, {}, 'bad kind'],
		['PUT', 'annotations', { key: KEY, kind: 'drawings' }, { '1': 'x' }, 'pages not arrays'],
		['POST', 'import', {}, { sessions: 'x' }, 'import lists not arrays']
	])('rejects %s %s (%s)', async (method, path, query, body) => {
		const res = await call(method, path, query, body);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('bad_request');
	});

	it('refuses unknown routes and reports conflicts', async () => {
		expect((await call('GET', 'everything')).status).toBe(404);
		expect((await call('POST', 'document', {}, { pdfKey: KEY })).status).toBe(404);

		await call('PUT', 'message', {}, { id: 'a', sessionId: 's', pdfKey: KEY, seq: 1 });
		const clash = await call('PUT', 'message', {}, { id: 'b', sessionId: 's', pdfKey: KEY, seq: 1 });
		expect(clash.status).toBe(409);
	});

	it('hides storage failures behind a generic 500', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		db = Promise.reject(new Error('disk I/O error at /data/leedpdf.db'));
		const res = await call('GET', 'sessions', { key: KEY });
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain('/data');
		error.mockRestore();
	});
});
