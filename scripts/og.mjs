// Картинки превью ссылок 1200×630 (public/og) и иконка для экрана «Домой» 180×180 (public/apple-touch-icon.png).
// Запуск вручную после правки сумм, вакансий или длины игры: node scripts/og.mjs
//
// Playwright рисует шаблоны шрифтами сайта (src/fonts.css), фото — из public/photos, знак — из public/brand.
// Суммы, число вакансий и секунды берутся из shared и src в момент запуска и записываются в public/og/og.json:
// scripts/tests/ops-og.test.ts сверяет их с текущими данными и напомнит перерисовать картинки.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { register } from 'tsx/esm/api'

register()
const root = fileURLToPath(new URL('..', import.meta.url))
const at = (p) => resolve(root, p)
const { vacancies, minMonthlyPay, maxEntryPay, netPay, scheduleSummary } = await import(at('shared/content/vacancies.ts'))
const { contacts } = await import(at('shared/content/content.ts'))

const W = 1200
const H = 630
/** Потолок размера одной картинки: мессенджеры не любят тяжёлые превью */
const MAX_BYTES = 300 * 1024

// ── Данные ────────────────────────────────────────────────────────────────
const rub = (n) => n.toLocaleString('ru-RU')
const plural = (n, [one, few, many]) => {
  const d = n % 10
  const h = n % 100
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many
}
const gameSource = readFileSync(at('src/game/useConveyorGame.ts'), 'utf8')
const gameSeconds = Number(gameSource.match(/export const GAME_SECONDS = (\d+)/)?.[1])
if (!gameSeconds) throw new Error('В src/game/useConveyorGame.ts не нашлось GAME_SECONDS')

