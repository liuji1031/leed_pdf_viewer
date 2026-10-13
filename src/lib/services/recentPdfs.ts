import { writable } from 'svelte/store';
import { paperApi, type PaperApi, type RecentEntry, type RecentPdf } from './paperApi';
import { storeUploadedFile } from '$lib/utils/fileStorageUtils';

/**
 * This device's recently opened PDFs, kept by the server per device (by the
 * address it connects from). Only names and links are stored: a PDF opened
 * from a link reopens from it, a local file is picked again.
 */

const PANEL_OPEN_KEY = 'leedpdf_recent_panel_open';

function initialPanelOpen(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		const raw = localStorage.getItem(PANEL_OPEN_KEY);
		if (raw === 'true' || raw === 'false') return raw === 'true';
	} catch {
		// storage unavailable: use the default
	}
	// open by default where there is room beside the page.
	return window.innerWidth >= 1024;
}

/** Whether the recent-PDF panel is showing; remembered per browser. */
export const recentPanelOpen = writable(initialPanelOpen());
recentPanelOpen.subscribe((open) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(PANEL_OPEN_KEY, String(open));
	} catch {
		// not critical
	}
});

export const recentPdfs = writable<RecentPdf[]>([]);
/** False when this server keeps no paper database, so there is no list. */
export const recentPdfsAvailable = writable(false);

export interface RecentPdfDeps {
	api: Pick<PaperApi, 'enabled' | 'listRecent' | 'touchRecent' | 'deleteRecent'>;
	now: () => number;
}

const defaults: RecentPdfDeps = { api: paperApi, now: Date.now };

export async function refreshRecentPdfs(deps: RecentPdfDeps = defaults): Promise<void> {
	const enabled = await deps.api.enabled();
	recentPdfsAvailable.set(enabled);
	if (!enabled) return;
	try {
		recentPdfs.set(await deps.api.listRecent());
	} catch (error) {
		console.warn('Could not load recent PDFs:', error);
	}
}

/** The entry for a PDF that just finished loading; null for ones not worth listing. */
export function recentEntryFor(
	source: File | string,
	pdfKey: string,
	details: { title?: string; pageCount?: number } = {}
): RecentEntry | null {
	const url = typeof source === 'string' ? source : undefined;
	// bundled templates and blob: links can't be reopened from the list.
	if (url !== undefined && !/^https?:\/\//i.test(url)) return null;
	const name = typeof source === 'string' ? pdfKey.replace(/_\d+$/, '') : source.name;
	return {
		pdfKey,
		name,
		size: typeof source === 'string' ? 0 : source.size,
		...(url && { url }),
		...(details.title && { title: details.title }),
		...(details.pageCount && { pageCount: details.pageCount })
	};
}

/** Moves the PDF to the top of the list straight away, then tells the server. */
export async function recordOpenedPdf(entry: RecentEntry, deps: RecentPdfDeps = defaults): Promise<void> {
	if (!(await deps.api.enabled())) return;
	recentPdfs.update((list) => [
		{ ...entry, openedAt: deps.now() },
		...list.filter((p) => p.pdfKey !== entry.pdfKey)
	]);
	try {
		await deps.api.touchRecent(entry);
	} catch (error) {
		console.warn('Could not record the opened PDF:', error);
	}
}

export async function removeRecentPdf(pdfKey: string, deps: RecentPdfDeps = defaults): Promise<void> {
	recentPdfs.update((list) => list.filter((p) => p.pdfKey !== pdfKey));
	try {
		await deps.api.deleteRecent(pdfKey);
	} catch (error) {
		console.warn('Could not remove the recent PDF:', error);
	}
}

/** Where a listed link reopens. */
export function recentPdfHref(pdf: RecentPdf): string | null {
	return pdf.url ? `/pdf/${encodeURIComponent(pdf.url)}` : null;
}

/**
 * Opens a file the user picked again. A full navigation, not goto(): the
 * viewer routes load their PDF once and ignore a new one on the same route.
 */
export async function openPickedFile(file: File, navigate: (href: string) => void = (href) => window.location.assign(href)) {
	const stored = await storeUploadedFile(file);
	if (!stored.success || !stored.id) throw new Error(stored.error ? String(stored.error) : 'Could not open the file.');
	navigate(`/pdf-upload?fileId=${stored.id}`);
}
