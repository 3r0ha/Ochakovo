// HR-панель, пакет hr-desk, в браузере: обзвон клавишами (10 недозвонов подряд, пропуск изменённых, «Отменить»,
// «Позвони кандидату» не уводит карточку), явка в карточке и в графике, фокус в окнах, подписи у кнопок и полей,
// список порциями с «выбрать все найденные» и раздачей поровну, фильтр «Задания», раскладка на телефоне.
// Свои заявки сценарий создаёт прямо в базе прогона с меткой в имени и в конце удаляет.
// Только он: E2E_ONLY=hr-desk pnpm test:e2e

import { randomBytes } from 'node:crypto'
import type { Page } from 'playwright'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const tag = `Дск${randomBytes(3).toString('hex')}`
  let seq = 0

  /** Заявки прямо в базе: имя «<префикс><метка> N», свежие сверху в порядке номеров */
  const seed = async (prefix: string, count: number, extra: (i: number) => { status?: string; phone?: string; contact?: string; activities?: number } = () => ({})) => {
    const ids: string[] = []
    for (let i = 1; i <= count; i++) {
      const e = extra(i)
      const id = `E${randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 9)
      const phone = e.phone ?? `+7905${String(1_000_000 + ++seq + Math.floor(Math.random() * 8_000_000)).padStart(7, '0')}`
      await sql`
        insert into applications (id, created_at, name, phone, contact, channel, source, vacancy_id, game, months, status, consent_at, consent_version, consent_source)
        values (${id}, now() - make_interval(secs => ${i}), ${`${prefix}${tag} ${i}`}, ${phone}, ${e.contact ?? ''}, 'web', 'vk', 'bottling-operator',
                ${sql.json({ quizResult: null, conveyorBest: 0, activities: e.activities ?? 0 })}, ${sql.json([7])}, ${e.status ?? 'new'}, now(), '1', 'site_form')`
      await sql`insert into application_history (application_id, user_name, kind, from_status, to_status) values (${id}, 'Система', 'status', null, 'new')`
      ids.push(id)
    }
    return ids
  }
  /** Собеседование, которое уже прошло, без отметки явки */
  const pastInterview = async (id: string) => {
    await sql`update applications set status = 'interview', status_updated_at = now() where id = ${id}`
    await sql`insert into application_history (application_id, user_name, kind, from_status, to_status) values (${id}, 'Система', 'status', 'new', 'interview')`
    await sql`insert into interviews (application_id, starts_at, address, bring)
              values (${id}, greatest(now() - interval '3 hours', date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow' + interval '1 minute'),
                      'Москва, ул. Рябиновая, 44', 'паспорт')`
  }
  const cleanup = async () => {
    await sql`delete from applications where name like ${`%${tag}%`}`
    await sql`delete from hr_users where email like ${`%${tag.toLowerCase()}%`}`
  }
  const search = async (page: Page, text: string) => {
    await page.getByRole('searchbox', { name: 'Поиск' }).fill(text)
    // Поиск ждёт паузу в наборе 150 мс и только потом уходит в адрес
    await page.waitForURL((u) => u.searchParams.get('q') === text)
  }
  const status = async (id: string) => (await sql<{ status: string }[]>`select status from applications where id = ${id}`)[0]?.status
  /** Вид «Все»: свежие заявки сверху — обзвон идёт в порядке списка, номера в именах совпадают с порядком */
  const allView = async (page: Page) => {
    await page.getByRole('group', { name: 'Виды списка' }).getByRole('button', { name: /^Все · \d+$/ }).click()
    await page.waitForURL((u) => !u.searchParams.has('status'))
  }
  /** Вид «Итог не отмечен · N» над списком: число прошедших собеседований без отметки явки */
  const unmarkedTile = async (page: Page) => {
    const view = page.getByRole('group', { name: 'Виды списка' }).getByRole('button', { name: /^Итог не отмечен · \d+$/ })
    return Number(((await view.innerText()).match(/\d+/) ?? ['-1'])[0])
  }
  const unmarkedDb = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from applications a
        join lateral (select * from interviews where application_id = a.id and cancelled_at is null order by created_at desc limit 1) i on true
        where a.status = 'interview' and a.duplicate_of is null and a.anonymized_at is null and i.attended = '' and i.starts_at <= now()`
    )[0].n

  // ── Обзвон ──────────────────────────────────────────────────────────
  const call = new h.Scenario('hr-desk: обзвон клавишами Д, Н и →')
  {
    const { context, page, problems } = await h.open(call, h.DESKTOP)
    let ids: string[] = []
    await call.step('вход и отбор: четыре новые заявки', async () => {
      ids = await seed('Обзвон', 4)
      await h.loginHr(page)
      await allView(page)
      await search(page, `Обзвон${tag}`)
      await expect(page.getByText('Найдено: 4 из', { exact: false })).toBeVisible()
    })
    const card = page.getByRole('dialog', { name: /^Заявка/ })
    const bar = card.getByRole('region', { name: 'Обзвон' })
    await call.step('«Обзвон · 4»: список запомнен, «1 из 4»', async () => {
      await page.getByRole('button', { name: 'Обзвон · 4' }).click()
      await expect(bar.getByText('Обзвон · 1 из 4')).toBeVisible()
      await expect(card.getByRole('heading', { level: 2 })).toHaveText(new RegExp(`Обзвон${tag} 1`, 'i'))
    })
    await call.step('Н — недозвон, статус «Не отвечает», сразу следующая', async () => {
      await page.keyboard.press('KeyY')
      await expect(bar.getByText('Обзвон · 2 из 4')).toBeVisible()
      await expect.poll(() => status(ids[0])).toBe('no_answer')
      // Список не пересобирается: заявка ушла бы из «Новых», а обзвон идёт дальше по запомненному
      await expect(card.getByRole('heading', { level: 2 })).toHaveText(new RegExp(`Обзвон${tag} 2`, 'i'))
    })
    await call.step('клавиши не срабатывают с модификатором, в поле и в открытой форме', async () => {
      await page.keyboard.press('Control+KeyY')
      await page.keyboard.press('Shift+KeyL')
      const notes = card.getByRole('textbox', { name: 'Заметки о кандидате' })
      await notes.click()
      await page.keyboard.press('KeyY')
      await expect(notes).toHaveValue(/^[нy]$/i)
      await notes.fill('')
      await card.getByRole('button', { name: 'Пригласить на собеседование' }).click()
      await card.locator('h2, h3').filter({ hasText: 'Пригласить на собеседование' }).first().focus().catch(() => {})
      await page.locator('#hr-card').focus()
      await page.keyboard.press('KeyY')
      await page.keyboard.press('ArrowRight')
      await card.getByRole('button', { name: 'Отмена' }).first().click()
      await page.waitForTimeout(400)
      await expect(bar.getByText('Обзвон · 2 из 4')).toBeVisible()
      expect(await status(ids[1])).toBe('new')
    })
    await call.step('Д — дозвонились, статус «Связались», заявка остаётся открытой', async () => {
      await page.locator('#hr-card').focus()
      await page.keyboard.press('KeyL')
      await expect.poll(() => status(ids[1])).toBe('contacted')
      await expect(bar.getByText('дозвонились 1, недозвон 1')).toBeVisible()
      await expect(bar.getByText('Обзвон · 2 из 4')).toBeVisible()
    })
    await call.step('→ — дальше без звонка, «Перезвонить» — тоже дальше', async () => {
      await page.keyboard.press('ArrowRight')
      await expect(bar.getByText('Обзвон · 3 из 4')).toBeVisible()
      const section = card.locator('section', { has: page.getByRole('heading', { name: 'Перезвонить' }) })
      await section.getByRole('button').first().click()
      await expect(bar.getByText('Обзвон · 4 из 4')).toBeVisible()
      const [row] = await sql<{ callback_at: Date | null }[]>`select callback_at from applications where id = ${ids[2]}`
      expect(row.callback_at, 'задача «перезвонить» поставлена').toBeTruthy()
    })
    await call.step('после последней — итог «дозвонились 1, недозвон 1»', async () => {
      await page.locator('#hr-card').focus()
      await page.keyboard.press('ArrowRight')
      const summary = page.getByRole('dialog', { name: 'Обзвон закончен' })
      await expect(summary.getByText('Дозвонились 1, недозвон 1', { exact: false })).toBeVisible()
      await summary.getByRole('button', { name: 'Готово' }).click()
      expect(await status(ids[3])).toBe('new')
    })
    await call.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Обзвон: серия ───────────────────────────────────────────────────
  const series = new h.Scenario('hr-desk: обзвон — 10 недозвонов подряд, пропуск изменённой, «Отменить», «Позвони кандидату»')
  {
    const { context, page, problems } = await h.open(series, h.DESKTOP)
    let ids: string[] = []
    const card = page.getByRole('dialog', { name: /^Заявка/ })
    const bar = card.getByRole('region', { name: 'Обзвон' })
    const heading = card.getByRole('heading', { level: 2 })
    const noAnswer = async (id: string) => (await sql<{ status: string; n: number }[]>`select status, no_answer_count as n from applications where id = ${id}`)[0]
    await series.step('«Обзвон · 12» по отбору, коллега тем временем дозвонился до шестой', async () => {
      ids = await seed('Серия', 12)
      await h.loginHr(page)
      await allView(page)
      await search(page, `Серия${tag}`)
      await page.getByRole('button', { name: 'Обзвон · 12' }).click()
      await expect(bar.getByText('Обзвон · 1 из 12')).toBeVisible()
      // Другой сотрудник меняет шестую заявку уже после старта обзвона
      await sql`update applications set status = 'contacted', status_updated_at = now() where id = ${ids[5]}`
      await sql`insert into application_history (application_id, user_name, kind, from_status, to_status) values (${ids[5]}, 'Коллега', 'status', 'new', 'contacted')`
    })
    await series.step('10 нажатий Н — 10 недозвонов, изменённая коллегой пропущена', async () => {
      // Порядок — как в списке при старте: 1–5, шестая пропущена, 7–11
      const order = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]
      for (const [i, n] of order.entries()) {
        await expect(heading).toHaveText(new RegExp(`Серия${tag} ${n}$`, 'i'))
        await expect(bar.getByText(`Обзвон · ${n} из 12`)).toBeVisible()
        await page.locator('#hr-card').focus()
        await page.keyboard.press('KeyY')
        await expect(bar.getByText(`недозвон ${i + 1}`)).toBeVisible()
      }
      await expect(heading).toHaveText(new RegExp(`Серия${tag} 12$`, 'i'))
      await expect(bar.getByText('Обзвон · 12 из 12')).toBeVisible()
      for (const n of order) expect(await noAnswer(ids[n - 1]), `заявка ${n}`).toEqual({ status: 'no_answer', n: 1 })
      expect(await noAnswer(ids[5]), 'шестую не трогали').toEqual({ status: 'contacted', n: 0 })
      await expect(page.locator('[data-hr-toasts]').getByText(`Пропущена заявка: Серия${tag} 6`)).toBeVisible()
    })
    await series.step('«Отменить» в последнем сообщении возвращает одиннадцатую, а не открытую двенадцатую', async () => {
      await page.locator('[data-hr-toasts]').getByRole('button', { name: 'Отменить' }).last().click()
      await expect.poll(async () => (await noAnswer(ids[10])).status).toBe('new')
      expect((await noAnswer(ids[9])).status, 'десятая — как была').toBe('no_answer')
      expect((await noAnswer(ids[11])).status, 'открытая не тронута').toBe('new')
      await expect(bar.getByText('дозвонились 0, недозвон 9')).toBeVisible()
      await expect(heading).toHaveText(new RegExp(`Серия${tag} 12$`, 'i'))
    })
    await series.step('приглашение кандидату с сайта: «Позвони кандидату», карточка остаётся', async () => {
      await card.getByRole('button', { name: 'Пригласить на собеседование' }).click()
      await card.getByText('Время согласуем по телефону').click()
      await card.getByRole('button', { name: 'Пригласить', exact: true }).click()
      await expect(card.getByRole('status').getByText('Позвони кандидату', { exact: true })).toBeVisible()
      await expect.poll(() => status(ids[11])).toBe('interview')
      await page.waitForTimeout(500)
      await expect(heading).toHaveText(new RegExp(`Серия${tag} 12$`, 'i'))
      await expect(bar.getByText('Обзвон · 12 из 12')).toBeVisible()
      await expect(bar.getByText('дозвонились 1, недозвон 9'), 'пригласили — значит, дозвонились').toBeVisible()
    })
    await series.step('→ — итог «Дозвонились 1, недозвон 9, пропущено 1»', async () => {
      await page.locator('#hr-card').focus()
      await page.keyboard.press('ArrowRight')
      const summary = page.getByRole('dialog', { name: 'Обзвон закончен' })
      await expect(summary.getByText('Дозвонились 1, недозвон 9, пропущено 1', { exact: false })).toBeVisible()
      await summary.getByRole('button', { name: 'Готово' }).click()
    })
    await series.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Явка ────────────────────────────────────────────────────────────
  const attendance = new h.Scenario('hr-desk: явка и неявка в карточке и графике')
  {
    const { context, page, problems } = await h.open(attendance, h.DESKTOP)
    let ids: string[] = []
    await attendance.step('вид «Итог не отмечен» совпадает с прошедшими собеседованиями без отметки', async () => {
      ids = await seed('Явка', 2)
      for (const id of ids) await pastInterview(id)
      await h.loginHr(page)
      await expect.poll(() => unmarkedTile(page)).toBe(await unmarkedDb())
      expect(await unmarkedDb()).toBeGreaterThanOrEqual(2)
    })
    await attendance.step('карточка: «Явка», история и «Отменить»', async () => {
      await search(page, `Явка${tag} 1`)
      await page.getByRole('button', { name: new RegExp(`Явка${tag} 1`) }).filter({ visible: true }).first().click()
      const card = page.getByRole('dialog', { name: /^Заявка/ })
      await card.getByRole('heading', { name: 'Итог собеседования' }).waitFor()
      await card.getByRole('button', { name: 'Явка', exact: true }).click()
      const attended = async () => (await sql<{ attended: string }[]>`select attended from interviews where application_id = ${ids[0]} and cancelled_at is null`)[0].attended
      await expect.poll(attended).toBe('yes')
      await expect(card.getByText('Явка на собеседование').first()).toBeVisible()
      await page.locator('[data-hr-toasts]').getByRole('button', { name: 'Отменить' }).first().click()
      await expect.poll(attended).toBe('')
      await page.keyboard.press('Escape')
    })
    await attendance.step('график: «Неявка» — отказ «Неявка на собеседование» без сообщения', async () => {
      await page.getByRole('button', { name: 'График' }).first().click()
      const group = page.getByRole('group', { name: new RegExp(`Итог собеседования: Явка${tag} 2`) })
      await group.getByRole('button', { name: 'Неявка' }).click()
      await expect.poll(() => status(ids[1])).toBe('declined')
      const [row] = await sql<{ decline_reason: string; attended: string }[]>`
        select a.decline_reason, i.attended from applications a join interviews i on i.application_id = a.id and i.cancelled_at is null where a.id = ${ids[1]}`
      expect(row).toEqual({ decline_reason: 'no_show', attended: 'no' })
      const jobs = await sql`select 1 from jobs where kind = 'notify' and payload->>'applicationId' = ${ids[1]}`
      expect(jobs.length, 'сообщение кандидату не ставилось').toBe(0)
      await expect(page.getByRole('button', { name: new RegExp(`Явка${tag} 2`) }).getByText('неявка')).toBeVisible()
    })
    await attendance.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Фокус ───────────────────────────────────────────────────────────
  const focus = new h.Scenario('hr-desk: фокус в карточке и в окне «+ Кандидат»')
  {
    const { context, page, problems } = await h.open(focus, h.DESKTOP)
    /** Где фокус: в окне (или во всплывающих сообщениях) */
    const inside = (selector: string) => page.evaluate((s) => Boolean(document.activeElement?.closest(s)), selector)
    const cycle = async (selector: string, key: string) => {
      for (let i = 0; i < 100; i++) {
        await page.keyboard.press(key)
        if (!(await inside(selector))) throw new Error(`${key} № ${i + 1} вывел фокус из окна: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`)
      }
    }
    let id = ''
    await focus.step('карточка с клавиатуры: 100 Tab и 100 Shift+Tab не выходят наружу', async () => {
      ;[id] = await seed('Фокус', 1)
      await seed('Безтел', 1, () => ({ phone: '', contact: '@kvas_test' }))
      await h.loginHr(page)
      await search(page, `Фокус${tag}`)
      const opener = page.getByRole('button', { name: new RegExp(`Фокус${tag} 1`) }).filter({ visible: true }).first()
      await opener.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog', { name: /^Заявка/ }).getByRole('heading', { name: 'История' }).waitFor()
      await cycle('#hr-card, [data-hr-toasts]', 'Tab')
      await cycle('#hr-card, [data-hr-toasts]', 'Shift+Tab')
    })
    await focus.step('«Отменить» во всплывающем сообщении доступно с клавиатуры', async () => {
      const card = page.getByRole('dialog', { name: /^Заявка/ })
      await card.getByRole('button', { name: 'Дозвонились', exact: true }).click()
      await expect.poll(() => status(id)).toBe('contacted')
      let reached = false
      for (let i = 0; i < 100 && !reached; i++) {
        await page.keyboard.press('Tab')
        reached = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-hr-toasts]')) && document.activeElement?.textContent === 'Отменить')
      }
      expect(reached, 'Tab дошёл до «Отменить»').toBe(true)
      await page.keyboard.press('Enter')
      await expect.poll(() => status(id)).toBe('new')
    })
    await focus.step('Esc закрывает карточку, фокус — на кнопке, которая её открыла', async () => {
      await page.locator('#hr-card').focus()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: /^Заявка/ })).toHaveCount(0)
      expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toContain(`Фокус${tag} 1`)
    })
    await focus.step('строки больше нет в отборе — после Esc фокус на заголовке «Заявки»', async () => {
      await page.goto(`/hr?status=new&q=${encodeURIComponent(`Фокус${tag}`)}`)
      const opener = page.getByRole('button', { name: new RegExp(`Фокус${tag} 1`) }).filter({ visible: true }).first()
      await opener.focus()
      await page.keyboard.press('Enter')
      const card = page.getByRole('dialog', { name: /^Заявка/ })
      await card.getByRole('button', { name: 'Дозвонились', exact: true }).click()
      await expect.poll(() => status(id)).toBe('contacted')
      await expect(page.locator('tbody tr', { hasText: `Фокус${tag} 1` })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(card).toHaveCount(0)
      expect(await page.evaluate(() => (document.activeElement?.tagName ?? '') + ' ' + (document.activeElement?.textContent ?? '').trim())).toBe('H1 Заявки')
      await sql`update applications set status = 'new' where id = ${id}`
    })
    await focus.step('у кнопок и полей есть названия: список и карточка', async () => {
      await page.goto(`/hr?q=${encodeURIComponent(`Безтел${tag}`)}`)
      await expect(page.locator('tbody tr', { hasText: `Безтел${tag} 1` })).toHaveCount(1)
      // Имена — из дерева доступности через CDP, он есть только в Chromium; разметка от движка не зависит
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'без названия на /hr')
      await page.getByRole('button', { name: new RegExp(`Безтел${tag} 1`) }).filter({ visible: true }).first().click()
      await page.getByRole('dialog', { name: /^Заявка/ }).getByRole('heading', { name: 'История' }).waitFor()
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'без названия в карточке')
      await expect(page.getByRole('dialog', { name: /^Заявка/ }).locator('a[href^="tel:"]'), 'в карточке без телефона нет пустой ссылки').toHaveCount(0)
      await page.keyboard.press('Escape')
    })
    await focus.step('ссылка tel: только при телефоне', async () => {
      await search(page, `Безтел${tag}`)
      const row = page.locator('tr', { hasText: `Безтел${tag} 1` })
      await expect(row).toHaveCount(1)
      await expect(row.locator('a[href^="tel:"]')).toHaveCount(0)
      await expect(row.getByText('@kvas_test')).toBeVisible()
    })
    await focus.step('«+ Кандидат»: фокус по кругу, Esc возвращает на кнопку', async () => {
      const add = page.getByRole('button', { name: '+ Кандидат' })
      await add.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog', { name: 'Новый кандидат' }).waitFor()
      await cycle('[role="dialog"][aria-label="Новый кандидат"]', 'Tab')
      await cycle('[role="dialog"][aria-label="Новый кандидат"]', 'Shift+Tab')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Новый кандидат' })).toHaveCount(0)
      expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toBe('+ Кандидат')
    })
    await focus.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Список порциями, раздача, задания ──────────────────────────────
  const list = new h.Scenario('hr-desk: 130 заявок порциями, «выбрать все найденные», поровну, «Задания»')
  {
    const { context, page, problems } = await h.open(list, h.DESKTOP)
    const staffIds: number[] = []
    await list.step('вкладки второй волны на месте: «Источники» на виду, остальные — в «Ещё»', async () => {
      await seed('Порция', 130, (i) => ({ activities: i % 5 }))
      for (const name of ['Анна', 'Борис']) {
        const [u] = await sql<{ id: string }[]>`
          insert into hr_users (email, name, role, password_hash) values (${`${name}-${tag}@desk.test`.toLowerCase()}, ${`${name} ${tag}`}, 'hr', 'нет-входа') returning id`
        staffIds.push(Number(u.id))
      }
      await h.loginHr(page)
      const nav = page.getByRole('navigation', { name: 'Разделы панели' }).first()
      for (const tab of ['Заявки', 'График', 'Воронка', 'Источники', 'Ещё']) await expect(nav.getByRole('button', { name: tab, exact: true })).toBeVisible()
      // Второстепенные разделы — в меню «Ещё»; «Рассылка» и «Настройки» — администратору
      await nav.getByRole('button', { name: 'Ещё', exact: true }).click()
      for (const tab of ['Фокус-группа', 'Боты', 'Рассылка', 'Настройки']) await expect(nav.getByRole('button', { name: tab, exact: true })).toBeVisible()
      await nav.getByRole('button', { name: 'Боты', exact: true }).click()
      await expect(page).toHaveURL(/tab=bots/)
      await expect(nav.getByRole('button', { name: 'Ещё: Боты' })).toHaveAttribute('aria-expanded', 'false')
      await nav.getByRole('button', { name: 'Заявки', exact: true }).click()
      // Список открывается видом «В работе»
      await expect(page.getByRole('group', { name: 'Виды списка' }).getByRole('button', { name: /^В работе · \d+$/ })).toHaveAttribute('aria-pressed', 'true')
    })
    const rows = page.locator('tbody tr')
    await list.step('первые 100 строк, «Показать ещё 30», счётчик по всему отбору', async () => {
      await search(page, `Порция${tag}`)
      await expect(page.getByText('Найдено: 130 из', { exact: false })).toBeVisible()
      await expect(rows).toHaveCount(100)
      await page.getByRole('button', { name: 'Показать ещё 30' }).click()
      await expect(rows).toHaveCount(130)
    })
    await list.step('«выбрать все найденные» и «поровну между…» — 44, 43, 43', async () => {
      await page.reload()
      await expect(rows).toHaveCount(100)
      await page.getByRole('checkbox', { name: 'Выбрать все найденные: 130' }).check()
      await expect(page.getByText('Выбрано: 130')).toBeVisible()
      await page.getByRole('combobox', { name: 'Назначить ответственного' }).selectOption('even')
      const dialog = page.getByRole('dialog', { name: 'Поровну · 130' })
      await dialog.getByRole('button', { name: /^Раздать 130 между/ }).click()
      await expect(dialog).toHaveCount(0)
      const counts = await sql<{ n: number }[]>`
        select count(*)::int as n from applications where name like ${`Порция${tag}%`} group by assignee_id order by n desc`
      const staffCount = (await sql<{ n: number }[]>`select count(*)::int as n from hr_users where not disabled`)[0].n
      const per = Math.floor(130 / staffCount)
      expect(counts.length).toBe(staffCount)
      expect(counts.every((c) => c.n === per || c.n === per + 1), `раздача: ${counts.map((c) => c.n).join('/')}`).toBe(true)
    })
    await list.step('«Задания: 4 из 4» в адресе, чипом под фильтрами и в «Ещё фильтры»; метка «Задания 4/4» у имени', async () => {
      await page.goto(`/hr?q=${encodeURIComponent(`Порция${tag}`)}&tasks=all`)
      await expect(page.getByText('Найдено: 26 из', { exact: false })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Убрать фильтр: Задания на сайте: 4 из 4' })).toBeVisible()
      await page.getByRole('button', { name: /^Ещё фильтры · 1/ }).click()
      await expect(page.getByRole('combobox', { name: 'Задания на сайте' })).toHaveValue('all')
      await page.keyboard.press('Escape')
      await page.reload()
      await expect(page.getByText('Найдено: 26 из', { exact: false }), 'фильтр пережил перезагрузку').toBeVisible()
      await expect(rows.first().getByText('Задания 4/4')).toBeVisible()
      // Крестик у чипа снимает фильтр
      await page.getByRole('button', { name: 'Убрать фильтр: Задания на сайте: 4 из 4' }).click()
      await expect(page.getByText('Найдено: 130 из', { exact: false })).toBeVisible()
    })
    await list.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  // ── Телефон ─────────────────────────────────────────────────────────
  const mobile = new h.Scenario('hr-desk: телефон 390 — список и обзвон без горизонтальной прокрутки')
  {
    const { context, page, problems } = await h.open(mobile, h.MOBILE)
    await mobile.step('список и полоса обзвона внизу карточки', async () => {
      await h.loginHr(page)
      await search(page, `Порция${tag}`)
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка: ${o.out.join(', ')}`).toBe(0)
      // Первая карточка — на первом экране: импорт и выгрузка спрятаны в «Ещё»
      const first = page.locator('li', { has: page.getByRole('checkbox', { name: /^Выбрать / }) }).first()
      expect((await first.boundingBox())!.y, 'первая карточка ниже половины экрана').toBeLessThan(844 / 2)
      // «Выбрать все» — только после первой отметки
      await expect(page.getByRole('button', { name: /^Выбрать все найденные/ })).toHaveCount(0)
      await first.getByRole('checkbox').check()
      await expect(page.getByRole('button', { name: /^Выбрать все найденные/ })).toBeVisible()
      await first.getByRole('checkbox').uncheck()
      // Фильтры — листом во весь экран, внизу «Показать N»
      await page.getByRole('button', { name: /^Фильтры/ }).click()
      const sheet = page.getByRole('dialog', { name: 'Фильтры' })
      await expect(sheet.getByRole('combobox', { name: 'Порядок списка' })).toBeVisible()
      await sheet.getByRole('button', { name: /^Показать \d+$/ }).click()
      await expect(sheet).toHaveCount(0)
      await page.getByRole('button', { name: /^Обзвон · \d+$/ }).click()
      const bar = page.getByRole('dialog', { name: /^Заявка/ }).getByRole('region', { name: 'Обзвон' })
      await expect(bar.getByRole('button', { name: /^Дозвонились/ })).toBeInViewport()
      await expect(bar.getByRole('link', { name: /\+7/ })).toBeVisible()
      await bar.getByRole('button', { name: 'Закончить обзвон' }).click()
      await page.getByRole('dialog', { name: 'Обзвон закончен' }).getByRole('button', { name: 'Готово' }).click()
    })
    await mobile.step('без ошибок и ответов 4xx/5xx', async () => h.none(problems, 'ошибки консоли и ответы 4xx/5xx'))
    await context.close()
  }

  await cleanup()
  return [call, series, attendance, focus, list, mobile]
}
