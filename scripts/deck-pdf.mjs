// Презентация HR-бренда в PDF: docs/brand/deck/index.html → docs/brand/deck/ochakovo-smena.pdf, слайд 1920 × 1080 px на страницу.
// Картинки — из public/ и docs/brand/ по относительным путям, поэтому страница открывается прямо из папки проекта.
// Запуск: node scripts/deck-pdf.mjs  (нужны playwright с Chromium из node_modules проекта)
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const decks = [["index.html", "ochakovo-smena.pdf"]];

const browser = await chromium.launch();
for (const [name, pdf] of decks) {
  const page = `${root}docs/brand/deck/${name}`;
  const out = `${root}docs/brand/deck/${pdf}`;
  const tab = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  // ?static — все слайды лентой в конечном виде, без показа и анимаций (docs/brand/deck/deck.js)
  await tab.goto(`${pathToFileURL(page).href}?static`, {
    waitUntil: "networkidle",
  });
  await tab.evaluate(() => document.fonts.ready);
  // Картинки с loading="lazy" ниже первого экрана — грузим все до печати
  await tab.evaluate(async () => {
    for (const img of document.images) img.loading = "eager";
    const done = (img) =>
      new Promise((r) => {
        img.addEventListener("load", r, { once: true });
        img.addEventListener("error", r, { once: true });
      });
    await Promise.all(
      [...document.images].map((img) => (img.complete ? null : done(img))),
    );
  });
  const broken = await tab.evaluate(() =>
    [...document.images]
      .filter((i) => !i.naturalWidth)
      .map((i) => i.getAttribute("src")),
  );
  if (broken.length)
    throw new Error(`не загрузились картинки: ${broken.join(", ")}`);

  // WebP и PNG Chromium кладёт в PDF без сжатия — файл вырастает до десятков мегабайт. JPEG он берёт как есть,
  // поэтому перед печатью растровые картинки подменяются копиями в JPEG. Текст и пиктограммы остаются векторными
  const work = mkdtempSync(join(tmpdir(), "deck-pdf-"));
  const sources = await tab.evaluate(() => [
    ...new Set(
      [...document.images]
        .map((i) => i.src)
        .filter((u) => /\.(webp|png)$/i.test(u)),
    ),
  ]);
  const swap = {};
  for (const [n, url] of sources.entries()) {
    // Квасыч и мемы с прозрачным фоном стоят поверх тёмных слайдов и снимков: в JPEG фон стал бы белым прямоугольником.
    // Их оставляем PNG с палитрой, это рисунки с плоскими цветами, и файл выходит небольшим
    const { isOpaque } = await sharp(fileURLToPath(url)).stats();
    const file = join(work, `${n}.${isOpaque ? "jpg" : "png"}`);
    const img = sharp(fileURLToPath(url));
    await (isOpaque
      ? img.flatten({ background: "#ffffff" }).jpeg({ quality: 84, mozjpeg: true })
      : img.resize({ height: 900, withoutEnlargement: true }).png({ palette: true, quality: 90, compressionLevel: 9 })
    ).toFile(file);
    swap[url] = pathToFileURL(file).href;
  }
  await tab.evaluate(async (swap) => {
    const imgs = [...document.images].filter((i) => swap[i.src]);
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise((r) => {
            img.addEventListener("load", r, { once: true });
            img.addEventListener("error", r, { once: true });
            img.src = swap[img.src];
          }),
      ),
    );
  }, swap);
  const slides = await tab.locator(".slide").count();
  await tab.pdf({
    path: out,
    width: "1920px",
    height: "1080px",
    printBackground: true,
    preferCSSPageSize: true,
  });
  await tab.close();
  rmSync(work, { recursive: true, force: true });
  console.log(
    `docs/brand/deck/${pdf}  ${slides} слайдов, ${Math.round(statSync(out).size / 1024)} КБ`,
  );
}
await browser.close();
