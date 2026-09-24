import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildProbePdf, openPdf, PROBES, waitForTextLayer } from './helpers/probePdf';

/**
 * The chat flow end to end, in a real browser: parse → select → ask → stream →
 * highlight → follow-up → reload. MinerU is mocked with its real 4.0.7 output
 * for the probe PDF; OpenRouter with a streamed answer. No live services.
 */

const TITLE = PROBES[0].text;
const STRUCTURED = readFileSync(new URL('../fixtures/mineru/probes.structured_content.json', import.meta.url), 'utf8');
const ANSWERS = [
	['Scaling by ', '$\\sqrt{d_k}$', ' keeps the softmax gradients healthy.'],
	['By the square root of the key dimension.']
];

let fixture: Buffer;

test.beforeAll(async () => {
	({ buffer: fixture } = await buildProbePdf());
});

/** A MinerU server behind the app's relay that parses the probe PDF. */
async function mockParser(page: Page, { configured = true } = {}) {
	const json = (body: unknown, status = 200) => ({
		status,
		contentType: 'application/json',
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	await page.route('**/api/mineru/v1/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.replace('/api/mineru/', '');
		const method = route.request().method();
		if (!configured) {
			return route.fulfill(json({ error: { code: 'parser_not_configured', message: 'not configured' } }, 503));
		}
		if (path === 'v1/tiers') return route.fulfill(json({ data: [{ id: 'flash' }] }));
		if (path === 'v1/uploads') return route.fulfill(json({ id: 'upload_1', status: 'pending' }));
		if (path === 'v1/uploads/upload_1/content') return route.fulfill(json({}));
		if (path === 'v1/uploads/upload_1/complete') return route.fulfill(json({ file: { id: 'file-1' } }));
		if (path === 'v1/parse/jobs' && method === 'POST') return route.fulfill(json({ job_id: 'job_1', status: 'queued' }, 202));
		if (path === 'v1/parse/jobs/job_1') {
			return route.fulfill(
				json({
					job_id: 'job_1',
					status: 'completed',
					files: [{ status: 'completed', output_files: { structured_content: { file_id: 'file-out' } } }]
				})
			);
		}
		if (path === 'v1/files/file-out/content') return route.fulfill(json(STRUCTURED));
		return route.fulfill(json({ error: { code: 'unexpected', message: path } }, 404));
	});
}

/** OpenRouter answering with the next scripted, streamed answer; records request bodies. */
async function mockOpenRouter(page: Page) {
	const requests: { messages: { role: string; content: unknown }[]; model: string }[] = [];
	await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
		const body = JSON.parse(route.request().postData() ?? '{}');
		requests.push(body);
		const chunks = ANSWERS[Math.min(requests.length - 1, ANSWERS.length - 1)];
		const sse =
			chunks.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join('') +
			'data: [DONE]\n\n';
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
			body: sse
		});
	});
	return requests;
}

async function addApiKey(page: Page) {
	await page.getByTestId('chat-needs-key').getByRole('button', { name: 'Add API key' }).click();
	await page.getByLabel('API key', { exact: true }).fill('sk-or-v1-test');
	await page.getByTestId('chat-settings-save').click();
	await expect(page.getByTestId('chat-needs-key')).toBeHidden();
}

async function selectTitle(page: Page) {
	await page.keyboard.press('8');
	await waitForTextLayer(page);
	const box = (await page.locator('.leed-text-layer span', { hasText: TITLE }).first().boundingBox())!;
	await page.mouse.move(box.x + 1, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();
}

const assistant = (page: Page) => page.getByTestId('chat-message-assistant');

test.describe('Paper chat', () => {
	test.skip(({ isMobile }) => isMobile, 'Mouse selection and keyboard shortcuts');
	test.describe.configure({ timeout: 120_000 });

	test('asks about a passage, streams the answer, and keeps the conversation', async ({ page }) => {
		await mockParser(page);
		const requests = await mockOpenRouter(page);
		await openPdf(page, fixture);

		await page.keyboard.press('c');
		await expect(page.getByTestId('chat-panel')).toBeVisible();
		await addApiKey(page);
		await expect(page.getByTestId('parse-status')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

		// Ask
		await selectTitle(page);
		await page.getByTestId('ask-selection-chip').click();
		await expect(page.getByTestId('chat-quote')).toContainText(TITLE);
		await page.getByTestId('chat-input').fill('Why is it scaled?');
		await page.keyboard.press('Enter');

		await expect(assistant(page).first()).toHaveAttribute('data-status', 'complete');
		await expect(assistant(page).first()).toContainText('keeps the softmax gradients healthy');
		await expect(assistant(page).first().locator('.katex')).toHaveCount(1);
		await expect(page.locator('.chat-highlight-rect')).toHaveCount(1);

		// What was sent: the paper in the system message, the passage in the first question.
		const first = requests[0];
		expect(first.messages.map((m) => m.role)).toEqual(['system', 'user']);
		expect(String(first.messages[0].content)).toContain('<paper>');
		expect(String(first.messages[1].content)).toContain('Location: page 1 of 1');
		expect(String(first.messages[1].content)).toContain(`<selection>${TITLE}</selection>`);
		expect(String(first.messages[1].content)).toMatch(/Why is it scaled\?$/);

		// Follow up: the pinned context once, then only the new question.
		await page.getByTestId('chat-input').fill('By how much?');
		await page.keyboard.press('Enter');
		await expect(assistant(page)).toHaveCount(2);
		await expect(assistant(page).nth(1)).toHaveAttribute('data-status', 'complete');
		const second = requests[1];
		expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
		expect(second.messages[1].content).toEqual(first.messages[1].content);
		expect(second.messages[3].content).toBe('By how much?');

		// Reload and reopen the same file: highlight and conversation are still there.
		await page.reload();
		await openPdf(page, fixture);
		await expect(page.locator('.chat-highlight-rect')).toHaveCount(1);
		if (!(await page.getByTestId('chat-panel').isVisible())) await page.keyboard.press('c');
		await page.getByTestId('chat-session-item').first().click();
		await expect(page.getByTestId('chat-message-user')).toHaveText(['Why is it scaled?', 'By how much?']);
		await expect(assistant(page)).toHaveCount(2);
	});

	test('explains what is missing before a question can be asked', async ({ page }) => {
		await mockParser(page, { configured: false });
		await openPdf(page, fixture);
		await page.keyboard.press('c');

		await expect(page.getByTestId('chat-needs-key')).toBeVisible();
		await expect(page.getByTestId('parse-status')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
		await expect(page.getByTestId('parse-status')).toContainText('isn’t set up on this server');

		await selectTitle(page);
		await page.getByTestId('ask-selection-chip').click();
		await page.getByTestId('chat-input').fill('Anything?');
		await expect(page.getByTestId('chat-send')).toBeDisabled();
		await expect(page.getByTestId('chat-panel')).toContainText('Add your API key in settings');
	});
});
