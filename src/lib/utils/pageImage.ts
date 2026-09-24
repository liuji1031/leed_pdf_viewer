import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * A page rendered offscreen as a data: URL, for multimodal models. Equations
 * and figures are exactly what text extraction loses (the fast parsing tier
 * doesn't transcribe equations at all), so an image of the page is often the
 * only way the model can see them.
 *
 * Rendered from the document, not copied from the on-screen canvas: the page
 * asked about need not be the page being viewed.
 */
export async function renderPageImage(
	doc: PDFDocumentProxy,
	pageNumber: number,
	maxWidth = 1400
): Promise<string> {
	const page = await doc.getPage(pageNumber);
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: Math.min(2, maxWidth / base.width) });
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas is unavailable');
	// Transparent areas would come out black in JPEG.
	context.fillStyle = '#fff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: context, viewport, canvas }).promise;

	// WebP where the browser can encode it (Safari can't, and silently returns PNG).
	const webp = canvas.toDataURL('image/webp', 0.8);
	return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}
