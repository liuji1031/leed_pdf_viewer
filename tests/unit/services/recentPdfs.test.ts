import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	recentEntryFor,
	recentPdfHref,
	recentPdfs,
	recentPdfsAvailable,
	recordOpenedPdf,
	refreshRecentPdfs,
	removeRecentPdf,
	type RecentPdfDeps
} from '../../../src/lib/services/recentPdfs';

function deps(enabled = true) {
	const api = {
		enabled: vi.fn(async () => enabled),
		listRecent: vi.fn(async () => [{ pdfKey: 'a.pdf_1', name: 'a.pdf', size: 1, openedAt: 5 }]),
		touchRecent: vi.fn(async () => {}),
		deleteRecent: vi.fn(async () => {})
	};
	return { api, deps: { api, now: () => 100 } as unknown as RecentPdfDeps };
}

beforeEach(() => {
	recentPdfs.set([]);
	recentPdfsAvailable.set(false);
});

describe('recent PDFs', () => {
	it('describes a local file by its name and a link by its address', () => {
		const file = new File([new Uint8Array(42)], 'paper.pdf');
		expect(recentEntryFor(file, 'paper.pdf_42', { title: 'A Paper', pageCount: 9 })).toEqual({
			pdfKey: 'paper.pdf_42',
			name: 'paper.pdf',
			size: 42,
			title: 'A Paper',
			pageCount: 9
		});
		expect(recentEntryFor('https://arxiv.org/pdf/1706.03762', '1706.03762_0')).toEqual({
			pdfKey: '1706.03762_0',
			name: '1706.03762',
			size: 0,
			url: 'https://arxiv.org/pdf/1706.03762'
		});
	});

	it('leaves out bundled templates and blob links, which the list could not reopen', () => {
		expect(recentEntryFor('/templates/grid.pdf', 'grid_0')).toBeNull();
		expect(recentEntryFor('blob:http://x/1', 'x_0')).toBeNull();
	});

	it('loads the list only where the server keeps one', async () => {
		const off = deps(false);
		await refreshRecentPdfs(off.deps);
		expect(get(recentPdfsAvailable)).toBe(false);
		expect(off.api.listRecent).not.toHaveBeenCalled();

		const on = deps();
		await refreshRecentPdfs(on.deps);
		expect(get(recentPdfsAvailable)).toBe(true);
		expect(get(recentPdfs).map((p) => p.pdfKey)).toEqual(['a.pdf_1']);
	});

	it('moves an opened PDF to the top at once and tells the server', async () => {
		const { api, deps: d } = deps();
		recentPdfs.set([
			{ pdfKey: 'b.pdf_1', name: 'b.pdf', size: 1, openedAt: 2 },
			{ pdfKey: 'a.pdf_1', name: 'a.pdf', size: 1, openedAt: 1 }
		]);
		await recordOpenedPdf({ pdfKey: 'a.pdf_1', name: 'a.pdf', size: 1 }, d);
		expect(get(recentPdfs).map((p) => [p.pdfKey, p.openedAt])).toEqual([
			['a.pdf_1', 100],
			['b.pdf_1', 2]
		]);
		expect(api.touchRecent).toHaveBeenCalledWith({ pdfKey: 'a.pdf_1', name: 'a.pdf', size: 1 });

		await removeRecentPdf('b.pdf_1', d);
		expect(get(recentPdfs).map((p) => p.pdfKey)).toEqual(['a.pdf_1']);
		expect(api.deleteRecent).toHaveBeenCalledWith('b.pdf_1');
	});

	it('reopens a link through the URL route; a local file has no link', () => {
		expect(recentPdfHref({ pdfKey: 'k', name: 'n', size: 0, url: 'https://a.org/x.pdf?y=1', openedAt: 1 })).toBe(
			'/pdf/https%3A%2F%2Fa.org%2Fx.pdf%3Fy%3D1'
		);
		expect(recentPdfHref({ pdfKey: 'k', name: 'n', size: 3, openedAt: 1 })).toBeNull();
	});
});
