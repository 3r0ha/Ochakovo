// Превью макетов для страницы /materials и документов docs/brand/*.md: листовки, стенд, мерч.
// Снимает прямо с файлов docs/brand/**.html (скрипты макетов лежат рядом и работают с диска) → docs/brand/img/*.webp.
// Перезапускать после правки любого макета. Обложки роликов снимает отдельный scripts/clip-covers.mjs.
// Запуск: node scripts/materials-previews.mjs  (нужны playwright с Chromium и sharp из node_modules проекта)
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const root = fileURLToPath(new URL('..', import.meta.url))
const brand = `${root}docs/brand/`
const out = `${brand}img/`

const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })

async function open(rel, css = '') {
  await tab.goto(pathToFileURL(brand + rel).href)
  if (css) await tab.addStyleTag({ content: css })
  await tab.evaluate(() => document.fonts.ready)
  await tab.waitForTimeout(400)
}

/**
 * Снимок элемента → webp заданной ширины; keep — доля высоты сверху, которую оставить.
 * По краю срезаем 2 px (1 px макета): на дробных координатах в кадр попадает полоска тёмного фона страницы
 */
async function shot(selector, name, width, { keep = 1, quality = 80 } = {}) {
  const png = await tab.locator(selector).first().screenshot()
  const { width: w, height: h } = await sharp(png).metadata()
  const img = sharp(await sharp(png).extract({ left: 2, top: 2, width: w - 4, height: Math.round((h - 4) * keep) }).toBuffer())
  const info = await img.resize({ width }).webp({ quality }).toFile(`${out}${name}.webp`)
  console.log(`docs/brand/img/${name}.webp  ${info.width} × ${info.height}  ${Math.round(info.size / 1024)} КБ`)
}

// Листовки: лицевая и оборот, 640 px по ширине
for (const [file, name] of [
  ['leaflet-a5.html', 'leaflet-a5'],
  ['insert-vuz.html', 'insert-vuz'],
  ['first-shift-a6.html', 'first-shift-a6'],
]) {
  await open(`print/${file}`)
  await shot('section.sheet:nth-of-type(1)', `${name}-1`, 640, { quality: 82 })
  await shot('section.sheet:nth-of-type(2)', `${name}-2`, 640, { quality: 82 })
}

// Стенд: ролл-ап — только видимая часть, без основания (1850 из 2000 мм); табличка — целиком.
// Окно предпросмотра крупнее обычного, чтобы мелкий текст не расплылся
await open('stand/rollup.html', ':root { --view: 0.2 !important; }')
await shot('.view', 'stand-rollup', 480, { keep: 1850 / 2000, quality: 82 })
await open('stand/table-tent.html', ':root { --view: 1 !important; }')
await shot('.view', 'stand-tent', 640, { quality: 82 })


// Мерч, откуда вещь: надпись на спине рабочей куртки — кадр ролика компании «Оператор линии розлива»
// без вшитой подписи ролика (тот же участок, что на обложке 12)
{
  const info = await sharp(`${brand}frames/bottling-back.webp`).extract({ left: 80, top: 178, width: 677, height: 542 }).webp({ quality: 82 }).toFile(`${out}merch-jacket.webp`)
  console.log(`docs/brand/img/merch-jacket.webp  ${info.width} × ${info.height}  ${Math.round(info.size / 1024)} КБ`)
}

// Мерч: рисунки изделий на светлом поле, 1000 px
await open('merch/layouts.html')
for (const [id, name] of [
  ['hoodie', 'merch-hoodie'],
  ['longsleeve', 'merch-longsleeve'],
  ['tote', 'merch-tote'],
  ['tee', 'merch-tee'],
  ['socks', 'merch-socks'],
  ['pins', 'merch-pins'],
])
  await shot(`#${id} .stage`, name, 1000)

await browser.close()
