import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { handlePaperRequest } from '../../../src/lib/server/paperApi';
import { createPaperStore, type PaperStore } from '../../../src/lib/server/paperStore';

let clock = 0;
let store: PaperStore;

beforeEach(() => {
	clock = 1000;
	store = createPaperStore(new DatabaseSync(':memory:'), () => clock);
});

const paper = (pdfKey: string, extra: object = {}) => ({ pdfKey, name: pdfKey.replace(/_\d+$/, ''), size: 10, ...extra });

describe('recent PDFs store', () => {
	it('keeps each device’s list apart, most recently opened first', () => {
		store.touchRecent('192.168.4.20', paper('a.pdf_10'));
		clock = 2000;
		store.touchRecent('192.168.4.20', paper('b.pdf_10'));
		store.touchRecent('192.168.4.21', paper('c.pdf_10'));

		expect(store.listRecent('192.168.4.20').map((p) => p.pdfKey)).toEqual(['b.pdf_10', 'a.pdf_10']);
		expect(store.listRecent('192.168.4.21').map((p) => p.pdfKey)).toEqual(['c.pdf_10']);
	});

	it('moves a reopened PDF to the top and keeps every one ever opened', () => {
		for (let i = 0; i < 60; i++) {
			clock = 1000 + i;
			store.touchRecent('me', paper(`p${i}.pdf_10`));
		}
		clock = 5000;
		store.touchRecent('me', paper('p0.pdf_10', { title: 'Renamed' }));
		const list = store.listRecent('me');
		expect(list).toHaveLength(60);
		expect(list[0]).toMatchObject({ pdfKey: 'p0.pdf_10', title: 'Renamed', openedAt: 5000 });
	});

	it('removes only that device’s entry', () => {
		store.touchRecent('me', paper('a.pdf_10'));
		store.touchRecent('you', paper('a.pdf_10'));
		store.deleteRecent('me', 'a.pdf_10');
		expect(store.listRecent('me')).toEqual([]);
		expect(store.listRecent('you')).toHaveLength(1);
	});
});

describe('recent PDFs routes', () => {
	const call = (client: string, method: string, path: string, query: Record<string, string> = {}, body?: unknown) =>
		handlePaperRequest(
			new Request(`http://app.local/api/papers/${path}?${new URLSearchParams(query)}`, {
				method,
				...(body !== undefined && { body: JSON.stringify(body) })
			}),
			path,
			Promise.resolve(store),
			client
		);

	it('lists, records and removes for the calling device only', async () => {
		const url = 'https://arxiv.org/pdf/1706.03762';
		expect((await call('10.0.0.2', 'PUT', 'recent', {}, paper('1706.03762_0', { url, pageCount: 15 }))).status).toBe(200);
		expect(await (await call('10.0.0.2', 'GET', 'recent')).json()).toEqual([
			{ pdfKey: '1706.03762_0', name: '1706.03762', size: 10, url, pageCount: 15, openedAt: 1000 }
		]);
		expect(await (await call('10.0.0.3', 'GET', 'recent')).json()).toEqual([]);

		await call('10.0.0.2', 'DELETE', 'recent', { key: '1706.03762_0' });
		expect(await (await call('10.0.0.2', 'GET', 'recent')).json()).toEqual([]);
	});

	it('refuses entries without a key, name or size, or with a non-web link', async () => {
		expect((await call('me', 'PUT', 'recent', {}, { name: 'x', size: 1 })).status).toBe(400);
		expect((await call('me', 'PUT', 'recent', {}, { pdfKey: 'x_1', name: 'x' })).status).toBe(400);
		expect((await call('me', 'PUT', 'recent', {}, paper('x_1', { url: 'javascript:alert(1)' }))).status).toBe(400);
	});

	it('keeps only the fields the list uses', async () => {
		await call('me', 'PUT', 'recent', {}, paper('x_1', { title: '  A title  ', pageCount: -3, secret: 'no' }));
		expect(store.listRecent('me')[0]).toEqual({ pdfKey: 'x_1', name: 'x', size: 10, title: 'A title', openedAt: 1000 });
	});
});
