import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
	enabled: true,
	annotations: {} as Record<string, Record<string, Record<string, unknown[]>>>,
	saves: [] as { pdfKey: string; kind: string; data: Record<string, unknown[]> }[],
	failSaves: false
}));

vi.mock('../../../src/lib/services/paperApi', () => ({
	paperApi: {
		get knownEnabled() {
			return server.enabled;
		},
		enabled: async () => server.enabled,
		getAnnotations: async (pdfKey: string) => structuredClone(server.annotations[pdfKey] ?? {}),
		putAnnotations: async (pdfKey: string, kind: string, data: Record<string, unknown[]>) => {
			if (server.failSaves) throw new Error('offline');
			server.saves.push({ pdfKey, kind, data });
		}
	}
}));

import {
	addStickyNoteAnnotation,
	arrowAnnotations,
	drawingPaths,
	flushServerSaves,
	setCurrentPDF,
	stickyNoteAnnotations
} from '../../../src/lib/stores/drawingStore';

const UNSYNCED = 'leedpdf_unsynced_annotations';
const memory = new Map<string, string>();
const storage = () => (globalThis as any).testHelpers.localStorageMock;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let n = 0;
/** A fresh paper per test: the store keeps module-level state. */
function paper() {
	const name = `sync-${++n}.pdf`;
	return { name, size: 100, key: `${name}_100` };
}

const stroke = (color: string) => ({ tool: 'pencil', color, lineWidth: 2, points: [], pageNumber: 1 });
const note = { id: 'n1', pageNumber: 1, x: 0.1, y: 0.1, content: 'hi', color: '#FFF59D', width: 120, height: 80 };

beforeEach(() => {
	memory.clear();
	server.enabled = true;
	server.annotations = {};
	server.saves = [];
	server.failSaves = false;
	storage().getItem.mockImplementation((k: string) => memory.get(k) ?? null);
	storage().setItem.mockImplementation((k: string, v: string) => void memory.set(k, v));
	storage().removeItem.mockImplementation((k: string) => void memory.delete(k));
});

async function open(p: ReturnType<typeof paper>) {
	setCurrentPDF(p.name, p.size);
	await settle();
	await flushServerSaves();
}

describe('annotation sync with the paper database', () => {
	it("replaces this browser's copy with the server's when a paper opens", async () => {
		const p = paper();
		memory.set(`leedpdf_drawings_${p.key}`, JSON.stringify({ '1': [stroke('#111111')] }));
		server.annotations[p.key] = { drawings: { '1': [stroke('#222222')] } };

		await open(p);

		expect(get(drawingPaths).get(1)?.map((s) => s.color)).toEqual(['#222222']);
		expect(JSON.parse(memory.get(`leedpdf_drawings_${p.key}`)!)['1'][0].color).toBe('#222222');
		expect(server.saves).toEqual([]);
	});

	it('sends edits to the server and clears their unsynced mark once saved', async () => {
		const p = paper();
		await open(p);

		addStickyNoteAnnotation(note as never);
		expect(JSON.parse(memory.get(UNSYNCED)!)).toContain(`stickyNotes\n${p.key}`);
		await flushServerSaves();

		expect(server.saves).toEqual([{ pdfKey: p.key, kind: 'stickyNotes', data: { '1': [note] } }]);
		expect(JSON.parse(memory.get(UNSYNCED)!)).not.toContain(`stickyNotes\n${p.key}`);
	});

	it('uploads kinds this browser has but the server lacks', async () => {
		const p = paper();
		memory.set(`leedpdf_arrow_annotations_${p.key}`, JSON.stringify({ '2': [{ id: 'a1' }] }));

		await open(p);

		expect(server.saves).toEqual([{ pdfKey: p.key, kind: 'arrows', data: { '2': [{ id: 'a1' }] } }]);
		expect(get(arrowAnnotations).get(2)).toEqual([{ id: 'a1' }]);
	});

	it("keeps edits the server never received instead of taking the server's copy", async () => {
		const p = paper();
		server.failSaves = true;
		await open(p);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		addStickyNoteAnnotation(note as never);
		await flushServerSaves();
		warn.mockRestore();
		expect(JSON.parse(memory.get(UNSYNCED)!)).toContain(`stickyNotes\n${p.key}`);

		// later: the server is back, with an older copy from another browser
		server.failSaves = false;
		server.annotations[p.key] = { stickyNotes: {} };
		setCurrentPDF('elsewhere.pdf', 1);
		await open(p);

		expect(get(stickyNoteAnnotations).get(1)).toEqual([note]);
		expect(server.saves.at(-1)).toEqual({ pdfKey: p.key, kind: 'stickyNotes', data: { '1': [note] } });
	});

	it('does nothing extra without a paper database', async () => {
		server.enabled = false;
		const p = paper();
		await open(p);
		addStickyNoteAnnotation(note as never);
		await flushServerSaves();

		expect(server.saves).toEqual([]);
		expect(memory.has(UNSYNCED)).toBe(false);
		expect(JSON.parse(memory.get(`leedpdf_sticky_note_annotations_${p.key}`)!)).toEqual({ '1': [note] });
	});
});
