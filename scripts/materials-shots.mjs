// Снимки экранов продукта для страницы /materials: четыре экрана телефона и два экрана HR-панели → docs/brand/img/site-*.webp.
//   site-home      — главная, первый экран с суммой
//   site-game      — задание «Поймай брак» в игре
//   site-apply     — анкета заявки /apply
//   site-status    — «Моя заявка» со статусом
//   site-hr-funnel — HR-панель, «Воронка»
//   site-hr-list   — HR-панель, список заявок
// Телефон — 390 × 844 при плотности 2, сжимается до 600 px по ширине; компьютер — 1440 × 900, до 1200 px. WebP, качество 78,
// каждый файл легче 150 КБ. Перезапускать после правок главной, анкеты и HR-панели.
//
// Запуск: node scripts/materials-shots.mjs <адрес сайта> [--seed]
//   node scripts/materials-shots.mjs http://localhost:8795 --seed
// Сценарий создаёт на сайте одну демо-заявку (для «Моей заявки») и входит в HR-панель: только демо-сервер с отдельной базой.
// --seed — перед снимками HR заполнить панель демо-данными (нужен HR_DEMO_TOOLS=1 на сервере).
// Вход в панель — HR_EMAIL и HR_PASSWORD, по умолчанию демо-вход из README: hr@ochakovo.local / ochakovo-demo.
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const args = process.argv.slice(2)
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/+$/, '')
if (!base) {
  console.error('Нужен адрес сайта: node scripts/materials-shots.mjs http://localhost:8795 [--seed]')
  process.exit(1)
}
const seed = args.includes('--seed')
const hr = { email: process.env.HR_EMAIL ?? 'hr@ochakovo.local', password: process.env.HR_PASSWORD ?? 'ochakovo-demo' }

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}docs/brand/img/`
// Версия согласия — та же, что проверяет сервер (shared/applications.ts)
const consentVersion = /export const CONSENT_VERSION = '([^']+)'/.exec(readFileSync(`${root}shared/applications.ts`, 'utf8'))?.[1]
const LIMIT = 150 * 1024

/** Экран → webp: ширина width, качество 78; тяжелее 150 КБ — качество ниже, пока не влезет */
async function save(png, name, width) {
  const file = `${out}${name}.webp`
  for (let quality = 78; ; quality -= 6) {
    const info = await sharp(png).resize({ width }).webp({ quality }).toFile(file)
    if (info.size < LIMIT || quality <= 50) {
      console.log(`docs/brand/img/${name}.webp  ${info.width} × ${info.height}  ${Math.round(statSync(file).size / 1024)} КБ, качество ${quality}`)
      if (info.size >= LIMIT) throw new Error(`${name}.webp тяжелее 150 КБ даже при качестве ${quality}`)
      return
    }
  }
}

/** Страница загрузилась, шрифты на месте, появление блоков доиграло */
async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}

const browser = await chromium.launch()
const errors = []
const watch = (page, where) => {
  page.on('pageerror', (e) => errors.push(`${where}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${where}: ${m.text()}`))
}

try {
  // ── Телефон ──────────────────────────────────────────────────────────
  const phone = await browser.newContext({
    baseURL: base,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  })
  const page = await phone.newPage()
  watch(page, 'телефон')

  await page.goto('/')
  await settle(page, 1800)
  await save(await page.screenshot(), 'site-home', 600)

  await page.goto('/game')
  await settle(page)
  const game = page.locator('[aria-label="Игра «Поймай брак»"]').first()
  await game.scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Играть' }).first().click()
  // Тренировка с двумя бутылками — мимо: на снимке нужна сама лента
  const skip = page.getByRole('button', { name: 'Пропустить тренировку' })
  if (await skip.isVisible({ timeout: 3000 }).catch(() => false)) await skip.click()
  await page.waitForTimeout(2600)
  await game.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await save(await page.screenshot(), 'site-game', 600)

  await page.goto('/apply')
  await settle(page)
  await save(await page.screenshot(), 'site-apply', 600)

  // «Моя заявка»: демо-заявка через API сайта, затем та же запись в localStorage, что оставляет форма после отправки
  const born = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10)
  const stamp = String(Date.now()).slice(-7)
  const app = await page.evaluate(
    async (data) => {
      const res = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      if (!res.ok) throw new Error(`заявка: ${res.status} ${await res.text()}`)
      return res.json()
    },
    {
      name: 'Алина',
      lastName: 'Кравцова',
      birthDate: born,
      phone: `+7 495 ${stamp.slice(0, 3)}-${stamp.slice(3, 5)}-${stamp.slice(5, 7)}`,
      school: 'МГУПП',
      startReady: 'now',
      vacancyId: 'bottling-operator',
      consent: true,
      consentVersion,
    },
  )
  await page.evaluate((a) => {
    const last = { id: a.id, name: a.name, phone: a.phone, contact: '', vacancyId: a.vacancyId, friend: '', token: a.statusToken }
    localStorage.setItem('ochakovo.application', JSON.stringify({ state: { last }, version: 0 }))
  }, app)
  await page.goto('/apply')
  await settle(page)
  await save(await page.screenshot(), 'site-status', 600)
  await phone.close()

  // ── HR-панель на компьютере ──────────────────────────────────────────
  const desk = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'ru-RU' })
  const hrPage = await desk.newPage()
  watch(hrPage, 'HR')
  await hrPage.goto('/hr/login')
  await hrPage.getByRole('textbox', { name: 'Рабочая почта' }).fill(hr.email)
  await hrPage.getByLabel('Пароль', { exact: true }).fill(hr.password)
  await hrPage.getByRole('button', { name: 'Войти' }).click()
  await hrPage.waitForURL(/\/hr(\?|$)/)
  if (seed) {
    const added = await hrPage.evaluate(async () => {
      const res = await fetch('/api/hr/applications/seed', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HR-Request': '1' }, body: JSON.stringify({ count: 60 }) })
      if (!res.ok) throw new Error(`демо-данные: ${res.status} ${await res.text()}`)
      return (await res.json()).added
    })
    console.log(`Демо-данные: ${added} заявок`)
  }
  await hrPage.goto('/hr?tab=funnel')
  await settle(hrPage, 1500)
  await save(await hrPage.screenshot(), 'site-hr-funnel', 1200)
  await hrPage.goto('/hr?tab=list')
  await settle(hrPage, 1500)
  await save(await hrPage.screenshot(), 'site-hr-list', 1200)
  await desk.close()
} finally {
  await browser.close()
}

if (errors.length) console.warn(`Ошибки на страницах:\n${errors.join('\n')}`)
