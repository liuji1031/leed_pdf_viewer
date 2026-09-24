import { expect, test, type Page } from '@playwright/test';
import { buildProbePdf, openPdf, PROBES, rotateTo, waitForTextLayer } from './helpers/probePdf';

/**
 * Selecting text with the ask tool: the selection is captured as a durable
 * anchor, shown as a chip, and survives rotation. The ask tool must also leave
 * every existing tool's behaviour untouched.
 */

const TITLE = PROBES[0].text; // 'Scaled Dot-Product Attention'
const POSITION_TOLERANCE_PX = 5;

let fixture: Buffer;

test.beforeAll(async () => {
	({ buffer: fixture } = await buildProbePdf());
});

function titleSpan(page: Page) {
	return page.locator('.leed-text-layer span', { hasText: TITLE }).first();
}

/**
 * Drag across a span along its reading direction, which the page rotation
 * turns: left→right at 0°, top→bottom at 90°, and so on. Starting and ending
 * 1px inside the span resolves to the boundaries before its first and after
 * its last character.
 */
async function dragAcross(page: Page, rotation: number) {
	const box = (await titleSpan(page).boundingBox())!;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const [from, to] = {
		0: [
			[box.x + 1, cy],
			[box.x + box.width - 1, cy]
		],
		90: [
			[cx, box.y + 1],
			[cx, box.y + box.height - 1]
		],
		180: [
			[box.x + box.width - 1, cy],
			[box.x + 1, cy]
		],
		270: [
			[cx, box.y + box.height - 1],
			[cx, box.y + 1]
		]
	}[rotation as 0 | 90 | 180 | 270];
	await page.mouse.move(from[0], from[1]);
	await page.mouse.down();
	await page.mouse.move(to[0], to[1], { steps: 10 });
	await page.mouse.up();
}

/** The pending-selection highlight must sit on the title's glyphs. */
async function expectHighlightOnTitle(page: Page) {
	const rects = page.locator('.ask-selection-rect');
	await expect(rects.first()).toBeVisible();
	const span = (await titleSpan(page).boundingBox())!;
	const boxes = (await rects.evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		})
	)) as { x: number; y: number; width: number; height: number }[];
	const union = {
		left: Math.min(...boxes.map((b) => b.x)),
		top: Math.min(...boxes.map((b) => b.y)),
		right: Math.max(...boxes.map((b) => b.x + b.width)),
		bottom: Math.max(...boxes.map((b) => b.y + b.height))
	};
	expect(Math.abs(union.left - span.x)).toBeLessThan(POSITION_TOLERANCE_PX);
	expect(Math.abs(union.top - span.y)).toBeLessThan(POSITION_TOLERANCE_PX);
	expect(Math.abs(union.right - (span.x + span.width))).toBeLessThan(POSITION_TOLERANCE_PX);
	expect(Math.abs(union.bottom - (span.y + span.height))).toBeLessThan(POSITION_TOLERANCE_PX);
}

function drawingPathCount(page: Page) {
	return page.evaluate(() =>
		Object.keys(localStorage)
			.filter((k) => k.startsWith('leedpdf_drawings_'))
			.reduce((n, k) => {
				const pages = JSON.parse(localStorage.getItem(k) || '{}') as Record<string, unknown[]>;
				return n + Object.values(pages).reduce((m, paths) => m + paths.length, 0);
			}, 0)
	);
}

test.describe('Ask tool selection', () => {
	test.skip(({ isMobile }) => isMobile, 'Mouse text selection; touch selection is out of scope for v1');
	test.describe.configure({ timeout: 90_000 });

	const chip = (page: Page) => page.getByTestId('ask-selection-chip');

	test.beforeEach(async ({ page }) => {
		await openPdf(page, fixture);
		await page.keyboard.press('8');
		await waitForTextLayer(page);
	});

	test('captures a drag-selection and offers to ask about it', async ({ page }) => {
		await dragAcross(page, 0);
		await expect(chip(page)).toBeVisible();
		await expect(chip(page)).toContainText(`Ask about “${TITLE}”`);
		await expectHighlightOnTitle(page);
	});

	for (const rotation of [90, 180, 270]) {
		test(`captures the same words when selecting on a page rotated ${rotation}°`, async ({
			page
		}) => {
			await rotateTo(page, rotation);
			await dragAcross(page, rotation);
			await expect(chip(page)).toContainText(`Ask about “${TITLE}”`);
			await expectHighlightOnTitle(page);
		});
	}

	test('keeps the selection on the same words after rotating the page', async ({ page }) => {
		await dragAcross(page, 0);
		await expect(chip(page)).toBeVisible();

		await rotateTo(page, 90);
		await expect(chip(page)).toContainText(`Ask about “${TITLE}”`);
		await expectHighlightOnTitle(page);
	});

	test('a plain click on the page clears the selection', async ({ page }) => {
		await dragAcross(page, 0);
		await expect(chip(page)).toBeVisible();

		const layer = (await page.locator('.leed-text-layer').boundingBox())!;
		await page.mouse.click(layer.x + layer.width / 2, layer.y + layer.height * 0.6);
		await expect(chip(page)).toBeHidden();
	});

	test('Escape clears the selection', async ({ page }) => {
		await dragAcross(page, 0);
		await expect(chip(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(chip(page)).toBeHidden();
	});

	test('leaving the ask tool clears the selection', async ({ page }) => {
		await dragAcross(page, 0);
		await expect(chip(page)).toBeVisible();
		await page.keyboard.press('1');
		await page.keyboard.press('8');
		await waitForTextLayer(page);
		await expect(chip(page)).toBeHidden();
	});

	test('right-click on text is left to the browser, and still suppressed elsewhere', async ({
		page
	}) => {
		const prevented = (selector: string) =>
			page.evaluate((sel) => {
				const target = document.querySelector(sel)!;
				const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
				target.dispatchEvent(event);
				return event.defaultPrevented;
			}, selector);

		expect(await prevented('.leed-text-layer span')).toBe(false);

		await page.keyboard.press('1');
		expect(await prevented('canvas.drawing-canvas')).toBe(true);
	});
});

test.describe('Ask tool isolation', () => {
	test.skip(({ isMobile }) => isMobile, 'Driven by mouse and keyboard');
	test.describe.configure({ timeout: 90_000 });

	test('dragging in ask mode draws nothing; the pencil still draws', async ({ page }) => {
		await openPdf(page, fixture);
		const canvas = (await page.locator('canvas.drawing-canvas').boundingBox())!;
		const stroke = async () => {
			await page.mouse.move(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.5);
			await page.mouse.down();
			await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.55, {
				steps: 10
			});
			await page.mouse.up();
		};

		await page.keyboard.press('8');
		await waitForTextLayer(page);
		await stroke();
		expect(await drawingPathCount(page)).toBe(0);

		await page.keyboard.press('1');
		await stroke();
		await expect.poll(() => drawingPathCount(page)).toBe(1);
	});
});
