// Вкладки «Боты» и «Рассылка» в браузере, пакет w2-channels.
// «Боты»: состояние каналов без токенов, лента предпросмотра /start fair-mgupp → «Поймай брак» с картинкой,
// тело запроса под сообщением, переключатель Telegram/MAX показывает ту же переписку; в базе от предпросмотра ничего.
// «Рассылка»: набор и срок, сегменты, предупреждение про чат на сайте, на телефоне без сдвига вбок.
// Только он: E2E_ONLY=w2-channels pnpm test:e2e

import type { Page } from 'playwright'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const counts = async () =>
    (
      await sql<{ n: number }[]>`
        select (select count(*) from applications)::int + (select count(*) from bot_users where user_id = 'preview')::int
             + (select count(*) from sessions where user_id = 'preview')::int as n`
    )[0].n

  /** Вкладка панели: на телефоне — в ленте разделов, на ноутбуке «Боты» и «Рассылка» — в меню «Ещё» */
  const openTab = async (page: Page, name: string, tab: string) => {
    await h.loginHr(page)
    const nav = page.getByRole('navigation', { name: 'Разделы панели' }).filter({ visible: true }).first()
    await expect(nav.getByRole('button', { name: 'Заявки', exact: true })).toBeVisible()
    const more = nav.getByRole('button', { name: 'Ещё', exact: true })
    if (await more.count()) await more.click()
    await nav.getByRole('button', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`tab=${tab}`))
  }
  const feed = (page: Page) => page.getByRole('log')
  /** Ошибки консоли и сети, кроме 401 до входа: панель спрашивает, кто вошёл, ещё на странице входа */
  const real = (problems: string[]) => problems.filter((p) => !/401 GET \/api\/hr\/me/.test(p))
  /** Кнопка в ленте — у последнего сообщения, где она есть */
  const press = (page: Page, name: string) => feed(page).getByRole('button', { name, exact: true }).last().click()

  const desk = new h.Scenario('w2-channels: «Боты» — каналы и лента предпросмотра, 1440 px')
  {
    const { context, page, problems } = await h.open(desk, h.DESKTOP)
    const before = await counts()
    await desk.step('состояние каналов из окружения: без токенов боты не подключены, MAX ждёт регистрации', async () => {
      await openTab(page, 'Боты', 'bots')
      await expect(page.getByText('Не подключён')).toHaveCount(2)
      await expect(page.getByText('Бот готов к запуску, нужен токен от @BotFather', { exact: false })).toBeVisible()
      await expect(page.getByText('Бот в MAX сначала регистрируют на самозанятого, ИП или компанию', { exact: false })).toBeVisible()
      // Имена переменных окружения — только в «Для администратора»
      await expect(page.getByText('TELEGRAM_BOT_TOKEN', { exact: false })).toBeHidden()
      await page.getByText('Для администратора').first().click()
      await expect(page.getByText('Впиши токен в TELEGRAM_BOT_TOKEN', { exact: false })).toBeVisible()
      await expect(page.getByText('Тот же движок, что у ботов. В мессенджер ничего не уходит')).toBeVisible()
    })
    await desk.step('/start fair-mgupp → «Поймай брак» с картинкой', async () => {
      await page.getByLabel('Метка для /start').fill('fair-mgupp')
      await page.getByRole('button', { name: 'Запустить' }).click()
      await expect(feed(page).getByText('Метка из ссылки: fair-mgupp')).toBeVisible()
      await press(page, 'Поймай брак')
      await press(page, 'Начать')
      const img = feed(page).locator('img').last()
      await expect(img).toBeVisible()
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    })
    await desk.step('под сообщением — тело запроса после сборщика: кнопки раунда — callback_data', async () => {
      const details = feed(page).locator('details').last()
      await details.locator('summary').click()
      await expect(details).toContainText('/bot<токен>/sendPhoto')
      await expect(details).toContainText(/"callback_data": "g:\d+:1"/)
    })
    await desk.step('переключатель MAX: та же переписка, запуск по ссылке и /messages', async () => {
      await page.getByRole('radio', { name: 'MAX' }).click()
      await expect(feed(page).getByText('Бот запущен по ссылке с меткой fair-mgupp')).toBeVisible()
      await expect(feed(page).getByText('Раунд 1 из 5').first()).toBeVisible()
      const details = feed(page).locator('details').last()
      await details.locator('summary').click()
      await expect(details).toContainText('/messages?user_id=')
      await expect(details).toContainText('"type": "callback"')
      await page.getByRole('radio', { name: 'Telegram' }).click()
    })
    await desk.step('в базе от предпросмотра ничего; доступность', async () => {
      expect(await counts()).toBe(before)
      expect(await h.unnamedControls(context, page)).toEqual([])
      // Опрос, а не один замер: переключатели меняют цвет плавно, 200 мс
      await expect.poll(() => h.contrastProblems(page)).toEqual([])
      expect(real(problems)).toEqual([])
    })
    await context.close()
  }

  const phone = new h.Scenario('w2-channels: «Боты» и «Рассылка» на телефоне, 390 px')
  {
    const { context, page, problems } = await h.open(phone, h.MOBILE)
    await phone.step('лента на телефоне: запуск, кнопка, без сдвига вбок', async () => {
      await openTab(page, 'Боты', 'bots')
      await page.getByRole('button', { name: 'Запустить' }).click()
      await expect(feed(page).getByText('Выбери раздел').first()).toBeVisible()
      await press(page, 'Практика')
      await expect(feed(page).getByText('Нажата кнопка «Практика»')).toBeVisible()
      const o = await h.overflow(page)
      expect(o.out).toEqual([])
      expect(o.scrolled).toBe(0)
    })
    await phone.step('«Рассылка»: набор, сегменты, про чат на сайте; без сдвига вбок', async () => {
      await page.getByRole('button', { name: 'Рассылка', exact: true }).filter({ visible: true }).first().click()
      await expect(page).toHaveURL(/tab=broadcast/)
      await expect(page.getByRole('heading', { name: 'Набор' })).toBeVisible()
      await expect(page.getByText('Подписчики из чата на сайте рассылку не получают', { exact: false })).toBeVisible()
      await page.getByRole('radio', { name: 'По направлению' }).click()
      await expect(page.getByLabel('Направление')).toBeVisible()
      await expect(page.getByText('Не присылать').first()).toBeVisible()
      const o = await h.overflow(page)
      expect(o.out).toEqual([])
      expect(o.scrolled).toBe(0)
      expect(real(problems)).toEqual([])
    })
    await context.close()
  }

  const cast = new h.Scenario('w2-channels: «Рассылка» — набор и срок окончания, 1440 px')
  {
    const { context, page, problems } = await h.open(cast, h.DESKTOP)
    const [saved] = await sql<{ state: string; ends_on: string | null }[]>`select state, to_char(ends_on, 'YYYY-MM-DD') as ends_on from recruit_state where id = 1`
    await cast.step('набор открывается со сроком, «До конца приёма» становится доступным', async () => {
      await openTab(page, 'Рассылка', 'broadcast')
      await expect(page.getByRole('heading', { name: 'Журнал' })).toBeVisible()
      // Контраст — до сохранения: всплывающее сообщение о сохранении появляется плавно и мешало бы замеру.
      // Опрос, а не один замер: переключатели меняют цвет плавно, 200 мс
      await expect.poll(() => h.contrastProblems(page)).toEqual([])
      await page.getByRole('radio', { name: 'Открыт', exact: true }).click()
      // Срок — через пять дней от сегодняшнего по Москве
      const d = new Date(Date.now() + 3 * 3600e3 + 5 * 864e5).toISOString().slice(0, 10)
      await page.getByLabel('Срок окончания приёма').fill(d)
      await page.getByRole('button', { name: 'Сохранить' }).click()
      await expect(page.getByText('Набор открыт, до конца приёма 5 дней')).toBeVisible()
      await page.getByRole('radio', { name: 'Напомнить о сроке · 5 дней' }).click()
      await expect(page.getByText('До конца приёма заявок осталось 5 дней').first()).toBeVisible()
      expect(await h.unnamedControls(context, page)).toEqual([])
      expect(real(problems)).toEqual([])
    })
    await sql`update recruit_state set state = ${saved?.state ?? 'closed'}, ends_on = ${saved?.ends_on ?? null} where id = 1`
    await context.close()
  }

  return [desk, phone, cast]
}
