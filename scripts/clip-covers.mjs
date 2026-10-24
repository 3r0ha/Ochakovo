// Обложки коротких роликов в натуральную величину: docs/brand/clips/covers.html → docs/brand/clips/covers/<имя>.webp, 1080 × 1920.
// Страница открывается с #export: карточки без уменьшения, подписи и пояснения скрыты. Имя файла — data-name карточки.
// Запуск: node scripts/clip-covers.mjs  (нужны playwright с Chromium и sharp из node_modules проекта)
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const root = fileURLToPath(new URL('..', import.meta.url))
const page = `${root}docs/brand/clips/covers.html`
const out = `${root}docs/brand/clips/covers`
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: 1200, height: 2000 } })
await tab.goto(`${pathToFileURL(page).href}#export`)
await tab.evaluate(() => document.fonts.ready)
await tab.waitForTimeout(500)
const cards = tab.locator('.cover')
for (let i = 0; i < (await cards.count()); i++) {
  const card = cards.nth(i)
  const name = await card.getAttribute('data-name')
  const box = await card.boundingBox()
  if (!name || Math.round(box.width) !== 1080 || Math.round(box.height) !== 1920) throw new Error(`карточка ${name}: ${box?.width} × ${box?.height}`)
  const png = await card.screenshot()
  const info = await sharp(png).webp({ quality: 82 }).toFile(`${out}/${name}.webp`)
  console.log(`docs/brand/clips/covers/${name}.webp  ${Math.round(info.size / 1024)} КБ`)
}
await browser.close()
