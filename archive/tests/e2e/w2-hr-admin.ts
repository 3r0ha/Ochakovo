// HR-панель, пакет w2-hr-admin, в браузере: новый сотрудник с временным паролем задаёт свой при первом входе;
// раздача заявок по очереди со строкой состояния; правка суммы и закрытие вакансии — сразу в /api/content; «Состояние».
// Свои учётные записи и правки сценарий создаёт с меткой и в конце убирает.
// Только он: E2E_ONLY=w2-hr-admin pnpm test:e2e

import { randomBytes } from 'node:crypto'
import type { Page } from 'playwright'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const tag = randomBytes(3).toString('hex')
  const settings = (page: Page, section: string) => page.goto(`${h.baseUrl}/hr?tab=settings&section=${section}`)

  // ── Новый сотрудник ─────────────────────────────────────────────────
  const staff = new h.Scenario('w2-hr-admin: временный пароль от администратора, свой пароль при первом входе')
  {
    const email = `novyi-${tag}@ochakovo.test`
    let temp = ''
    const { context, page, problems } = await h.open(staff, h.DESKTOP)
    await staff.step('администратор заводит сотрудника: «Придумать» пароль, почта и пароль показаны один раз', async () => {
      await h.loginHr(page)
      await settings(page, 'users')
      await page.getByLabel('Имя').fill(`Нина Проверочная ${tag}`)
      await page.getByLabel('Рабочая почта').fill(email)
      await page.getByRole('button', { name: 'Придумать' }).click()
      temp = await page.getByLabel('Временный пароль').inputValue()
      expect(temp, 'пароль из трёх групп по четыре знака').toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
      await page.getByRole('button', { name: 'Добавить' }).click()
      await expect(page.getByRole('status').filter({ hasText: email })).toContainText(temp)
      await expect(page.getByText('Пароль временный: при входе нужно задать свой')).toBeVisible()
    })
    await staff.step('окно сброса пароля вместо системного запроса', async () => {
      const row = page.getByRole('listitem').filter({ hasText: email })
      await row.getByRole('button', { name: 'Сбросить пароль' }).click()
      const dialog = page.getByRole('dialog', { name: 'Сброс пароля' })
      await expect(dialog.getByLabel('Временный пароль')).toHaveValue(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
      await dialog.getByRole('button', { name: 'Отмена' }).click()
      await expect(dialog).toHaveCount(0)
    })
    await staff.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()

    const phone = await h.open(staff, h.MOBILE)
    await staff.step('телефон: вход с временным паролем ведёт к форме своего пароля, потом — в панель', async () => {
      const p = phone.page
      await p.goto(`${h.baseUrl}/hr/login`)
      await p.getByRole('textbox', { name: 'Рабочая почта' }).fill(email)
      await p.getByLabel('Пароль', { exact: true }).fill(temp)
      await p.getByRole('button', { name: 'Войти' }).click()
      await expect(p.getByRole('heading', { name: /Свой/ })).toBeVisible()
      const r = await h.overflow(p)
      expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
      await p.getByLabel('Новый пароль', { exact: true }).fill('коротко')
      await p.getByLabel('Новый пароль ещё раз').fill('коротко')
      await p.getByRole('button', { name: 'Сохранить и войти' }).click()
      await expect(p.getByText('Пароль должен быть не короче 10 символов')).toBeVisible()
      await p.getByLabel('Новый пароль', { exact: true }).fill(`свой-пароль-${tag}`)
      await p.getByLabel('Новый пароль ещё раз').fill(`свой-пароль-${tag}`)
      await p.getByRole('button', { name: 'Сохранить и войти' }).click()
      await p.waitForURL(/\/hr(\?|$)/)
      await expect(p.getByRole('heading', { level: 1 }).first()).toBeVisible()
      const [row] = await sql<{ must: boolean }[]>`select must_change_password as must from hr_users where email = ${email}`
      expect(row.must, 'смена пароля записана').toBe(false)
      h.none(phone.problems, 'ошибки консоли и ответы 4xx/5xx')
    })
    await phone.context.close()
    await sql`delete from hr_users where email = ${email}`
  }

  // ── Раздача по очереди ──────────────────────────────────────────────
  const queue = new h.Scenario('w2-hr-admin: раздача новых заявок по очереди')
  {
    const { context, page, problems } = await h.open(queue, h.MOBILE)
    await queue.step('переключатель и строка состояния; на телефоне без прокрутки вбок', async () => {
      await h.loginHr(page)
      await settings(page, 'users')
      const toggle = page.getByRole('switch', { name: /Раздавать новые заявки по очереди/ })
      await expect(toggle).not.toBeChecked()
      await toggle.check({ force: true })
      await expect(page.locator('#queue-status')).toContainText('Включено')
      const r = await h.overflow(page)
      expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
      await toggle.uncheck({ force: true })
      await expect(page.locator('#queue-status')).toContainText('Выключено')
      h.none(problems, 'ошибки консоли и ответы 4xx/5xx')
    })
    await context.close()
  }

  // ── Вакансии ────────────────────────────────────────────────────────
  const vac = new h.Scenario('w2-hr-admin: сумма и закрытие вакансии — сразу на сайте, правка в истории')
  {
    const { context, page, problems } = await h.open(vac, h.DESKTOP)
    const content = async () => (await (await page.request.get(`${h.baseUrl}/api/content`)).json()) as { vacancies: { id: string; pay?: { from: number } }[] }
    try {
      await vac.step('оператор линии розлива — 110 000 ₽: в списке, в истории и в /api/content', async () => {
        await h.loginHr(page)
        await settings(page, 'vacancies')
        await page.getByRole('button', { name: 'Править: Оператор линии розлива' }).click()
        const dialog = page.getByRole('dialog', { name: 'Оператор линии розлива' })
        await dialog.getByLabel('От, ₽').fill('110 000')
        await dialog.getByRole('button', { name: 'Сохранить' }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByRole('listitem').filter({ hasText: 'Оператор линии розлива' }).first()).toContainText('от 110 000')
        await expect(page.getByRole('complementary').filter({ hasText: 'История правок' })).toContainText('от 70 000 ₽ → от 110 000 ₽')
        expect((await content()).vacancies.find((v) => v.id === 'bottling-operator')?.pay?.from).toBe(110000)
      })
      await vac.step('бесплатная практика: полей суммы нет, есть пометка «предложение команды»', async () => {
        await page.getByRole('button', { name: 'Править: Практика в офисе' }).click()
        const dialog = page.getByRole('dialog', { name: 'Практика в офисе' })
        await expect(dialog.getByLabel('От, ₽')).toHaveCount(0)
        await expect(dialog.getByText('у бесплатной практики суммы нет', { exact: false })).toBeVisible()
        await expect(dialog.getByText('Предложение команды', { exact: false })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      })
      await vac.step('закрытая вакансия пропадает из /api/content', async () => {
        await page.getByRole('button', { name: 'Править: Мерчандайзер' }).click()
        const dialog = page.getByRole('dialog', { name: 'Мерчандайзер' })
        await dialog.getByLabel('Открыта: принимаем отклики', { exact: false }).uncheck()
        await dialog.getByRole('button', { name: 'Сохранить' }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByRole('listitem').filter({ hasText: 'Мерчандайзер' }).first()).toContainText('закрыта')
        expect((await content()).vacancies.some((v) => v.id === 'merchandiser'), 'мерчандайзер на сайте').toBe(false)
      })
      await vac.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    } finally {
      // Вернуть данные компании: остальные сценарии прогона ждут исходные суммы
      for (const id of ['bottling-operator', 'merchandiser'])
        await page.request.delete(`${h.baseUrl}/api/hr/content/vacancies/${id}`, { headers: { 'x-hr-request': '1' } }).catch(() => {})
    }
    await context.close()
  }

  // ── Состояние ───────────────────────────────────────────────────────
  const state = new h.Scenario('w2-hr-admin: «Состояние» и журнал выгрузок')
  {
    const { context, page, problems } = await h.open(state, h.MOBILE)
    await state.step('плитки и журнал; на телефоне без прокрутки вбок', async () => {
      await h.loginHr(page)
      await settings(page, 'state')
      await expect(page.getByRole('heading', { name: 'Очередь задач' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Журнал выгрузок' })).toBeVisible()
      await page.getByRole('button', { name: 'Excel' }).click()
      await expect(page.getByRole('button', { name: 'Excel' })).toHaveAttribute('aria-pressed', 'true')
      const r = await h.overflow(page)
      expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
      h.none(problems, 'ошибки консоли и ответы 4xx/5xx')
    })
    await context.close()
  }

  return [staff, queue, vac, state]
}
