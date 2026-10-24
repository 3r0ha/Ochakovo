// Материалы кейса и «Как дела на смене» в браузере, на настоящем сервере прогона:
// 1. /materials на 1440 и 390 px: все картинки загрузились, макеты по ссылкам открываются с сервера (плагин materials
//    в vite.config.ts), телефон без прокрутки вбок, без ошибок консоли и ответов 4xx/5xx. Макеты со скриптами работают
//    под CSP сайта (script-src 'self'): раскадровка рисует 10 сцен, обложки — 12 карточек, #bleed включает вылеты.
// 2. Новичок «К оформлению» с первой сменой три дня назад: на «Моей заявке» вопрос «Как прошла первая смена?»,
//    «Тяжело» → «Дорога» → совет про корпоративный автобус; в базе — ответ и задача HR перезвонить.
// Свою заявку сценарий в конце удаляет. Только он: E2E_ONLY=c3-materials pnpm test:e2e

import { CONSENT_VERSION } from '../../shared/applications'
import { checkinHardNote } from '../../shared/adaptation'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h

  const materials = new h.Scenario('c3-materials: страница материалов кейса — 1440 и 390 px, макеты открываются с сервера')
  for (const [name, options] of [
    ['1440', h.DESKTOP],
    ['390', h.MOBILE],
  ] as const) {
    const { page, problems } = await h.open(materials, options)
    await materials.step(`${name}: одиннадцать разделов, все картинки загрузились, без ошибок`, async () => {
      await page.goto('/materials', { waitUntil: 'networkidle' })
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Квас делают')
      await expect(page.getByRole('link', { name: 'Проверить за 5 минут' })).toHaveAttribute('href', '#check')
      const nav = page.getByRole('navigation', { name: 'Разделы' })
      await expect(nav.getByRole('link')).toHaveCount(11)
      // Каждое требование кейса ведёт на свой раздел страницы
      const anchors = await page.locator('#req li a').evaluateAll((as) => as.map((a) => a.getAttribute('href')!))
      expect(anchors.length).toBeGreaterThan(9)
      for (const href of new Set(anchors)) await expect(page.locator(href), href).toHaveCount(1)
      await h.readThrough(page)
      await expect
        .poll(async () => page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src'))), {
          message: 'картинки не загрузились',
        })
        .toEqual([])
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка: ${o.out.join(', ')}`).toBe(0)
      h.none(
        (await h.contrastProblems(page)).map((c) => `${c.where}: «${c.text}» ${c.ratio}:1 < ${c.need}:1`),
        'контраст ниже AA',
      )
      // Текущий раздел отмечен в меню
      await page.evaluate(() => window.scrollTo(0, document.getElementById('merch')!.getBoundingClientRect().top + window.scrollY - 100))
      await expect(nav.locator('a[aria-current="location"]')).toHaveText('Мерч')
      h.none(problems, 'ошибки на странице')
    })
    if (name === '1440')
      await materials.step('макеты и файлы по ссылкам отдаются сервером: листовки, стенд, мерч, обложки, раскадровка', async () => {
        const hrefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/materials/"]')].map((a) => a.getAttribute('href')!))])
        expect(hrefs.length).toBeGreaterThan(12)
        const bad: string[] = []
        for (const href of hrefs) {
          const res = await page.request.get(href)
          if (res.status() !== 200) bad.push(`${res.status()} ${href}`)
          // В опубликованных макетах пути к public/ переписаны на корень сайта
          if (href.endsWith('.html') && (await res.text()).includes('../../../public/')) bad.push(`путь к public/ не переписан: ${href}`)
        }
        h.none(bad, 'макеты не открываются')
        // Макет открывается целиком: шрифты и картинки по путям сайта
        const layout = await h.open(materials, h.DESKTOP)
        await layout.page.goto('/materials/merch/layouts.html', { waitUntil: 'networkidle' })
        await expect(layout.page.getByRole('heading', { level: 1 })).toContainText('Коллекция')
        h.none(layout.problems, 'ошибки в макете мерча')
      })
    if (name === '1440')
      await materials.step('макеты со скриптами под CSP сайта: раскадровка — 10 сцен, обложки — 12 карточек, #bleed — вылеты', async () => {
        const layout = await h.open(materials, h.DESKTOP)
        const p = layout.page
        await p.goto('/materials/video/storyboard.html', { waitUntil: 'networkidle' })
        await expect(p.locator('#board .scene')).toHaveCount(10)
        await expect(p.locator('#board .scene .frame').first()).toBeVisible()
        await p.goto('/materials/clips/covers.html', { waitUntil: 'networkidle' })
        await expect(p.locator('#covers .cover')).toHaveCount(12)
        // Флажок «зоны интерфейса» работает без встроенного обработчика
        await p.getByLabel('Показать зоны интерфейса VK Клипов').check()
        await expect(p.locator('body')).toHaveClass(/show-zones/)
        for (const href of ['/materials/print/leaflet-a5.html#bleed', '/materials/stand/rollup.html#bleed']) {
          await p.goto(href, { waitUntil: 'networkidle' })
          await expect(p.locator('html'), href).toHaveClass(/\bbleed\b/)
        }
        h.none(layout.problems, 'ошибки в макетах')
      })
  }

  const s = new h.Scenario('c3-adaptation: «Как дела на смене» на «Моей заявке» — «Тяжело», совет и задача HR')
  const { page, problems } = await h.open(s, h.MOBILE)
  const bornAgo = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)
  const stamp = String(Date.now())
  let app = { id: '', statusToken: '', name: '', phone: '', vacancyId: '' }
  try {
    await s.step('новичок с первой сменой три дня назад видит вопрос «Как прошла первая смена?»', async () => {
      const res = await page.request.post('/api/applications', {
        data: {
          name: `Новичок${stamp.slice(-4)}`,
          lastName: 'Проверкина',
          birthDate: bornAgo(20),
          phone: `+7 495 ${stamp.slice(-7, -4)}-${stamp.slice(-4, -2)}-${stamp.slice(-2)}`,
          school: 'МГУПП',
          startReady: 'now',
          vacancyId: 'bottling-operator',
          consent: true,
          consentVersion: CONSENT_VERSION,
        },
      })
      expect(res.status(), 'заявка не создалась').toBe(201)
      app = await res.json()
      // Оформление прошло: «К оформлению» и первая смена в 8:00 по Москве три дня назад
      await sql`update applications set status = 'hired', first_shift_at = date_trunc('day', now() at time zone 'Europe/Moscow' - interval '3 days') at time zone 'Europe/Moscow' + interval '8 hours' where id = ${app.id}`
      await page.addInitScript({
        content: `localStorage.setItem('ochakovo.application', ${JSON.stringify(
          JSON.stringify({ state: { last: { id: app.id, name: app.name, phone: app.phone, contact: '', vacancyId: app.vacancyId, friend: '', token: app.statusToken } }, version: 0 }),
        )})`,
      })
      await page.goto('/apply', { waitUntil: 'networkidle' })
      const card = page.locator('[data-checkin]')
      await expect(card).toContainText('Как дела на смене')
      await expect(card).toContainText('Как прошла первая смена?')
    })
    await s.step('«Тяжело» → «Дорога»: совет про корпоративный автобус, в базе ответ и задача перезвонить', async () => {
      const card = page.locator('[data-checkin]')
      await card.getByRole('button', { name: 'Тяжело' }).tap()
      await expect(card).toContainText('Что тяжелее всего?')
      await card.getByRole('button', { name: 'Дорога' }).tap()
      const reply = card.getByRole('status')
      await expect(reply).toContainText('корпоративный автобус')
      await expect(reply).toContainText('тебе позвонят в рабочее время')
      await expect(card.getByRole('button', { name: 'Пусть HR позвонит' }), 'звонок уже обещан — кнопку не повторяем').toHaveCount(0)
      const [row] = await sql<{ answer: string; reason: string; answered_via: string }[]>`
        select answer, reason, answered_via from application_checkins where application_id = ${app.id} and step = 'shift1'`
      expect(row).toEqual({ answer: 'hard', reason: 'commute', answered_via: 'site' })
      const [task] = await sql<{ callback_note: string }[]>`select callback_note from applications where id = ${app.id}`
      expect(task.callback_note).toBe(checkinHardNote('shift1', 'commute'))
      const o = await h.overflow(page)
      expect(o.scrolled, 'страница прокручивается вбок').toBe(0)
      h.none(problems, 'ошибки на странице')
    })
  } finally {
    if (app.id) await sql`delete from applications where id = ${app.id}`
  }

  return [materials, s]
}
