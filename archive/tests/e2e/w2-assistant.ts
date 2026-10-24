// «Вопросы к Квасычу» в браузере, пакет w2-assistant: HR отвечает на вопрос без ответа прямо в панели — проверка
// текста на лету («!», род), сохранение, ответ в списке «Ответы отдела персонала», и Квасыч в чате отвечает этим текстом.
// На телефоне форма не уезжает вбок. Вопросы и ответы прогона сценарий в конце удаляет.
// Только он: E2E_ONLY=w2-assistant pnpm test:e2e

import type { Page } from 'playwright'
import type { E2eHarness } from './_harness'

const QUESTION = 'есть ли парковка для сотрудников у проходной'
const ANSWER = 'Отдельной парковки для сотрудников нет: удобнее доехать на корпоративном автобусе от м. «Озёрная».'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const gapBefore = (await sql<{ n: number }[]>`select coalesce(max(id), 0)::int as n from kb_gaps`)[0].n
  const answersBefore = (await sql<{ n: number }[]>`select coalesce(max(id), 0)::int as n from kb_answers`)[0].n
  const cleanup = async () => {
    await sql`update kb_gaps set answer_id = null where id > ${gapBefore}`
    await sql`delete from kb_answers where id > ${answersBefore}`
    await sql`delete from kb_gaps where id > ${gapBefore}`
  }

  /** Вопрос в чат сайта — как у посетителя */
  const askKvasych = async (page: Page, text: string) => {
    const r = await page.request.post('/api/dialog', { data: { user: { channel: 'web', id: `e2e-kb-${Math.random().toString(36).slice(2, 10)}` }, event: { type: 'text', text } } })
    expect(r.status()).toBe(200)
    return ((await r.json()) as { messages: { text: string }[] }).messages.map((m) => m.text).join('\n\n')
  }

  const gapsTab = async (page: Page) => {
    await h.loginHr(page)
    // На вкладке — число вопросов без ответа: «Вопросы к Квасычу 3»
    await page.getByRole('button', { name: /^Вопросы к Квасычу/ }).filter({ visible: true }).first().click()
    await expect(page).toHaveURL(/tab=gaps/)
  }
  const questionRow = (page: Page) => page.locator('li').filter({ has: page.getByText(QUESTION, { exact: true }) })

  const desk = new h.Scenario('w2-assistant: HR отвечает на вопрос к Квасычу, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    await desk.step('вопрос без ответа попадает в «Вопросы к Квасычу»', async () => {
      expect(await askKvasych(page, QUESTION)).toMatch(/^Точного ответа в моих данных нет/)
      await gapsTab(page)
      await expect(questionRow(page)).toBeVisible()
    })
    await desk.step('проверка на лету: «!» мешает сохранить, род — подсказка', async () => {
      await questionRow(page).getByRole('button', { name: 'Ответить' }).click()
      const field = page.getByLabel('Ответ Квасыча')
      await expect(field).toBeFocused()
      await field.fill('Если готов приехать на машине, парковка рядом!')
      await expect(page.getByRole('alert').filter({ hasText: 'Без «!»' })).toBeVisible()
      await expect(page.getByText(/Проверь род: «готов»/)).toBeVisible()
    })
    await desk.step('сохранить: вопрос разобран, ответ — в списке, Квасыч отвечает этим текстом', async () => {
      await page.getByLabel('Ответ Квасыча').fill(ANSWER)
      await page.getByLabel('Другие формулировки (если нужно)').fill('можно приехать на своей машине?')
      await page.getByRole('button', { name: 'Сохранить ответ' }).click()
      await expect(page.getByText('Квасыч отвечает этим текстом')).toBeVisible()
      await expect(questionRow(page).getByRole('button', { name: 'Ответить' })).toHaveCount(0)
      await expect(page.getByText(ANSWER, { exact: true })).toBeVisible()
      expect((await askKvasych(page, 'можно приехать на своей машине?')).split('\n\n')[0]).toBe(ANSWER)
    })
    await desk.step('выключить ответ — Квасыч снова советует отдел персонала', async () => {
      const item = page.locator('li').filter({ has: page.getByText(ANSWER, { exact: true }) })
      await item.getByRole('button', { name: 'Выключить' }).click()
      await expect(page.getByText('Ответ выключен')).toBeVisible()
      await expect(item.getByRole('button', { name: 'Включить' })).toBeVisible()
      expect(await askKvasych(page, QUESTION)).toMatch(/^Точного ответа в моих данных нет/)
    })
    await desk.step('доступность: у кнопок и полей есть имена', async () => {
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'элементы без имени')
    })
    await desk.step('без ошибок консоли', async () => h.none(problems.filter((p) => !/ 422 /.test(p)), 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  const phone = new h.Scenario('w2-assistant: форма ответа на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    await phone.step('форма ответа не уезжает вбок', async () => {
      await askKvasych(page, QUESTION)
      await gapsTab(page)
      await questionRow(page).first().getByRole('button', { name: 'Ответить' }).click()
      await page.getByLabel('Ответ Квасыча').fill(ANSWER)
      await expect(page.getByRole('button', { name: 'Сохранить ответ' })).toBeVisible()
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка страницы: ${o.out.join(', ')}`).toBe(0)
      h.none(o.out.filter((x) => !/nav|tab/i.test(x)), 'за краем экрана')
    })
    await phone.step('без ошибок консоли', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  await cleanup()
  return [desk, phone]
}
