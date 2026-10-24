// «Воронка» второй волны в браузере, пакет w2-hr-insights: на демо-заявках плитки «Отработали сезон» и «В штате
// или резерве» с долей от вышедших, «Сравнение с цифрами компании» (по данным панели и по данным компании), явка,
// «Почему ушли» рядом с «Почему отказ», приглашения друзей с теми, кто дошёл до смены; в выгрузках — поля кейса,
// 1С — в Windows-1251. На телефоне страница не уезжает вбок.
// Демо-заявки сценарий сеет прямо в базу прогона (как кнопка «Демо-данные») и в конце удаляет только их.
// Только он: E2E_ONLY=w2-hr-insights pnpm test:e2e

import type { Page } from 'playwright'
import { seedDemo } from '../../server/db/demo'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h

  const before = new Set((await sql<{ id: string }[]>`select id from applications`).map((r) => r.id))
  const gap = (await sql<{ n: number }[]>`select coalesce(max(id), 0)::int as n from kb_gaps`)[0].n
  const cleanup = async () => {
    const ids = (await sql<{ id: string }[]>`select id from applications`).map((r) => r.id).filter((id) => !before.has(id))
    if (ids.length) await sql`delete from applications where id = any(${ids})`
    await sql`delete from funnel_events where visitor like 'demo-%'`
    await sql`delete from sessions where user_id like 'demo-%'`
    await sql`delete from bot_users where user_id like 'demo-%'`
    await sql`delete from kb_gaps where id > ${gap}`
  }

  const funnelPage = async (page: Page) => {
    await h.loginHr(page)
    await page.getByRole('button', { name: 'Воронка', exact: true }).filter({ visible: true }).click()
    await expect(page).toHaveURL(/tab=funnel/)
    await expect(tile(page, 'Заявка')).toHaveText(/^\d+$/)
  }
  const tiles = (page: Page) => page.locator('section[aria-labelledby="funnel-title"] > ol > li')
  const tile = (page: Page, label: string) => tiles(page).filter({ has: page.getByText(label, { exact: true }) }).locator('p').nth(1)

  const desk = new h.Scenario('w2-hr-insights: «Воронка» до конца сезона и цифры кейса, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    await desk.step('демо-заявки — в базе прогона', async () => {
      expect(await seedDemo(sql, 24)).toBe(26)
    })
    await desk.step('плитки «Отработали сезон» и «В штате или резерве» — с долей от вышедших', async () => {
      await funnelPage(page)
      await expect(tiles(page)).toHaveCount(8)
      expect(Number(await tile(page, 'Отработали сезон').innerText())).toBeGreaterThanOrEqual(2)
      expect(Number(await tile(page, 'В штате или резерве').innerText())).toBeGreaterThanOrEqual(1)
      await expect(tiles(page).filter({ hasText: 'Отработали сезон' })).toContainText('от вышедших')
      const sources = page.getByRole('region', { name: /Воронка по источникам/ })
      // Колонки итога сезона — по переключателю «Итог сезона»; «Итого» — первой строкой
      await expect(sources.getByRole('columnheader', { name: 'Отработали' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Итог сезона' }).click()
      for (const col of ['Отработали', 'Штат и резерв']) await expect(sources.getByRole('columnheader', { name: col })).toBeVisible()
      await expect(sources.getByRole('row', { name: /^Итого/ })).toBeVisible()
      await expect(sources.locator('tbody tr').first()).toHaveText(/^Итого/)
    })
    await desk.step('«Сравнение с цифрами компании»: по данным панели и по данным компании', async () => {
      const block = page.locator('section[aria-labelledby="case-title"]')
      await expect(block.getByRole('heading', { name: /Сравнение с\s+цифрами компании/ })).toBeVisible()
      for (const title of ['Конверсия в найм', 'Ушли до конца сезона', 'Средний возраст принятых']) await expect(block.getByRole('heading', { name: title })).toBeVisible()
      await expect(block.getByText('по данным панели', { exact: true })).toHaveCount(3)
      await expect(block.getByText('0,02%', { exact: true })).toBeVisible()
      await expect(block.getByText('38%', { exact: true })).toBeVisible()
      await expect(block.getByText('52', { exact: true })).toBeVisible()
      await expect(block.getByText(/сравнение ориентировочное/)).toBeVisible()
    })
    await desk.step('явка, «Почему отказ» и «Почему ушли», приглашения друзей', async () => {
      await expect(page.getByRole('heading', { name: 'Явка', exact: true })).toBeVisible()
      await expect(page.getByText(/Пришли \d+ из \d+ прошедших собеседований с отметкой/)).toBeVisible()
      await expect(page.getByRole('heading', { name: /Почему ушли/ })).toBeVisible()
      const invites = page.locator('section[aria-labelledby="invites-title"]')
      await expect(invites.getByText(/дошли до\s+смены/)).toBeVisible()
      await expect(invites.locator('li').filter({ hasText: 'на смене' }).first()).toBeVisible()
    })
    await desk.step('выгрузки: поля кейса в CSV, «Дата приёма» в 1С в Windows-1251', async () => {
      const csv = await page.request.post('/api/hr/export', { headers: { 'x-hr-request': '1' }, data: { format: 'csv', query: '' } })
      expect(csv.status()).toBe(200)
      const head = (await csv.text()).split('\r\n')[0]
      for (const label of ['Дата рождения', 'Возраст', 'Когда может выйти', 'Вуз или колледж', 'Согласие: где', 'Первая смена', 'Наставник', 'Итог сезона'])
        expect(head, label).toContain(`"${label}"`)
      const oneC = await page.request.post('/api/hr/export', { headers: { 'x-hr-request': '1' }, data: { format: 'csv1c', query: '' } })
      expect(oneC.headers()['content-type']).toMatch(/windows-1251/)
      const text = new TextDecoder('windows-1251').decode(await oneC.body())
      expect(text.split('\r\n')[0]).toMatch(/^Фамилия;Имя;Отчество;.*;Номер заявки;Дата рождения;.*;Дата приёма;/)
    })
    await desk.step('доступность: у кнопок есть имена, контраст текста по AA', async () => {
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'элементы без имени')
      const low = (await h.contrastProblems(page)).filter((p) => p.where !== 'header')
      h.none(low.map((p) => `${p.where}: «${p.text}» ${p.ratio} < ${p.need}`), 'низкий контраст')
    })
    await desk.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  const phone = new h.Scenario('w2-hr-insights: «Воронка» на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    await phone.step('страница не уезжает вбок, новые блоки на месте', async () => {
      await funnelPage(page)
      await expect(page.locator('section[aria-labelledby="case-title"]')).toBeVisible()
      await page.locator('section[aria-labelledby="invites-title"]').scrollIntoViewIfNeeded()
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка страницы: ${o.out.join(', ')}`).toBe(0)
      h.none(o.out, 'за краем экрана')
    })
    await phone.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  await cleanup()
  return [desk, phone]
}
