import { describe, expect, it, vi } from 'vitest';
import { PaperApi, ServerChatStorage } from '../../../src/lib/services/paperApi';
import { createPaperStorage, IMPORTED_FLAG } from '../../../src/lib/services/paperStorage';
import type { ChatMessage } from '../../../src/lib/utils/chatStorage';

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function api(enabled: boolean | 'unreachable', routes: Record<string, unknown> = {}) {
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://app.local');
		const route = url.pathname.replace('/api/papers/', '');
		if (route === 'status') {
			if (enabled === 'unreachable') throw new TypeError('Failed to fetch');
			return jsonResponse({ enabled });
		}
		const key = `${init?.method ?? 'GET'} ${route}`;
		return key in routes ? jsonResponse(routes[key]) : jsonResponse({ error: { message: 'nope' } }, 404);
	});
	return { api: new PaperApi('/api/papers', fetchImpl as typeof fetch), fetchImpl };
}

function localStore() {
	return {
		isAvailable: vi.fn(async () => true),
		listSessions: vi.fn(async () => [{ id: 'local-session' }]),
		getSession: vi.fn(async () => null),
		putSession: vi.fn(async () => {}),
		deleteSession: vi.fn(async () => {}),
		listMessages: vi.fn(async () => []),
		putMessage: vi.fn(async () => {}),
		deleteByPdfKey: vi.fn(async () => {}),
		getDocument: vi.fn(async () => null),
		putDocument: vi.fn(async () => {}),
		deleteDocument: vi.fn(async () => {}),
		exportAll: vi.fn(async () => ({ sessions: [{ id: 'local-session' }], messages: [], documents: [] }))
	};
}

function flags(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), values };
}

describe('paper storage', () => {
	it('stays in the browser when the server has no paper database', async () => {
		for (const enabled of [false, 'unreachable'] as const) {
			const { api: client, fetchImpl } = api(enabled);
			const local = localStore();
			const storage = createPaperStorage({ api: client, local: local as never, localAnnotations: () => [], flags: flags() });
			expect(await storage.listSessions('p')).toEqual([{ id: 'local-session' }]);
			expect(local.exportAll).not.toHaveBeenCalled();
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		}
	});

	it('uses the server when it has one, after copying local data there once', async () => {
		const { api: client, fetchImpl } = api(true, {
			'POST import': { added: 2 },
			'GET sessions': [{ id: 'server-session' }]
		});
		const local = localStore();
		const flagStore = flags();
		const annotations = [{ pdfKey: 'p', kind: 'drawings', data: { '1': [{}] } }];
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const storage = createPaperStorage({
			api: client,
			local: local as never,
			localAnnotations: () => annotations,
			flags: flagStore
		});

		expect(await storage.listSessions('p')).toEqual([{ id: 'server-session' }]);
		expect(await storage.listSessions('p')).toEqual([{ id: 'server-session' }]);
		expect(local.listSessions).not.toHaveBeenCalled();

		const imports = fetchImpl.mock.calls.filter(([url]) => String(url).includes('/import'));
		expect(imports).toHaveLength(1);
		expect(JSON.parse(imports[0][1]!.body as string)).toEqual({
			sessions: [{ id: 'local-session' }],
			messages: [],
			documents: [],
			annotations
		});
		expect(flagStore.values.has(IMPORTED_FLAG)).toBe(true);
		log.mockRestore();
	});

	it('skips the copy once done, and retries it next time if it failed', async () => {
		const done = api(true, { 'GET sessions': [] });
		const local = localStore();
		await createPaperStorage({
			api: done.api,
			local: local as never,
			localAnnotations: () => [],
			flags: flags({ [IMPORTED_FLAG]: '1' })
		}).listSessions('p');
		expect(local.exportAll).not.toHaveBeenCalled();

		const failing = api(true, { 'GET sessions': [] }); // no import route: 404
		const flagStore = flags();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const storage = createPaperStorage({ api: failing.api, local: local as never, localAnnotations: () => [], flags: flagStore });
		expect(await storage.listSessions('p')).toEqual([]);
		expect(flagStore.values.has(IMPORTED_FLAG)).toBe(false);
		warn.mockRestore();
	});
});

describe('server chat storage', () => {
	it('shows a cut-off streaming answer as complete and hides an empty one', async () => {
		const msg = (seq: number, status: ChatMessage['status'], content: string) =>
			({ id: `m${seq}`, sessionId: 's', pdfKey: 'p', seq, role: 'assistant', content, createdAt: seq, status }) as ChatMessage;
		const { api: client } = api(true, {
			'GET messages': [msg(1, 'complete', 'q'), msg(2, 'streaming', 'partial'), msg(3, 'streaming', '')]
		});
		const messages = await new ServerChatStorage(client).listMessages('s');
		expect(messages.map((m) => [m.seq, m.status])).toEqual([
			[1, 'complete'],
			[2, 'complete']
		]);
	});

	it('passes keys in the query string and surfaces server errors', async () => {
		const { api: client, fetchImpl } = api(true, { 'GET document': null });
		await client.getDocument('a b/c#d.pdf_0');
		expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe('/api/papers/document?key=a+b%2Fc%23d.pdf_0');
		await expect(client.getSession('x')).rejects.toThrow('Paper storage: nope');
	});
});
