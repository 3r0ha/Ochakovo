// Картинки для README: слайды презентации и полосы из экранов телефона.
// Берёт готовую презентацию docs/brand/deck/index.html и снимки scripts/deck-shots.mjs из docs/brand/deck/shots,
// кладёт WebP в docs/readme. Пересобрать после правок презентации или снимков: node scripts/readme-images.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const sharp = createRequire(import.meta.url)("sharp");
const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}docs/readme`;
const shots = `${root}docs/brand/deck/shots`;
mkdirSync(out, { recursive: true });

// Слайды по ключу из комментария <!-- NN. ключ --> в index.html: номера могут сдвинуться, ключи нет
const slides = ["cover", "noticed", "idea", "system", "images", "messages", "legend", "focus", "path", "analogs", "materials", "merch", "video", "reliable", "rules", "secondary", "launch"];

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await tab.goto(`${pathToFileURL(`${root}docs/brand/deck/index.html`).href}?static`, { waitUntil: "networkidle" });
await tab.evaluate(() => document.fonts.ready);
await tab.addStyleTag({ content: ".slide{--sw:1600px!important;width:1600px!important;height:900px!important;margin:0 auto 20px!important}" });
const keys = await tab.evaluate(() => {
  const map = {};
  let n = 0;
  for (const node of document.body.childNodes) {
    if (node.nodeType === Node.COMMENT_NODE) {
      const m = node.textContent.trim().match(/^\d+\.\s+(\S+)/);
      if (m) map[m[1]] = n;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.matches("section.slide")) n++;
  }
  return map;
});
for (const key of slides) {
  if (keys[key] === undefined) throw new Error(`нет слайда ${key}`);
  const png = await tab.locator(".slide").nth(keys[key]).screenshot();
  await sharp(png).resize({ width: 1280 }).webp({ quality: 82 }).toFile(`${out}/slide-${key}.webp`);
  console.log(`docs/readme/slide-${key}.webp`);
}
await browser.close();

// Полоса телефонов: экраны со скруглёнными углами на тёмном фоне сайта
async function strip(name, files) {
  const w = 300;
  const h = Math.round((w * 1688) / 780);
  const gap = 28;
  const pad = 36;
  const r = 30;
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
  const phones = await Promise.all(
    files.map((f) =>
      sharp(`${shots}/${f}.webp`)
        .resize({ width: w, height: h, fit: "cover", position: "top" })
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer(),
    ),
  );
  const width = pad * 2 + files.length * w + (files.length - 1) * gap;
  await sharp({ create: { width, height: h + pad * 2, channels: 4, background: "#161616" } })
    .composite(phones.map((input, i) => ({ input, left: pad + i * (w + gap), top: pad })))
    .webp({ quality: 84 })
    .toFile(`${out}/${name}.webp`);
  console.log(`docs/readme/${name}.webp`);
}

await strip("phones-start", ["home", "money", "quiz", "game"]);
await strip("phones-company", ["myth", "path", "history", "company-quiz"]);
await strip("phones-apply", ["vacancies", "apply", "status", "checkin"]);
await strip("phones-chat", ["chat", "mentors", "focus"]);
