import { describe, it, expect } from 'vitest';
import { POST } from '../../../src/routes/api/search/+server';

function post(origin: string, host: string) {
	const request = new Request(`http://${host}/api/search`, {
		method: 'POST',
		headers: { origin, host, 'content-type': 'application/json' },
		body: JSON.stringify({ query: '' })
	});
	return POST({ request } as Parameters<typeof POST>[0]) as Promise<Response>;
}

describe('search route origin check', () => {
	it('accepts the page’s own host under any name it was opened by', async () => {
		for (const host of ['leed-pdf-viewer.local:5173', '192.168.4.45:3000']) {
			// past the origin check, the empty query is what gets rejected.
			expect((await post(`http://${host}`, host)).status).toBe(400);
		}
	});

	it('still refuses other sites', async () => {
		expect((await post('http://evil.test', 'leed-pdf-viewer.local:5173')).status).toBe(403);
	});
});
