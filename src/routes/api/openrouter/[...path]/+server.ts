import { env } from '$env/dynamic/private';
import { forwardToOpenRouter } from '$lib/server/openRouterProxy';
import type { RequestHandler } from './$types';

// Same-origin relay to OpenRouter; see $lib/server/openRouterProxy.ts.
const handler: RequestHandler = ({ request, params }) =>
	forwardToOpenRouter(request, params.path, {
		apiKey: env.OPENROUTER_API_KEY,
		model: env.OPENROUTER_MODEL,
		summaryModel: env.OPENROUTER_SUMMARY_MODEL,
		upstream: env.OPENROUTER_URL
	});

export const GET = handler;
export const POST = handler;
