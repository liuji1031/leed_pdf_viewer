import { env } from '$env/dynamic/private';
import { handlePaperRequest } from '$lib/server/paperApi';
import { getPaperStore } from '$lib/server/paperStore';
import type { RequestHandler } from './$types';

// Per-paper storage shared by every browser; see $lib/server/paperStore.ts.
const handler: RequestHandler = ({ request, params }) =>
	handlePaperRequest(request, params.path, getPaperStore(env.PAPER_DB_PATH));

export const GET = handler;
export const PUT = handler;
export const POST = handler;
export const DELETE = handler;
