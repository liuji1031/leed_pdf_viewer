import { expect, test, type Page } from '@playwright/test';
import {
	buildProbePdf,
	openPdf,
	PAGE_H,
	PAGE_W,
	PROBE_FILE_NAME,
	PROBES,
	rotateTo,
	waitForTextLayer
} from './helpers/probePdf';

/**
 * Chat highlights render over their passage at any rotation, show a summary card
 * in the left margin on hover, and never get in the way of existing tools.
 * Highlights are seeded into localStorage — which also exercises loading them
 * when the document is opened.
 */

let fixture: Buffer;
let titleWidth: number;

test.beforeAll(async () => {
	const built = await buildProbePdf();
	fixture = built.buffer;
	titleWidth = built.widths[0];
});

/** The title's glyph box from its known PDF position and Helvetica's metrics. */
function titleRect() {
	const p = PROBES[0];
	const top = p.y + 0.718 * p.size; // ascent, PDF units (y up)
	const bottom = p.y - 0.207 * p.size; // descent
	return {
		x: p.x / PAGE_W,
		y: (PAGE_H - top) / PAGE_H,
		w: titleWidth / PAGE_W,
		h: (top - bottom) / PAGE_H
	};
}

async function openWithHighlight(page: Page) {
	await openPdf(page, fixture, async () => {
		const key = `leedpdf_chat_highlights_${PROBE_FILE_NAME}_${fixture.length}`;
		const highlight = {
			id: 'h-title',
			pageNumber: 1,
			sessionId: 's-title',
			rects: [titleRect()],
			anchor: {
				pageNumber: 1,
				text: PROBES[0].text,
				charStart: 0,
				charEnd: PROBES[0].text.length,
				itemStart: 0,
				itemEnd: 0,
				prefix: '',
				suffix: ' bottom-right probe',
				textHash: '00000000'
			},
			createdAt: 1,
			ordinal: 1,
			summaryStatus: 'ready',
			summary: 'Dot products are scaled by 1/√dk to keep softmax gradients healthy.',
			messageCount: 4
		};
		await page.evaluate(
			([k, v]) => localStorage.setItem(k, v),
			[key, JSON.stringify({ '1': [highlight] })] as const
		);
	});
}

const highlightRect = (page: Page) => page.locator('.chat-highlight-rect').first();
const card = (page: Page) => page.getByTestId('chat-highlight-card');

async function box(page: Page, selector: string) {
	return (await page.locator(selector).first().boundingBox())!;
}

test.describe('Chat highlights', () => {
	test.skip(({ isMobile }) => isMobile, 'Hover and keyboard shortcuts');
	test.describe.configure({ timeout: 90_000 });

	for (const rotation of [0, 90]) {
		test(`render over their passage at ${rotation}°`, async ({ page }) => {
			await openWithHighlight(page);
			await expect(highlightRect(page)).toBeVisible();

			// Compare with where pdf.js's own text layer puts the title.
			await page.keyboard.press('8');
			await waitForTextLayer(page);
			if (rotation) await rotateTo(page, rotation);

			const title = await box(page, `.leed-text-layer span:text-is("${PROBES[0].text}")`);
			const hl = (await highlightRect(page).boundingBox())!;
			const tolerance = 4;
			expect(Math.abs(hl.x + hl.width / 2 - (title.x + title.width / 2))).toBeLessThan(tolerance);
			expect(Math.abs(hl.y + hl.height / 2 - (title.y + title.height / 2))).toBeLessThan(tolerance);
			// The long axis of the text is exact; the short one differs by line height.
			if (rotation === 0) expect(Math.abs(hl.width - title.width)).toBeLessThan(tolerance);
			else expect(Math.abs(hl.height - title.height)).toBeLessThan(tolerance);
		});
	}

	test('hovering shows the summary card in the left margin, and leaving hides it', async ({
		page
	}) => {
		await openWithHighlight(page);
		const hl = (await highlightRect(page).boundingBox())!;
		await page.mouse.move(hl.x + hl.width / 2, hl.y + hl.height / 2);

		await expect(card(page)).toBeVisible();
		await expect(card(page)).toContainText('Dot products are scaled');
		await expect(card(page)).toContainText(PROBES[0].text);
		await expect(card(page)).toContainText('4 messages');

		const pageBox = await box(page, 'canvas.shadow-lg');
		const cardBox = (await card(page).boundingBox())!;
		expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(pageBox.x);

		await page.mouse.move(5, pageBox.y + pageBox.height / 2);
		await expect(card(page)).toBeHidden();
	});

	test('show in every tool, and the pencil still draws straight across them', async ({ page }) => {
		await openWithHighlight(page);
		await page.keyboard.press('1');
		await expect(highlightRect(page)).toBeVisible();

		const hl = (await highlightRect(page).boundingBox())!;
		await page.mouse.move(hl.x + 5, hl.y + hl.height / 2);
		await page.mouse.down();
		await page.mouse.move(hl.x + hl.width - 5, hl.y + hl.height / 2 + 30, { steps: 10 });
		await page.mouse.up();

		await expect
			.poll(() =>
				page.evaluate(() =>
					Object.keys(localStorage)
						.filter((k) => k.startsWith('leedpdf_drawings_'))
						.reduce((n, k) => {
							const pages = JSON.parse(localStorage.getItem(k) || '{}') as Record<string, unknown[]>;
							return n + Object.values(pages).reduce((m, paths) => m + paths.length, 0);
						}, 0)
				)
			)
			.toBe(1);
	});
});