// ── Ресурсы: шрифты сайта, фото и знак — внутрь страницы, чтобы ничего не зависело от сети и file:// ──
const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`
const fontsCss = readFileSync(at('src/fonts.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, url) => `url(${dataUri(resolve(at('src'), url.replace(/['"]/g, '')), 'font/woff2')})`)
// Официальный логотип без квадрата (брендбук, node scripts/media.mjs brand): в строку — для карточек, блоком — для иконки
const logoLine = dataUri(at('public/brand/logo-line-white.svg'), 'image/svg+xml')
const logoBlock = dataUri(at('public/brand/logo-white.svg'), 'image/svg+xml')
const photo = (name) => dataUri(at(`public/photos/${name}.webp`), 'image/webp')

// Бутылка — та же форма и те же цвета кваса, что в игре (src/game/Bottle.tsx)
const bottleSource = readFileSync(at('src/game/Bottle.tsx'), 'utf8')
const BODY = bottleSource.match(/const BODY = '([^']+)'/)?.[1] ?? 'M15.5 10h9v6.5c0 3.6 10.5 7.4 10.5 15V89a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V31.5c0-7.6 10.5-11.4 10.5-15z'
const KVASS_TOP = bottleSource.match(/KVASS_TOP = '(#[0-9a-f]{6})'/i)?.[1] ?? '#b06a26'
const KVASS_BOTTOM = bottleSource.match(/KVASS_BOTTOM = '(#[0-9a-f]{6})'/i)?.[1] ?? '#5a2f0e'

const RED = '#d50032'
const NIGHT = '#0c0c0c'

/** Бутылка для тёмной сцены: квас на просвет, белый контур, красная крышка, белая этикетка «КВАС» */
function bottle(kind, i) {
  const id = `b${i}`
  const top = kind === 'lowfill' ? 70 : 27
  const label = `
    <rect x="5" y="49" width="30" height="21" fill="#fff" />
    <text x="20" y="64.6" text-anchor="middle" class="label">КВАС</text>`
  const crooked = `
    <g transform="rotate(32 8 50)">
      <path d="M5 49h30v8.5l-2.4 2 2.4 2.2-2.6 2 2.6 2.3V70H5z" fill="#fff" />
      <text x="19" y="64.6" text-anchor="middle" class="label">КВАС</text>
    </g>`
  const cap =
    kind === 'nocap'
      ? `<ellipse cx="20" cy="10" rx="4.5" ry="1.4" fill="${KVASS_TOP}" stroke="rgba(255,255,255,.92)" stroke-width="1" />
         <circle cx="17" cy="6" r="2.2" fill="#fff" /><circle cx="22.5" cy="4.2" r="2.8" fill="#fff" /><circle cx="19.5" cy="0.4" r="1.7" fill="#fff" />`
      : `<rect x="14" y="2" width="12" height="8.5" rx="1.2" fill="${RED}" stroke="rgba(255,255,255,.92)" stroke-width="1" />
         <rect x="15.5" y="3.4" width="9" height="1.2" rx="0.6" fill="#fff" opacity="0.6" />`
  return `
  <svg viewBox="0 -4 40 104" class="bottle" overflow="visible" aria-hidden="true">
    <defs>
      <clipPath id="${id}c"><path d="${BODY}" /></clipPath>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${KVASS_TOP}" /><stop offset="1" stop-color="${KVASS_BOTTOM}" /></linearGradient>
    </defs>
    <path d="${BODY}" fill="rgba(255,255,255,.08)" />
    <g clip-path="url(#${id}c)">
      <rect x="0" y="${top}" width="40" height="${96 - top}" fill="url(#${id}g)" />
      <rect x="0" y="${top}" width="40" height="2" fill="#e7b77a" opacity="0.85" />
      ${kind === 'lowfill' ? '<line x1="5" x2="35" y1="27" y2="27" stroke="rgba(255,255,255,.85)" stroke-width="1.2" stroke-dasharray="2.4 2" />' : ''}
    </g>
    ${kind === 'label' ? crooked : label}
    <path d="${BODY}" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="1.4" stroke-linejoin="round" />
    ${cap}
  </svg>`
}

// ── Шаблоны ───────────────────────────────────────────────────────────────
const base = (body, { width = W, height = H, background = NIGHT } = {}) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<style>
${fontsCss}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; color: #fff;
  font-family: 'Onest Variable', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.display { font-family: 'Sofia Sans Extra Condensed Variable', 'Onest Variable', sans-serif; font-weight: 860; text-transform: uppercase;
  line-height: 0.86; letter-spacing: -0.005em; white-space: nowrap; }
.kicker { font-family: 'Sofia Sans Extra Condensed Variable', sans-serif; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em;
  font-size: 26px; line-height: 1; color: rgba(255,255,255,.8); white-space: nowrap; }
.rub { font-family: 'Onest Variable', sans-serif; font-weight: 800; font-size: 0.72em; letter-spacing: 0; margin-left: 0.06em; }
[data-fit] { display: inline-block; }
.top { position: absolute; left: 56px; right: 56px; top: 46px; display: flex; justify-content: space-between; align-items: center; }
.top img { height: 40px; display: block; }
.bottle { width: 78px; height: 203px; display: block; flex: none; }
.label { font-family: 'Sofia Sans Extra Condensed Variable', sans-serif; font-weight: 900; font-size: 13px; fill: ${RED}; letter-spacing: 0.02em; }
</style></head>
<body>${body}
<script>
  // Строка во всю заданную ширину, как FitLine на сайте
  window.fit = () => document.querySelectorAll('[data-fit]').forEach((el) => {
    const target = Number(el.dataset.fit)
    el.style.fontSize = '100px'
    el.style.fontSize = (100 * target) / el.scrollWidth + 'px'
  })
</script>
</body></html>`

const home = base(`
  <div style="position:absolute;inset:0;background:url(${photo('excursion-1600')}) 62% 30% / cover;filter:brightness(.78)"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,12,12,.6) 0%,rgba(12,12,12,0) 22%,rgba(12,12,12,0) 34%,rgba(12,12,12,.88) 64%,${NIGHT} 92%)"></div>
  <div class="top"><img src="${logoLine}" alt="" /><span class="kicker">Март — сентябрь · с 18 лет</span></div>
  <div style="position:absolute;left:56px;right:56px;bottom:46px">
    <div class="display" data-fit="1088" style="font-weight:900;line-height:0.8">Работа на лето</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:22px">
      <div class="display" style="color:${RED};font-size:96px;font-weight:900;line-height:0.8">в «Очаково»</div>
      <div style="text-align:right">
        <div class="display" style="font-size:96px;font-weight:900;line-height:0.8">${rub(minMonthlyPay)}–${rub(maxEntryPay)}<span class="rub">₽</span></div>
        <div style="margin-top:12px;font-size:23px;line-height:1.2;color:rgba(255,255,255,.82)">в месяц · на руки от ${rub(netPay(minMonthlyPay))}&nbsp;₽</div>
      </div>
    </div>
  </div>`)

const kinds = ['ok', 'ok', 'nocap', 'ok', 'ok', 'lowfill', 'ok', 'ok', 'label', 'ok', 'ok', 'ok']
const game = base(`
  <div class="top"><img src="${logoLine}" alt="" /><span class="kicker">Игра на ${gameSeconds} секунд</span></div>
  <div style="position:absolute;left:56px;top:122px">
    <div class="display" data-fit="700" style="font-weight:900;line-height:0.8">Поймай <span style="color:${RED}">брак</span></div>
  </div>
  <div style="position:absolute;right:56px;top:126px;text-align:right;font-size:25px;line-height:1.35;color:rgba(255,255,255,.82)">
    Сними с ленты<br />бутылки без крышки,<br />с недоливом<br />и кривой этикеткой
  </div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:260px">
    <div style="position:absolute;left:-40px;right:-40px;bottom:0;height:48px;background:repeating-linear-gradient(-60deg,#1d1d1d 0 14px,#161616 14px 28px);border-top:2px solid rgba(255,255,255,.18)"></div>
    <div style="position:absolute;left:-34px;bottom:44px;display:flex;gap:24px;align-items:flex-end">
      ${kinds.map((k, i) => bottle(k, i)).join('')}
    </div>
  </div>`)

const vacancyWord = plural(vacancies.length, ['вакансия', 'вакансии', 'вакансий'])
const vacanciesCard = base(`
  <div class="top"><img src="${logoLine}" alt="" /><span class="kicker">Март — сентябрь</span></div>
  <div style="position:absolute;left:56px;top:124px">
    <div class="display" data-fit="1088" style="font-weight:900;line-height:0.8">${vacancies.length} ${vacancyWord}</div>
  </div>
  <div style="position:absolute;left:0;right:0;top:350px;height:58px;background:${RED};display:flex;align-items:center;padding:0 56px;gap:26px">
    <span class="display" style="font-size:33px;font-weight:800;letter-spacing:0.04em">Оплачиваемая практика</span>
    <span class="display" style="font-size:33px;font-weight:800;opacity:.6">·</span>
    <span class="display" style="font-size:33px;font-weight:800;letter-spacing:0.04em">Бесплатная практика</span>
    <span class="display" style="font-size:33px;font-weight:800;opacity:.6">·</span>
    <span class="display" style="font-size:33px;font-weight:800;letter-spacing:0.04em">Работа</span>
  </div>
  <div style="position:absolute;left:56px;right:56px;bottom:46px;display:flex;justify-content:space-between;align-items:flex-end">
    <div>
      <div class="display" style="font-size:96px;font-weight:900;line-height:0.8">${rub(minMonthlyPay)}–${rub(maxEntryPay)}<span class="rub">₽</span></div>
      <div style="margin-top:12px;font-size:23px;line-height:1.2;color:rgba(255,255,255,.82)">в месяц на оплачиваемой практике, до вычета налога</div>
    </div>
    <div style="text-align:right">
      <div class="display" style="font-size:44px;font-weight:900;line-height:0.86">${scheduleSummary.title}</div>
      <div style="margin-top:12px;font-size:23px;line-height:1.2;color:rgba(255,255,255,.82)">${contacts.address}</div>
    </div>
  </div>`)

const ICON = 180
const icon = base(
  `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><img src="${logoBlock}" alt="" style="width:140px;display:block" /></div>`,
  { width: ICON, height: ICON, background: RED },
)

// ── Отрисовка ─────────────────────────────────────────────────────────────
/** PNG без потерь, если влезает в потолок; иначе — палитра на 256 цветов с дизерингом */
async function optimize(png) {
  const lossless = await sharp(png).png({ compressionLevel: 9, effort: 10 }).toBuffer()
  if (lossless.length <= MAX_BYTES) return lossless
  return sharp(png).png({ palette: true, colours: 256, dither: 1, compressionLevel: 9, effort: 10 }).toBuffer()
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const render = async (html, out, size = { width: W, height: H }) => {
    await page.setViewportSize(size)
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(async () => {
      await document.fonts.ready
      window.fit()
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})))
    })
    const png = await optimize(await page.screenshot({ type: 'png' }))
    if (png.length > MAX_BYTES) throw new Error(`${out}: ${Math.round(png.length / 1024)} КБ — больше ${MAX_BYTES / 1024} КБ`)
    mkdirSync(dirname(at(out)), { recursive: true })
    writeFileSync(at(out), png)
    console.log(`${out}: ${size.width}×${size.height}, ${Math.round(png.length / 1024)} КБ`)
  }
  await render(home, 'public/og/home.png')
  await render(game, 'public/og/game.png')
  await render(vacanciesCard, 'public/og/vacancies.png')
  await render(icon, 'public/apple-touch-icon.png', { width: ICON, height: ICON })
} finally {
  await browser.close()
}

// Из каких чисел нарисованы картинки — сверяет scripts/tests/ops-og.test.ts
writeFileSync(
  at('public/og/og.json'),
  `${JSON.stringify({ minMonthlyPay, maxEntryPay, netMinMonthlyPay: netPay(minMonthlyPay), vacancies: vacancies.length, gameSeconds, schedule: scheduleSummary.title, address: contacts.address }, null, 2)}\n`,
)
console.log('public/og/og.json: суммы, число вакансий, график, адрес и секунды игры')
