import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../src/lib/utils/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('newId', () => {
	it('uses randomUUID where the browser has it', () => {
		expect(newId()).toMatch(V4);
	});

	it('builds a v4 UUID outside a secure context, where randomUUID is missing', () => {
		const real = globalThis.crypto;
		vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
		const ids = new Set(Array.from({ length: 50 }, () => newId()));
		expect(ids.size).toBe(50);
		for (const id of ids) expect(id).toMatch(V4);
	});
});
