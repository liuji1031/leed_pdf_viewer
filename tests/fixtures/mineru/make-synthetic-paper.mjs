/**
 * Generates synthetic-paper.pdf: a two-page, two-column "research paper" with a
 * title, abstract, numbered sections, an in-text citation, a table and a figure
 * with captions, and a reference list. Self-authored, so its MinerU output can
 * be committed as a test fixture without licensing questions.
 *
 *   node tests/fixtures/mineru/make-synthetic-paper.mjs <out.pdf>
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const W = 612, H = 792, M = 54, GUTTER = 18, COL = (W - 2 * M - GUTTER) / 2;
const doc = await PDFDocument.create();
const regular = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

function wrap(text, font, size, width) {
	const lines = [];
	let line = '';
	for (const word of text.split(' ')) {
		const next = line ? `${line} ${word}` : word;
		if (font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
	}
	if (line) lines.push(line);
	return lines;
}
function para(page, text, x, y, width, size = 10) {
	for (const l of wrap(text, regular, size, width)) { page.drawText(l, { x, y, size, font: regular }); y -= size * 1.25; }
	return y - size * 0.6;
}
function heading(page, text, x, y, size = 12) {
	page.drawText(text, { x, y, size, font: bold });
	return y - size * 1.7;
}

const lorem = (topic) =>
	`This paragraph discusses ${topic} in enough detail to span several lines of a narrow column, ` +
	`so that a layout parser has to reconstruct reading order across columns rather than following ` +
	`the order in which text was drawn. It adds a second sentence about ${topic} for good measure.`;

// Page 1
let p = doc.addPage([W, H]);
const title = 'Attention Mechanisms for Document Reading';
p.drawText(title, { x: (W - bold.widthOfTextAtSize(title, 20)) / 2, y: H - 90, size: 20, font: bold });
const authors = 'Ada Example and Grace Sample';
p.drawText(authors, { x: (W - regular.widthOfTextAtSize(authors, 11)) / 2, y: H - 115, size: 11, font: regular });
let y = heading(p, 'Abstract', (W - bold.widthOfTextAtSize('Abstract', 12)) / 2, H - 150);
y = para(p, 'We study scaled dot-product attention as a tool for reading long documents. ' + lorem('the abstract'), M + 40, y, W - 2 * M - 80);
const colTop = y - 10;
let yl = heading(p, '1 Introduction', M, colTop);
yl = para(p, lorem('the motivation'), M, yl, COL);
yl = para(p, lorem('prior approaches'), M, yl, COL);
let yr = heading(p, '2 Background', M + COL + GUTTER, colTop);
yr = para(p, lorem('recurrent models') + ' Earlier work [1] used recurrence throughout.', M + COL + GUTTER, yr, COL);
yr = para(p, lorem('convolutional models'), M + COL + GUTTER, yr, COL);

// Page 2
p = doc.addPage([W, H]);
yl = heading(p, '3 Model', M, H - 70);
yl = heading(p, '3.1 Scaled Dot-Product Attention', M, yl, 11);
yl = para(p, 'Scaled dot-product attention divides the logits by the square root of the key dimension, as in [2], which keeps the softmax away from regions with vanishing gradients.', M, yl, COL);
yl = para(p, lorem('the attention function'), M, yl, COL);
// Table with rules, caption above.
yr = H - 70;
p.drawText('Table 1: Comparison of layer types.', { x: M + COL + GUTTER, y: yr, size: 9, font: regular });
yr -= 16;
const rows = [['Layer', 'Complexity', 'Path'], ['Self-attention', 'O(n^2 d)', 'O(1)'], ['Recurrent', 'O(n d^2)', 'O(n)']];
for (const [i, row] of rows.entries()) {
	p.drawLine({ start: { x: M + COL + GUTTER, y: yr + 11 }, end: { x: W - M, y: yr + 11 }, thickness: 0.6, color: rgb(0, 0, 0) });
	row.forEach((cell, c) => p.drawText(cell, { x: M + COL + GUTTER + c * (COL / 3), y: yr, size: 9, font: i ? regular : bold }));
	yr -= 15;
}
p.drawLine({ start: { x: M + COL + GUTTER, y: yr + 11 }, end: { x: W - M, y: yr + 11 }, thickness: 0.6, color: rgb(0, 0, 0) });
yr -= 14;
// Figure with caption below.
p.drawRectangle({ x: M + COL + GUTTER + 20, y: yr - 110, width: COL - 40, height: 100, color: rgb(0.85, 0.88, 0.95), borderColor: rgb(0.2, 0.2, 0.5), borderWidth: 1 });
p.drawCircle({ x: M + COL + GUTTER + COL / 2, y: yr - 60, size: 25, color: rgb(0.4, 0.45, 0.8) });
yr -= 126;
p.drawText('Figure 1: An illustration of attention weights.', { x: M + COL + GUTTER, y: yr, size: 9, font: regular });
// References, full width.
y = Math.min(yl, yr) - 20;
y = heading(p, 'References', M, y);
y = para(p, '[1] A. Author. Learning with recurrent networks. Journal of Examples, 2020.', M, y, W - 2 * M, 9);
y = para(p, '[2] B. Author. Attention is a useful inductive bias. Proceedings of Samples, 2021.', M, y, W - 2 * M, 9);

writeFileSync(process.argv[2] ?? 'synthetic-paper.pdf', await doc.save());
