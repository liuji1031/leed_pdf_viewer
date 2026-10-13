import { env } from '$env/dynamic/private';
import { handlePaperRequest } from '$lib/server/paperApi';
import { getPaperStore } from '$lib/server/paperStore';
import type { RequestHandler } from './$types';

// Per-paper storage shared by every browser; see $lib/server/paperStore.ts.
// The recent-PDF list is per device, keyed by the address it connects from
// (an IPv4 client arrives as "::ffff:a.b.c.d" on a dual-stack socket).
const handler: RequestHandler = ({ request, params, getClientAddress }) => {
	let client = '';
	try {
		client = getClientAddress().replace(/^::ffff:/, '');
	} catch {
		// adapters that can't tell share one list.
	}
	return handlePaperRequest(request, params.path, getPaperStore(env.PAPER_DB_PATH), client);
};

export const GET = handler;
export const PUT = handler;
export const POST = handler;
export const DELETE = handler;
