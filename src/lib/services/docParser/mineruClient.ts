/**
 * Client for the MinerU 4 parse API (local server and mineru.net share it),
 * reached through the app's /api/mineru relay.
 *
 * Verified against a live 4.0.7 server:
 *  - Upload flow: POST /v1/uploads → PUT /v1/uploads/{id}/content →
 *    POST /v1/uploads/{id}/complete gives a file id. Inline base64 sources are
 *    capped at 1 MiB, too small for most papers, so they aren't used.
 *  - The upload response carries an absolute `upload_url` built from the
 *    server's own host (e.g. http://mineru:8000/… inside docker), unreachable
 *    from a browser — the relay route is always used instead.
 *  - A job must name its tier: a server running only `flash` rejects an
 *    untiered job with `quality_tier_unavailable`.
 *  - Progress is per file (0/1 → 1/1), not per page.
 */

export type ParseErrorKind =
	| 'not_configured' // the relay has no MINERU_URL
	| 'unreachable'
	| 'timeout'
	| 'auth'
	| 'tier_unavailable'
	| 'too_large'
	| 'rejected' // other 4xx
	| 'server' // other 5xx
	| 'failed' // the parse job itself failed
	| 'malformed' // missing or unreadable output
	| 'aborted';

export class ParseError extends Error {
	constructor(
		readonly kind: ParseErrorKind,
		message: string,
		readonly details: { status?: number; code?: string } = {},
		options?: { cause?: unknown }
	) {
		super(message, options);
		this.name = 'ParseError';
	}

	/** Worth retrying automatically: the server may be fine a moment later. */
	get transient(): boolean {
		return this.kind === 'unreachable' || this.kind === 'timeout' || this.kind === 'server';
	}
}

export type ParseStage = 'uploading' | 'queued' | 'parsing' | 'downloading';

export interface ParseOptions {
	tier: string;
	signal?: AbortSignal;
	onStage?: (stage: ParseStage) => void;
	pollIntervalMs?: number;
}

/** Best-first. `advanced` is slower and meant for difficult documents. */
const TIER_PREFERENCE = ['standard', 'advanced', 'basic', 'flash'];

/** The tier to request: the user's choice if the server offers it, else the best offered. */
export function pickTier(available: readonly string[], preferred?: string): string | null {
	if (preferred && preferred !== 'auto' && available.includes(preferred)) return preferred;
	return TIER_PREFERENCE.find((t) => available.includes(t)) ?? available[0] ?? null;
}

const TERMINAL = new Set(['completed', 'partial', 'failed', 'canceled']);

function kindFor(status: number, code?: string): ParseErrorKind {
	if (code === 'parser_not_configured') return 'not_configured';
	if (code === 'parser_unreachable') return 'unreachable';
	if (code === 'parser_timeout') return 'timeout';
	if (code === 'quality_tier_unavailable') return 'tier_unavailable';
	if (code === 'file_too_large' || status === 413) return 'too_large';
	if (status === 401 || status === 403) return 'auth';
	if (status === 502 || status === 503 || status === 504) return 'server';
	if (status >= 500) return 'server';
	return 'rejected';
}

