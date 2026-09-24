import { expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * A one-page letter-size PDF with text at known coordinates, for tests that
 * need to check where things land on the page.
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

// Spread across the page so a wrong rotation or axis swap moves them visibly.
export const PROBES = [
	{ text: 'Scaled Dot-Product Attention', x: 72, y: 700, size: 18 },
	{ text: 'bottom-right probe', x: 380, y: 90, size: 14 },
	{ text: 'centre probe text', x: 230, y: 400, size: 12 }
];

// Page renders and text-layer rebuilds both wait on the pdf.js worker. With
// several browser workers in parallel that can exceed the 5s default, which
// shows up as a correctly rotated but still blank canvas — slow, not wrong.
export const RENDER_TIMEOUT = 20_000;

export async function buildProbePdf(): Promise<{ buffer: Buffer; widths: number[] }> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([PAGE_W, PAGE_H]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (const p of PROBES) page.drawText(p.text, { x: p.x, y: p.y, size: p.size, font });
	return {
		buffer: Buffer.from(await doc.save()),
		widths: PROBES.map((p) => font.widthOfTextAtSize(p.text, p.size))
	};
}

export function zoomLabel(page: Page) {
	return page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1] ?? '');
}

/** Upload the PDF and wait until the load flow has fully finished. */
export async function openPdf(page: Page, buffer: Buffer) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({ name: 'probes.pdf', mimeType: 'application/pdf', buffer });
	// Wait for the canvas to be painted at the fit scale the page-info label
	// reports. A non-trivial width alone isn't enough — an unrendered <canvas>
	// is 300×150 by default, which would let a test press keys mid-load, where
	// the load flow then resets rotation and scale.
	await expect
		.poll(
			() =>
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

/**
 * Ctrl+wheel zoom. Deliberately not Ctrl+= : keyboard zoomIn() commits the new
 * scale even when its render was skipped because another was in flight, leaving
 * the canvas stale (a pre-existing race, reproducible without the ask tool).
 * The wheel path retries until it has painted.
 */
export async function wheelZoomIn(page: Page) {
	const viewport = page.viewportSize()!;
	await page.mouse.move(viewport.width / 2, viewport.height / 2);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -240);
	await page.keyboard.up('Control');
}

/**
 * Wait until the ask tool's text layer is built, at the expected rotation, and
 * covering the canvas. Only then are on-screen coordinates final: pdf.js tags
 * the rotation in the TextLayer constructor, before spans are laid out, and the
 * canvas resizes to its rotated shape afterwards — which re-centres the whole
 * page. Coordinates read any earlier are stale.
 */
export async function waitForTextLayer(page: Page, rotation = 0) {
	await expect
		.poll(
			() =>
				page.evaluate((rot) => {
					const layer = document.querySelector('.leed-text-layer');
					const canvas = document.querySelector('canvas.shadow-lg');
					if (!layer || !canvas || layer.getAttribute('data-ready') !== 'true') return 'building';
					if (layer.getAttribute('data-main-rotation') !== String(rot)) return 'rotating';
					const a = layer.getBoundingClientRect();
					const b = canvas.getBoundingClientRect();
					const off = Math.max(
						Math.abs(a.left - b.left),
						Math.abs(a.top - b.top),
						Math.abs(a.width - b.width),
						Math.abs(a.height - b.height)
					);
					return off <= 2 ? 'ready' : `settling (${off.toFixed(1)}px off)`;
				}, rotation),
			{ timeout: RENDER_TIMEOUT }
		)
		.toBe('ready');
}

/** Rotate with the keyboard and wait until the text layer has fully settled. */
export async function rotateTo(page: Page, rotation: number) {
	for (let i = 0; i < rotation / 90; i++) await page.keyboard.press('r');
	await waitForTextLayer(page, rotation);
}
