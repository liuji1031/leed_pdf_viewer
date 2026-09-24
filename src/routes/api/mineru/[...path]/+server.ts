import { env } from '$env/dynamic/private';
import { forwardToMinerU } from '$lib/server/mineruProxy';
import type { RequestHandler } from './$types';

// Same-origin relay to the MinerU parse API; see $lib/server/mineruProxy.ts.
// MINERU_URL is the upstream (e.g. http://mineru:8000 in docker compose, or
// https://mineru.net/api); MINERU_API_KEY is optional.
const handler: RequestHandler = ({ request, params }) =>
	forwardToMinerU(request, params.path, {
		upstream: env.MINERU_URL,
		apiKey: env.MINERU_API_KEY
	});

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
