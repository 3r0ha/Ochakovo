// «Воронка» HR-панели, пакет hr-insights, в браузере: на демо-заявках итог «Заданий и найма» равен плитке «Заявка»
// и ответу API, в источниках нет сырых меток, незнакомая метка подсвечена, приглашения друзей — одной строкой с именами,
// «По неделям» — итог равен сумме недель, «Какое задание ведёт к заявке» — четыре задания и «Без заданий»,
// в «Заявки.xlsx» есть листы «Воронка» и «Недели», на телефоне страница не уезжает вбок.
// Демо-заявки сценарий сеет прямо в базу прогона (как кнопка «Демо-данные») и в конце удаляет только их.
// Только он: E2E_ONLY=w1-hr-insights pnpm test:e2e

import { randomBytes } from 'node:crypto'
import type { Page } from 'playwright'
import { seedDemo } from '../../server/db/demo'
import { unzip } from '../../server/export/xlsxWriter'
import type { E2eHarness } from './_harness'

type Report = {
  rows: { source: string; applications: number }[]
  tasks: { rows: { bucket: string; applications: number }[]; leads: { task: string }[] }
  weeks: { applications: number }[]
}

/** День по Москве для поля периода — как в панели */
const isoDay = (t: number) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10)

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const unknownSource = `qr-${randomBytes(3).toString('hex')}`

  // Что было в базе прогона до сценария: удаляем только своё
  const before = {
    apps: new Set((await sql<{ id: string }[]>`select id from applications`).map((r) => r.id)),
    gap: (await sql<{ n: number }[]>`select coalesce(max(id), 0)::int as n from kb_gaps`)[0].n,
  }
  const cleanup = async () => {
    const ids = (await sql<{ id: string }[]>`select id from applications`).map((r) => r.id).filter((id) => !before.apps.has(id))
    if (ids.length) await sql`delete from applications where id = any(${ids})`
    await sql`delete from funnel_events where visitor like 'demo-%'`
    await sql`delete from sessions where user_id like 'demo-%'`
    await sql`delete from bot_users where user_id like 'demo-%'`
    await sql`delete from kb_gaps where id > ${before.gap}`
  }

  const funnelPage = async (page: Page) => {
    await h.loginHr(page)
    // Вкладкой, как сотрудник: переход по адресу посреди загрузки панели Safari считает ошибкой загрузки модуля
    await page.getByRole('button', { name: 'Воронка', exact: true }).filter({ visible: true }).click()
    await expect(page).toHaveURL(/tab=funnel/)
    await expect(page.getByRole('heading', { name: 'Воронка', level: 1 })).toBeVisible()
    // Отчёт пришёл: в плитках числа вместо прочерков
    await expect(tile(page, 'Заявка')).toHaveText(/^\d+$/)
  }
  const tile = (page: Page, label: string) =>
    page.locator('section[aria-labelledby="funnel-title"] > ol > li').filter({ has: page.getByText(label, { exact: true }) }).locator('p').nth(1)
  const number = async (page: Page, label: string) => Number(await tile(page, label).innerText())
  /** Ячейки строки «Итого» таблицы — числами */
  const totalRow = async (table: ReturnType<Page['locator']>) =>
    (await table.getByRole('row', { name: /^Итого/ }).locator('td').allInnerTexts()).map((t) => Number.parseInt(t, 10))
  const api = async (page: Page) => {
    const now = Date.now()
    const res = await page.request.get(`/api/hr/funnel?from=${isoDay(now - 29 * 864e5)}&to=${isoDay(now)}`)
    expect(res.status()).toBe(200)
    return (await res.json()) as Report
  }

  // ── Компьютер ───────────────────────────────────────────────────────
  const desk = new h.Scenario('hr-insights: «Воронка» на демо-заявках, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    await desk.step('демо-заявки и незнакомая метка — в базе прогона', async () => {
      expect(await seedDemo(sql, 24)).toBe(26)
      await sql`
        insert into applications (id, created_at, name, phone, channel, source, vacancy_id, game, months, status, consent_at, consent_version, consent_source)
        values (${`Q${randomBytes(4).toString('hex').toUpperCase()}`}, now() - interval '3 hours', 'Метка', '+79050000000', 'web', ${unknownSource},
                'bottling-operator', ${sql.json({ quizResult: null, conveyorBest: 0, activities: 0 })}, ${sql.json([7])}, 'new', now(), '1', 'site_form')`
    })
    await desk.step('«Задания и наём»: «Итого» равно плитке «Заявка» и ответу API', async () => {
      await funnelPage(page)
      const applications = await number(page, 'Заявка')
      const tasks = page.locator('section[aria-labelledby="tasks-title"]')
      await expect(tasks.getByRole('heading', { name: 'Задания и наём' })).toBeVisible()
      for (const label of ['0', '1–3', '4 из 4', 'Добавлены HR']) await expect(tasks.getByRole('rowheader', { name: label, exact: true })).toBeVisible()
      const [total] = await totalRow(tasks.getByRole('region', { name: /Задания и наём/ }))
      expect(total, '«Итого» в «Заданиях и найме»').toBe(applications)
      const report = await api(page)
      expect(report.rows.reduce((n, r) => n + r.applications, 0), 'сумма источников в API').toBe(applications)
      expect(report.tasks.rows.reduce((n, r) => n + r.applications, 0), 'сумма строк «Заданий и найма» в API').toBe(applications)
      expect(applications).toBeGreaterThanOrEqual(26)
    })
    await desk.step('«Какое задание ведёт к заявке»: четыре задания и «Без заданий»', async () => {
      const leads = page.locator('section[aria-labelledby="tasks-title"] table').last()
      await expect(page.getByRole('heading', { name: 'Какое задание ведёт к заявке' })).toBeVisible()
      await expect(page.getByText('Только сайт. Это связь, без доказательства причины', { exact: false })).toBeVisible()
      await expect(leads.locator('tbody th')).toHaveText(['Поймай брак', 'Собери лето', 'Подбор работы', 'Правда или миф', 'Без заданий'])
    })
    const sources = page.getByRole('region', { name: /Воронка по источникам/ })
    await desk.step('источники названы, сырых меток нет, незнакомая подсвечена', async () => {
      const labels = (await sources.locator('tbody tr td:first-child').allInnerTexts()).map((t) => t.trim())
      expect(labels.length).toBeGreaterThan(3)
      const raw = labels.filter((l) => /friend|share|^(fair|vk|tg|max)-/.test(l))
      expect(raw, 'сырые метки в таблице').toEqual([])
      const unknown = sources.getByRole('row').filter({ hasText: unknownSource })
      await expect(unknown).toHaveCount(1)
      await expect(unknown.getByText('метка без названия')).toBeVisible()
      await expect(page.getByText('Подсвеченной метки нет в словаре источников', { exact: false })).toBeVisible()
    })
    await desk.step('приглашения друзей — одна строка, по стрелке — пригласившие по именам', async () => {
      const friends = sources.getByRole('row').filter({ hasText: 'Приглашения друзей' })
      await expect(friends).toHaveCount(1)
      const toggle = friends.getByRole('button', { name: 'Показать пригласивших' })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(await sources.getByRole('row').filter({ hasText: /^От: / }).count()).toBeGreaterThanOrEqual(2)
    })
    await desk.step('«По неделям»: итог равен плитке и сумме недель', async () => {
      const applications = await number(page, 'Заявка')
      const weeksButton = page.getByRole('button', { name: 'По неделям' })
      await weeksButton.click()
      await expect(weeksButton).toHaveAttribute('aria-pressed', 'true')
      const weeks = page.getByRole('region', { name: /Воронка по неделям/ })
      const [total] = await totalRow(weeks)
      expect(total, '«Итого» по неделям').toBe(applications)
      const rows = weeks.locator('tbody tr').filter({ hasNotText: 'Итого' })
      const perWeek = (await rows.locator('td:first-of-type').allInnerTexts()).map((t) => Number.parseInt(t, 10))
      expect(perWeek.length).toBeGreaterThanOrEqual(4)
      expect(perWeek.reduce((n, v) => n + v, 0), 'сумма недель').toBe(applications)
      const labels = await rows.locator('th').allInnerTexts()
      for (const l of labels) expect(l, 'подпись недели без года').toMatch(/^\d{1,2}( [а-я]{3,4})?(–| – )\d{1,2} [а-я]{3,4}$/)
      const report = await api(page)
      expect(report.weeks.reduce((n, w) => n + w.applications, 0), 'недели в API').toBe(applications)
    })
    await desk.step('«Заявки.xlsx»: листы «Воронка» и «Недели» с названиями источников', async () => {
      const res = await page.request.post('/api/hr/export', { headers: { 'x-hr-request': '1' }, data: { format: 'xlsx', query: '' } })
      expect(res.status()).toBe(200)
      const files = unzip(Buffer.from(await res.body()))
      const book = files.get('xl/workbook.xml')?.toString('utf8') ?? ''
      const names = [...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])
      expect(names.slice(0, 3)).toEqual(['Заявки', 'Воронка', 'Недели'])
      const strings = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
      for (const s of ['Задания и наём', 'Какое задание ведёт к заявке', 'Приглашения друзей', `Метка без названия: ${unknownSource}`]) expect(strings, s).toContain(s)
      expect(strings).not.toMatch(/>friend-[a-z2-9]{6}</)
    })
    await desk.step('доступность: у кнопок и полей есть имена, контраст текста по AA', async () => {
      await page.getByRole('button', { name: 'По источникам' }).click()
      // Кнопки разреза меняют цвет плавно: контраст меряем после перехода
      await page.waitForTimeout(500)
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'элементы без имени')
      const low = (await h.contrastProblems(page)).filter((p) => p.where !== 'header')
      h.none(low.map((p) => `${p.where}: «${p.text}» ${p.ratio} < ${p.need}`), 'низкий контраст')
    })
    await desk.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Телефон ─────────────────────────────────────────────────────────
  const phone = new h.Scenario('hr-insights: «Воронка» на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    await phone.step('страница не уезжает вбок, таблицы прокручиваются в своей рамке', async () => {
      await funnelPage(page)
      for (const view of ['По источникам', 'По неделям']) {
        await page.getByRole('button', { name: view }).click()
        const o = await h.overflow(page)
        expect(o.scrolled, `${view}: горизонтальная прокрутка страницы: ${o.out.join(', ')}`).toBe(0)
        h.none(o.out, `${view}: за краем экрана`)
        const region = page.getByRole('region', { name: view === 'По источникам' ? /Воронка по источникам/ : /Воронка по неделям/ })
        const wide = await region.evaluate((el) => el.scrollWidth > el.clientWidth)
        expect(wide, `${view}: широкая таблица прокручивается внутри рамки`).toBe(true)
      }
    })
    await phone.step('первая колонка остаётся на месте при прокрутке таблицы', async () => {
      const region = page.getByRole('region', { name: /Воронка по неделям/ })
      const first = region.getByRole('row', { name: /^Итого/ }).locator('th')
      const x = (await first.boundingBox())!.x
      await region.evaluate((el) => (el.scrollLeft = 300))
      await page.waitForTimeout(100)
      expect(Math.round((await first.boundingBox())!.x)).toBe(Math.round(x))
    })
    await phone.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  await cleanup()
  return [desk, phone]
}
