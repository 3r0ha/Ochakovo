// Самозапись на собеседование (w2-booking) в браузере, на настоящем сервере прогона:
// HR в карточке нажимает «Предложить выбрать время» → кандидат на «Моей заявке» (390 px) видит до 6 часов и записывается →
// у заявки «Собеседование» со слотом и пометкой «самозапись», в «Графике» в этом часе +1 → на 1440 px перенос и отмена,
// место освобождается. BOOKING_SHOTS=<папка> — сохранить снимки экранов для проверки глазами.
// Только этот сценарий: E2E_ONLY=booking pnpm test:e2e

import { join } from 'node:path'
import type { Page } from 'playwright'
import { CONSENT_VERSION } from '../../shared/applications'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const s = new h.Scenario('booking: HR предлагает выбрать время — кандидат записывается на сайте, «График» +1, перенос и отмена')
  const tag = Math.random().toString(36).slice(2, 6)
  const name = `Самозапись${tag}`
  const shotsDir = process.env.BOOKING_SHOTS
  const shot = async (page: Page, file: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, file), fullPage: true })
  }
  const bornAgo = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)

  let app = { id: '', statusToken: '', name: '', phone: '', vacancyId: '' }
  /** Та же заявка в браузере кандидата — так её видит «Моя заявка» после отправки формы */
  const remember = () =>
    `localStorage.setItem('ochakovo.application', ${JSON.stringify(
      JSON.stringify({ state: { last: { id: app.id, name: app.name, phone: app.phone, contact: '', vacancyId: app.vacancyId, friend: '', token: app.statusToken } }, version: 0 }),
    )})`
  const interview = async () =>
    (
      await sql<{ status: string; starts_at: Date | null; self_booked: boolean | null }[]>`
        select a.status, i.starts_at, i.self_booked from applications a
        left join interviews i on i.application_id = a.id and i.cancelled_at is null
        where a.id = ${app.id}`
    )[0]

  const hr = await h.open(s, h.DESKTOP)
  const candidate = await h.open(s, h.MOBILE)
  let picked = ''
  /** Сколько замечаний у HR-страницы было до входа: страница входа сама проверяет сессию и получает 401 */
  let beforeLogin = 0

  await s.step('HR: «Предложить выбрать время» в карточке — предложение есть, статус прежний', async () => {
    const res = await candidate.page.request.post('/api/applications', {
      data: { name, lastName: 'Проверкина', birthDate: bornAgo(20), phone: `+7 495 ${String(Date.now()).slice(-7, -4)}-${String(Date.now()).slice(-4, -2)}-${String(Date.now()).slice(-2)}`, school: 'МГУПП', startReady: 'now', vacancyId: 'bottling-operator', consent: true, consentVersion: CONSENT_VERSION },
    })
    expect(res.status(), 'заявка не создалась').toBe(201)
    app = await res.json()
    await h.loginHr(hr.page)
    beforeLogin = hr.problems.length
    await hr.page.getByRole('searchbox', { name: 'Поиск' }).fill(name)
    await hr.page.waitForURL((u) => u.searchParams.get('q') === name)
    await hr.page.getByRole('button', { name: new RegExp(name) }).filter({ visible: true }).first().click()
    const card = hr.page.getByRole('dialog', { name: /^Заявка/ })
    await card.getByRole('button', { name: 'Предложить выбрать время' }).click()
    await expect(hr.page.locator('[data-hr-toasts]')).toContainText('Предложили выбрать время')
    await expect.poll(async () => (await sql`select 1 from booking_offers where application_id = ${app.id} and closed_at is null`).length).toBe(1)
    expect((await interview()).status).toBe('new')
    await expect(card).toContainText('Предложено выбрать время собеседования')
    await shot(hr.page, 'hr-card-offer-1440.png')
    await hr.page.keyboard.press('Escape')
  })

  await s.step('кандидат на 390: до 6 часов кнопками, запись ставит «Собеседование» со слотом и пометкой «самозапись»', async () => {
    const { page } = candidate
    await page.addInitScript({ content: remember() })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByText('Выбери время собеседования')).toBeVisible()
    const choices = page.locator('ul li button').filter({ hasText: /\d{2}:\d{2}/ })
    await expect(choices).toHaveCount(6)
    await shot(page, 'candidate-hours-390.png')
    const r = await h.overflow(page)
    expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    const api = await page.request.get(`/api/applications/${app.id}/booking`, { headers: { 'x-status-token': app.statusToken } })
    picked = ((await api.json()) as { hours: string[] }).hours[0]
    await choices.first().click()
    await expect(page.getByText('Время выбрано на этой странице — его можно перенести или отменить.')).toBeVisible()
    await expect(page.getByText('Собеседование назначено')).toBeVisible()
    const row = await interview()
    expect(row.status).toBe('interview')
    expect(row.starts_at?.toISOString()).toBe(picked)
    expect(row.self_booked).toBe(true)
    await shot(page, 'candidate-booked-390.png')
  })

  await s.step('HR: «График» — в этом часе 1 из нормы и пометка «самозапись»', async () => {
    const { page } = hr
    // Список заявок панели загружен до записи — открываем панель заново
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'График' }).first().click()
    const entry = page.getByRole('button', { name: new RegExp(name) })
    // Неделя записи может быть следующей
    for (let i = 0; i < 3 && !(await entry.isVisible()); i++) await page.getByRole('button', { name: 'Следующая неделя' }).click()
    await expect(entry).toBeVisible()
    await expect(entry).toContainText('самозапись')
    const hour = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(picked))
    const slot = page.locator('li').filter({ has: page.locator('p span.font-semibold', { hasText: hour }) }).filter({ has: entry })
    await expect(slot.locator('p').first()).toContainText('1 из ')
    await shot(page, 'hr-schedule-1440.png')
  })

  await s.step('кандидат на 1440: перенос — прежний час свободен; отмена — заявка снова «Новая», часы снова видны', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.addInitScript({ content: remember() })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Перенести' }).click()
    await expect(page.getByText('Другое время собеседования')).toBeVisible()
    const choices = page.locator('ul li button').filter({ hasText: /\d{2}:\d{2}/ })
    await expect(choices).toHaveCount(6)
    await shot(page, 'candidate-move-1440.png')
    await choices.nth(1).click()
    await expect(page.getByText('Время выбрано на этой странице — его можно перенести или отменить.')).toBeVisible()
    const moved = await interview()
    expect(moved.starts_at?.toISOString()).not.toBe(picked)
    const left = await sql`
      select 1 from interviews i join applications a on a.id = i.application_id
      where i.cancelled_at is null and a.status = 'interview' and i.starts_at = ${new Date(picked)} and a.id = ${app.id}`
    expect(left.length, 'прежний час освободился').toBe(0)
    await page.getByRole('button', { name: 'Отменить запись' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Запись отменена, место освободилось.' })).toBeVisible()
    await expect(page.getByText('Выбери время собеседования')).toBeVisible()
    const after = await interview()
    expect(after.status).toBe('new')
    expect(after.starts_at).toBeNull()
    await shot(page, 'candidate-cancelled-1440.png')
    await context.close()
  })

  await s.step('день найма: HR заводит день, заявка по ссылке /?src=<метка> сразу видит часы этого дня и записывается', async () => {
    const label = `hiringday-e2e${tag}`
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + 864e5))
    const created = await hr.page.request.post('/api/hr/booking/days', { headers: { 'x-hr-request': '1' }, data: { day, hours: [10, 11], capacity: 2, label } })
    expect(created.status(), await created.text()).toBe(201)
    const { context, page } = await h.open(s, h.MOBILE)
    const res = await page.request.post('/api/applications', {
      data: { name: `${name}Д`, lastName: 'Проверкина', birthDate: bornAgo(19), phone: `+7 495 ${String(Date.now()).slice(-7, -4)}-${String(Date.now()).slice(-4, -2)}-${String(Date.now()).slice(-2)}`, school: 'МГУПП', startReady: 'now', source: label, consent: true, consentVersion: CONSENT_VERSION },
    })
    expect(res.status()).toBe(201)
    app = await res.json()
    await page.addInitScript({ content: remember() })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    const choices = page.locator('ul li button').filter({ hasText: /\d{2}:\d{2}/ })
    await expect(choices).toHaveCount(2)
    await expect(choices.first()).toContainText('10:00')
    await shot(page, 'candidate-hiringday-390.png')
    await choices.first().click()
    await expect(page.getByText('Время выбрано на этой странице — его можно перенести или отменить.')).toBeVisible()
    const row = await interview()
    expect(row.status).toBe('interview')
    expect(row.self_booked).toBe(true)
    const list = (await (await hr.page.request.get('/api/hr/booking/days')).json()) as { label: string; booked: Record<string, number> }[]
    expect(list.find((d) => d.label === label)?.booked).toEqual({ '10:00': 1, '11:00': 0 })
    await context.close()
  })

  await s.step('без ошибок консоли и ответов 4xx/5xx', async () => {
    h.none(hr.problems.slice(beforeLogin), 'HR: ошибки консоли и ответы 4xx/5xx после входа')
    h.none(candidate.problems, 'кандидат: ошибки консоли и ответы 4xx/5xx')
    await hr.context.close()
    await candidate.context.close()
  })
  return [s]
}
