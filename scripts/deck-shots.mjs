// Экраны продукта для презентации: docs/brand/deck/index.html → docs/brand/deck/shots/<имя>.webp.
// Телефон — 390 × 844 при плотности 2, сохраняется шириной 780 px; компьютер — 1440 × 900 без сжатия по ширине.
// На слайде каждый экран идёт крупно, поэтому снимки в полном разрешении. Перезапускать после правок сайта
// и HR-панели, затем node scripts/deck-pdf.mjs.
//
// Запуск: DATABASE_URL=postgres://localhost:5432/ochakovo_demo node scripts/deck-shots.mjs http://localhost:8790
// Только демо-сервер с отдельной базой: сценарий создаёт две демо-заявки, одной ставит «вышел на смену» прямо в базе
// (иначе не показать «Как дела на смене»), и входит в HR-панель. Вход — HR_EMAIL и HR_PASSWORD,
// по умолчанию демо-вход из README: hr@ochakovo.local / ochakovo-demo.
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import postgres from 'postgres'
import sharp from 'sharp'

const base = (process.argv.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/+$/, '')
const dbUrl = process.env.DATABASE_URL
if (!base || !dbUrl) {
  console.error('Нужны адрес демо-сервера и DATABASE_URL его базы: DATABASE_URL=… node scripts/deck-shots.mjs http://localhost:8790')
  process.exit(1)
}
const hr = { email: process.env.HR_EMAIL ?? 'hr@ochakovo.local', password: process.env.HR_PASSWORD ?? 'ochakovo-demo' }
const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}docs/brand/deck/shots/`
mkdirSync(out, { recursive: true })
const consentVersion = /export const CONSENT_VERSION = '([^']+)'/.exec(readFileSync(`${root}shared/applications.ts`, 'utf8'))?.[1]

/** Экран → webp нужной ширины, качество 82; тяжелее предела — качество ниже */
async function save(png, name, width, limitKb) {
  const file = `${out}${name}.webp`
  for (let quality = 82; ; quality -= 6) {
    const info = await sharp(png).resize({ width }).webp({ quality }).toFile(file)
    if (info.size < limitKb * 1024 || quality <= 50) {
      console.log(`docs/brand/deck/shots/${name}.webp  ${info.width} × ${info.height}  ${Math.round(statSync(file).size / 1024)} КБ`)
      return
    }
  }
}
const phoneShot = async (page, name) => save(await page.screenshot(), name, 780, 230)
const deskShot = async (page, name) => save(await page.screenshot(), name, 1440, 280)

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}

/**
 * Раздел главной в окне телефона: прокрутить к нему так, чтобы заголовок был под шапкой.
 * Шапка сайта прячется при прокрутке вниз и возвращается при прокрутке вверх, поэтому подходим к разделу снизу
 */
async function section(page, id) {
  await page.evaluate((id) => {
    const el = document.getElementById(id)
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + 160)
  }, id)
  await page.waitForTimeout(500)
  await page.evaluate((id) => {
    const el = document.getElementById(id)
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64)
  }, id)
  await page.waitForTimeout(1200)
}

/** Заявка через API сайта и запись в localStorage, как после отправки формы */
async function apply(page, who) {
  const born = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10)
  const stamp = String(Date.now()).slice(-7)
  const app = await page.evaluate(
    async (data) => {
      const res = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      if (!res.ok) throw new Error(`заявка: ${res.status} ${await res.text()}`)
      return res.json()
    },
    { ...who, birthDate: born, phone: `+7 495 ${stamp.slice(0, 3)}-${stamp.slice(3, 5)}-${stamp.slice(5, 7)}`, startReady: 'now', consent: true, consentVersion },
  )
  await page.evaluate((a) => {
    const last = { id: a.id, name: a.name, phone: a.phone, contact: '', vacancyId: a.vacancyId, friend: '', token: a.statusToken }
    localStorage.setItem('ochakovo.application', JSON.stringify({ state: { last }, version: 0 }))
  }, app)
  return app
}

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
// --lang=ru-RU: поля дат в HR-панели показывают дд.мм.гггг, как у кандидата в России
const browser = await chromium.launch({ args: ['--lang=ru-RU'] })
const errors = []
const watch = (page, where) => page.on('pageerror', (e) => errors.push(`${where}: ${e.message}`))

try {
  const phone = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce', locale: 'ru-RU' })
  const page = await phone.newPage()
  watch(page, 'телефон')

  // Главная: первый экран и разделы по порядку
  await page.goto('/')
  await settle(page, 1800)
  await phoneShot(page, 'home')
  for (const id of ['money', 'quiz', 'myth', 'path', 'history', 'mentors']) {
    await section(page, id)
    // «Собери лето»: в кадре месяцы и сумма на руки, а не список всех должностей
    if (id === 'money') {
      await page.evaluate(() => {
        const el = document.querySelector('[role="group"][aria-label="Месяцы"]')
        if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 100)
      })
      await page.waitForTimeout(400)
      await page.evaluate(() => window.scrollBy(0, -160))
    }
    if (id === 'money') await page.waitForTimeout(800)
    await phoneShot(page, id)
  }

  // «Поймай брак» в разгаре
  await page.goto('/game')
  await settle(page)
  await page.getByRole('button', { name: 'Играть' }).first().click()
  const skip = page.getByRole('button', { name: 'Пропустить тренировку' })
  if (await skip.isVisible({ timeout: 3000 }).catch(() => false)) await skip.click()
  await page.waitForTimeout(2800)
  await phoneShot(page, 'game')

  // Викторина об «Очаково»
  await page.goto('/game?t=quiz')
  await settle(page)
  await phoneShot(page, 'company-quiz')

  await page.goto('/vacancies')
  await settle(page)
  await phoneShot(page, 'vacancies')

  await page.goto('/focus?s=fg-a')
  await settle(page)
  await phoneShot(page, 'focus')

  await page.goto('/apply')
  await settle(page)
  await phoneShot(page, 'apply')

  await apply(page, { name: 'Алина', lastName: 'Кравцова', school: 'МГУПП', vacancyId: 'bottling-operator' })
  await page.goto('/apply')
  await settle(page)
  await phoneShot(page, 'status')

  // «Как дела на смене»: новичок вышел на первую смену три дня назад
  const hired = await apply(page, { name: 'Денис', lastName: 'Орлов', school: 'Колледж № 32', vacancyId: 'warehouse-operator' })
  await sql`update applications set status = 'hired', first_shift_at = date_trunc('day', now() at time zone 'Europe/Moscow' - interval '3 days') at time zone 'Europe/Moscow' + interval '8 hours' where id = ${hired.id}`
  await page.goto('/apply')
  await settle(page)
  await page.locator('[data-checkin]').evaluate((el) => {
    el.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -70)
  })
  await page.waitForTimeout(400)
  await phoneShot(page, 'checkin')

  // Чат с Квасычем: вопрос про деньги в лаборатории
  await page.goto('/vacancies')
  await settle(page)
  await page.getByRole('button', { name: 'Открыть чат' }).click()
  const box = page.getByRole('dialog').getByRole('textbox').last()
  await box.fill('Сколько платят в лаборатории?')
  await box.press('Enter')
  await page.waitForTimeout(3000)
  await phoneShot(page, 'chat')
  await phone.close()

  // HR-панель на компьютере
  const desk = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'ru-RU' })
  const hrPage = await desk.newPage()
  watch(hrPage, 'HR')
  await hrPage.goto('/hr/login')
  await hrPage.getByRole('textbox', { name: 'Рабочая почта' }).fill(hr.email)
  await hrPage.getByLabel('Пароль', { exact: true }).fill(hr.password)
  await hrPage.getByRole('button', { name: 'Войти' }).click()
  await hrPage.waitForURL(/\/hr(\?|$)/)
  await settle(hrPage, 1500)
  await deskShot(hrPage, 'hr-list')
  for (const tab of ['funnel', 'schedule', 'sources', 'gaps', 'bots', 'focus']) {
    await hrPage.goto(`/hr?tab=${tab}`)
    await settle(hrPage, 1500)
    // «Боты»: предпросмотр ленты, как её видит кандидат после QR с ярмарки
    if (tab === 'bots') {
      await hrPage.getByRole('button', { name: 'Запустить' }).click()
      await hrPage.waitForTimeout(1500)
    }
    await deskShot(hrPage, `hr-${tab}`)
  }
  const [hard] = await sql`select a.id from applications a join application_checkins c on c.application_id = a.id where c.answer = 'hard' and coalesce(a.season_outcome, '') = '' order by c.answered_at desc nulls last limit 1`
  if (hard) {
    await hrPage.goto(`/hr?card=${hard.id}`)
    await settle(hrPage, 1500)
    await deskShot(hrPage, 'hr-card')
  }
  await desk.close()
} finally {
  await browser.close()
  await sql.end()
}

if (errors.length) console.warn(`Ошибки на страницах:\n${errors.join('\n')}`)
