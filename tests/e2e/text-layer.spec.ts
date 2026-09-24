import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * The ask tool's pdf.js text layer must sit exactly over the rendered glyphs at
 * every rotation and zoom, or selections land on the wrong words. Rotation is
 * the fragile part: pdf.js positions spans in unrotated space and rotates the
 * container with CSS, so an axis swap shows up only at 90°/270° — and in one
 * past regression, only after zooming.
 */

const PAGE_W = 612;
const PAGE_H = 792;
// Probes spread across the page so a wrong rotation or axis swap moves them visibly.
const PROBES = [
	{ text: 'Scaled Dot-Product Attention', x: 72, y: 700, size: 18 },
	{ text: 'bottom-right probe', x: 380, y: 90, size: 14 },
	{ text: 'centre probe text', x: 230, y: 400, size: 12 }
];
const CONTAINER_TOLERANCE_PX = 2;
const PROBE_TOLERANCE = 0.012; // fraction of the page, ~7pt on letter
// Page renders and text-layer rebuilds both wait on the pdf.js worker. With
// several browser workers in parallel that can exceed the 5s default, which
// shows up as a correctly rotated but still blank canvas — slow, not wrong.
const RENDER_TIMEOUT = 20_000;

let fixture: Buffer;
let probeWidths: number[];

test.beforeAll(async () => {
	const doc = await PDFDocument.create();
	const pdfPage = doc.addPage([PAGE_W, PAGE_H]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (const p of PROBES) pdfPage.drawText(p.text, { x: p.x, y: p.y, size: p.size, font });
	probeWidths = PROBES.map((p) => font.widthOfTextAtSize(p.text, p.size));
	fixture = Buffer.from(await doc.save());
});

async function openFixture(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({ name: 'probes.pdf', mimeType: 'application/pdf', buffer: fixture });
	// Wait until the load flow has finished: the canvas is painted at the fit
	// scale the page-info label reports. Checking only for a non-trivial width is
	// not enough — an unrendered <canvas> is 300×150 by default, which would let
	// the test press keys mid-load, where the load flow then resets rotation/scale.
	await expect
		.poll(() =>
			page.evaluate((pageW) => {
				const c = document.querySelector('canvas.shadow-lg');
				const zoom = Number(document.body.innerText.match(/(\d+)%/)?.[1]);
				if (!c || !zoom) return false;
				const expected = (pageW * zoom) / 100;
				return Math.abs(c.getBoundingClientRect().width - expected) < 0.02 * expected;
			}, PAGE_W),
			{ timeout: RENDER_TIMEOUT }
		)
		.toBe(true);
}

function zoomLabel(page: Page) {
	return page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1] ?? '');
}

/**
 * Ctrl+wheel zoom. Deliberately not Ctrl+= : keyboard zoomIn() commits the new
 * scale even when its render was skipped because another was in flight, leaving
 * the canvas stale (a pre-existing race, reproducible without the ask tool).
 * The wheel path retries until it has painted, so it tests the text layer and
 * not that race. It also runs the layer through the CSS-transform phase.
 */
async function wheelZoomIn(page: Page) {
	const viewport = page.viewportSize()!;
	await page.mouse.move(viewport.width / 2, viewport.height / 2);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -240);
	await page.keyboard.up('Control');
}

/**
 * Returns 'ok', or a description of what is misaligned — so a polling failure
 * reports the last measurement rather than just "expected true".
 */
async function alignment(page: Page, rotation: number): Promise<string> {
	const m = await page.evaluate((texts) => {
		const layerEl = document.querySelector('.leed-text-layer');
		const canvasEl = document.querySelector('canvas.shadow-lg');
		if (!layerEl || !canvasEl) return null;
		const rect = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { l: r.left, t: r.top, w: r.width, h: r.height };
		};
		const spans = [...layerEl.querySelectorAll('span')];
		return {
			canvas: rect(canvasEl),
			layer: rect(layerEl),
			rotation: layerEl.getAttribute('data-main-rotation'),
			probes: texts.map((t) => {
				const s = spans.find((el) => el.textContent === t);
				return s ? rect(s) : null;
			})
		};
	}, PROBES.map((p) => p.text));

	if (!m) return 'text layer not mounted';
	if (m.rotation !== String(rotation)) return `waiting for rotation ${rotation}, have ${m.rotation}`;

	const containerErr = Math.max(
		Math.abs(m.layer.l - m.canvas.l),
		Math.abs(m.layer.t - m.canvas.t),
		Math.abs(m.layer.w - m.canvas.w),
		Math.abs(m.layer.h - m.canvas.h)
	);
	if (containerErr > CONTAINER_TOLERANCE_PX) {
		return `layer ${m.layer.w.toFixed(0)}x${m.layer.h.toFixed(0)} vs canvas ${m.canvas.w.toFixed(0)}x${m.canvas.h.toFixed(0)} (off by ${containerErr.toFixed(1)}px)`;
	}

	for (const [i, r] of m.probes.entries()) {
		if (!r) return `no span for "${PROBES[i].text}"`;
		const u = (r.l + r.w / 2 - m.canvas.l) / m.canvas.w;
		const v = (r.t + r.h / 2 - m.canvas.t) / m.canvas.h;
		// Back to unrotated page space.
		const [u0, v0] =
			rotation === 90 ? [v, 1 - u] : rotation === 180 ? [1 - u, 1 - v] : rotation === 270 ? [1 - v, u] : [u, v];
		const p = PROBES[i];
		const expectedU = (p.x + probeWidths[i] / 2) / PAGE_W;
		// Glyph box centre sits a little above the baseline.
		const expectedV = (PAGE_H - (p.y + 0.22 * p.size)) / PAGE_H;
		const err = Math.max(Math.abs(u0 - expectedU), Math.abs(v0 - expectedV));
		if (err > PROBE_TOLERANCE) return `"${p.text}" off by ${err.toFixed(4)} of the page`;
	}
	return 'ok';
}

test.describe('Ask tool text layer', () => {
	test.skip(({ isMobile }) => isMobile, 'Driven by keyboard shortcuts');
	test.describe.configure({ timeout: 90_000 });

	for (const rotation of [0, 90, 180, 270]) {
		test(`aligns with the page at ${rotation}° before and after zooming`, async ({ page }) => {
			await openFixture(page);
			await page.keyboard.press('8');
			for (let i = 0; i < rotation / 90; i++) await page.keyboard.press('r');

			await expect.poll(() => alignment(page, rotation), { timeout: RENDER_TIMEOUT }).toBe('ok');

			const before = await zoomLabel(page);
			await wheelZoomIn(page);
			await expect.poll(() => zoomLabel(page), { timeout: RENDER_TIMEOUT }).not.toBe(before);
			await expect.poll(() => alignment(page, rotation), { timeout: RENDER_TIMEOUT }).toBe('ok');
		});
	}

	test('is only in the DOM while the ask tool is active', async ({ page }) => {
		await openFixture(page);
		const layer = page.locator('.leed-text-layer');
		await expect(layer).toHaveCount(0);

		await page.keyboard.press('8');
		await expect(layer).toHaveCount(1);
		await expect(layer.locator('span').first()).toBeAttached();

		await page.keyboard.press('1');
		await expect(layer).toHaveCount(0);
	});
});