export class MinerUClient {
	private readonly endpoint: string;
	private readonly apiKey?: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: { endpoint?: string; apiKey?: string; fetchImpl?: typeof fetch } = {}) {
		this.endpoint = (options.endpoint ?? '/api/mineru').replace(/\/+$/, '');
		this.apiKey = options.apiKey?.trim() || undefined;
		this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
	}

	private async request<T>(
		method: string,
		path: string,
		init: { json?: unknown; body?: BodyInit; contentType?: string; signal?: AbortSignal } = {}
	): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		let body = init.body;
		if (init.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(init.json);
		} else if (init.contentType) {
			headers['Content-Type'] = init.contentType;
		}

		let res: Response;
		try {
			res = await this.fetchImpl(`${this.endpoint}/${path}`, { method, headers, body, signal: init.signal });
		} catch (error) {
			if (init.signal?.aborted) throw new ParseError('aborted', 'Parsing cancelled', {}, { cause: error });
			throw new ParseError('unreachable', 'Could not reach the document parser', {}, { cause: error });
		}

		if (!res.ok) {
			let code: string | undefined;
			let message = `${res.status} ${res.statusText}`.trim();
			try {
				const err = (await res.json())?.error;
				code = err?.code;
				if (err?.message) message = err.message;
			} catch {
				// not JSON
			}
			throw new ParseError(kindFor(res.status, code), message, { status: res.status, code });
		}
		const text = await res.text();
		try {
			return (text ? JSON.parse(text) : {}) as T;
		} catch (error) {
			throw new ParseError('malformed', 'The parser returned unreadable data', {}, { cause: error });
		}
	}

	/** Tiers this server actually runs, from /v1/tiers. */
	async tiers(signal?: AbortSignal): Promise<string[]> {
		const res = await this.request<{ data?: { id: string }[] }>('GET', 'v1/tiers', { signal });
		return (res.data ?? []).map((t) => t.id);
	}

	async health(signal?: AbortSignal): Promise<{ version: string }> {
		return this.request('GET', 'v1/health', { signal });
	}

	/** Parse a PDF and return MinerU's raw `structured_content`. */
	async parse(pdf: Uint8Array, filename: string, options: ParseOptions): Promise<unknown> {
		const { signal, onStage } = options;
		const poll = options.pollIntervalMs ?? 1000;

		onStage?.('uploading');
		const upload = await this.request<{ id: string }>('POST', 'v1/uploads', {
			json: { filename, bytes: pdf.byteLength, mime_type: 'application/pdf', purpose: 'parse' },
			signal
		});
		// Deliberately not upload.upload_url: see the note at the top.
		await this.request('PUT', `v1/uploads/${upload.id}/content`, {
			body: pdf as unknown as BodyInit,
			contentType: 'application/pdf',
			signal
		});
		const done = await this.request<{ file?: { id: string } }>('POST', `v1/uploads/${upload.id}/complete`, {
			json: {},
			signal
		});
		const fileId = done.file?.id;
		if (!fileId) throw new ParseError('malformed', 'Upload finished without a file id');

		let job = await this.request<Job>('POST', 'v1/parse/jobs', {
			json: {
				files: [{ source: { type: 'file_id', file_id: fileId } }],
				tier: options.tier,
				output_formats: ['structured_content']
			},
			signal
		});
		onStage?.(job.status === 'running' ? 'parsing' : 'queued');

		try {
			while (!TERMINAL.has(job.status)) {
				await delay(poll, signal);
				job = await this.request<Job>('GET', `v1/parse/jobs/${job.job_id}`, { signal });
				onStage?.(job.status === 'queued' ? 'queued' : 'parsing');
			}
		} catch (error) {
			if (signal?.aborted) {
				// Free the server; don't let a cancelled parse keep it busy.
				this.request('DELETE', `v1/parse/jobs/${job.job_id}`).catch(() => {});
				throw new ParseError('aborted', 'Parsing cancelled', {}, { cause: error });
			}
			throw error;
		}

		const file = job.files?.[0];
		if (job.status === 'canceled') throw new ParseError('aborted', 'The parse job was cancelled');
		if (!file || file.status !== 'completed') {
			throw new ParseError('failed', file?.error?.message ?? 'The parser could not read this document', {
				code: file?.error?.code
			});
		}
		const outputId = file.output_files?.structured_content?.file_id;
		if (!outputId) throw new ParseError('malformed', 'The parser returned no structured content');

		onStage?.('downloading');
		return this.request('GET', `v1/files/${outputId}/content`, { signal });
	}
}

interface Job {
	job_id: string;
	status: string;
	files?: {
		status: string;
		error?: { code?: string; message?: string } | null;
		output_files?: { structured_content?: { file_id: string } | null } | null;
	}[];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}
