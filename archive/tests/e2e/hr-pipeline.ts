// HR-панель, пакет hr-pipeline, в браузере: поля кейса в списке и карточке (возраст, когда может выйти, учёба),
// дата рождения с опечаткой — ошибка у поля, фильтр «Выход», оформление (первая смена, наставник, документы по практике),
// «+ Кандидат» с основанием «согласия нет» и подтверждение перед приглашением, практика от вуза в фильтре, раскладка на телефоне.
// Свои заявки сценарий создаёт прямо в базе прогона с меткой в имени и в конце удаляет.
// Только он: E2E_ONLY=hr-pipeline pnpm test:e2e

import { randomBytes } from 'node:crypto'
import type { Page } from 'playwright'
import { formatBirthDate, mskToday } from '../../shared/birthDate'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const { expect, sql } = h
  const tag = `Пайп${randomBytes(3).toString('hex')}`
  let seq = 0

  /** Дата рождения, по которой сегодня исполнилось years лет и ещё 40 дней */
  const born = (years: number) => {
    const [y, m, d] = mskToday().split('-').map(Number)
    return new Date(Date.UTC(y - years, m - 1, d) - 40 * 864e5).toISOString().slice(0, 10)
  }
  type Seed = { name: string; status?: string; birth?: string; start?: string; startMonth?: number; school?: string; practice?: boolean; vacancy?: string }
  /** Заявка прямо в базе: имя «<имя><метка>», согласие с сайта */
  const seed = async (e: Seed) => {
    const id = `P${randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 9)
    await sql`
      insert into applications (id, created_at, name, last_name, phone, channel, source, vacancy_id, game, months, status, consent_at, consent_version, consent_source,
                                birth_date, start_ready, start_month, school, practice_school)
      values (${id}, now() - make_interval(secs => ${++seq}), ${`${e.name}${tag}`}, 'Проверочная', ${`+7906${String(1_000_000 + seq + Math.floor(Math.random() * 8_000_000)).padStart(7, '0')}`},
              'web', 'vk', ${e.vacancy ?? 'lab-chemist'}, ${sql.json({ quizResult: null, conveyorBest: 0, activities: 0 })}, ${sql.json([6, 7])}, ${e.status ?? 'new'},
              now(), '1', 'site_form', ${e.birth ?? null}, ${e.start ?? ''}, ${e.startMonth ?? null}, ${e.school ?? ''}, ${e.practice ?? false})`
    await sql`insert into application_history (application_id, user_name, kind, from_status, to_status) values (${id}, 'Система', 'status', null, ${e.status ?? 'new'})`
    return id
  }
  const cleanup = async () => {
    await sql`delete from jobs where payload ->> 'applicationId' in (select id from applications where name like ${`%${tag}%`})`
    await sql`delete from applications where name like ${`%${tag}%`}`
  }
  const search = async (page: Page, text: string) => {
    await page.getByRole('searchbox', { name: 'Поиск' }).fill(text)
    await page.waitForURL((u) => u.searchParams.get('q') === text)
  }
  const openCard = async (page: Page, id: string) => {
    await page.goto(`${h.baseUrl}/hr?card=${id}`)
    const card = page.getByRole('dialog', { name: /^Заявка/ })
    await expect(card.getByRole('heading', { level: 2 })).toBeVisible()
    return card
  }

  // ── Поля кейса и оформление ─────────────────────────────────────────
  const fields = new h.Scenario('hr-pipeline: возраст, выход и учёба в списке и карточке; оформление')
  {
    const { context, page, problems } = await h.open(fields, h.DESKTOP)
    let anna = ''
    let gleb = ''
    await fields.step('в списке под именем — учёба, возраст и когда может выйти', async () => {
      anna = await seed({ name: 'Анна', birth: born(20), start: 'month', startMonth: 6, school: 'МГУПП', practice: true })
      await seed({ name: 'Борис', birth: born(22), start: 'now', school: 'НИТУ МИСИС', vacancy: 'bottling-operator' })
      gleb = await seed({ name: 'Глеб', birth: born(21), start: 'two_weeks', school: 'РХТУ им. Менделеева', status: 'hired', practice: true })
      await h.loginHr(page)
      await search(page, tag)
      const row = page.getByRole('row').filter({ hasText: `Анна${tag}` })
      await expect(row.getByText('20 лет')).toBeVisible()
      await expect(row.getByText('выход: с июня')).toBeVisible()
      await expect(row.getByText('МГУПП')).toBeVisible()
      await expect(row.getByText('практика от вуза')).toBeVisible()
    })
    await fields.step('фильтр «Выход: сразу» — в «Ещё фильтры», в адресе, чипом и в списке', async () => {
      await page.getByRole('button', { name: /^Ещё фильтры/ }).click()
      await page.getByRole('combobox', { name: 'Когда может выйти' }).selectOption('now')
      await page.waitForURL((u) => u.searchParams.get('start') === 'now')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Убрать фильтр: Выход: сразу' })).toBeVisible()
      await expect(page.getByText('Найдено: 1 из', { exact: false })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: `Борис${tag}` })).toHaveCount(1)
    })
    await fields.step('карточка: дата с опечаткой — ошибка у поля, дата не стёрта; верная — новый возраст', async () => {
      const card = await openCard(page, anna)
      await expect(card.getByText(`20 лет, ${formatBirthDate(born(20))}`)).toBeVisible()
      // Анкета свёрнута, в заголовке — чего не хватает; раскрываем, чтобы поправить дату
      const profile = card.locator('summary', { hasText: 'Анкета' })
      await expect(profile).toContainText('не хватает')
      await profile.click()
      const input = card.getByLabel('Дата рождения')
      await input.fill(`31.02.${Number(mskToday().slice(0, 4)) - 20}`)
      await input.press('Enter')
      await expect(card.getByRole('alert').filter({ hasText: 'Такой даты нет в календаре' })).toBeVisible()
      expect((await sql<{ d: string }[]>`select birth_date::text as d from applications where id = ${anna}`)[0].d).toBe(born(20))
      await input.fill(formatBirthDate(born(24)))
      await input.press('Enter')
      await expect(card.getByText(`24 года, ${formatBirthDate(born(24))}`)).toBeVisible()
    })
    await fields.step('«К оформлению»: первая смена, наставник, документы по практике — с историей', async () => {
      const card = await openCard(page, gleb)
      const day = mskToday().split('-').map(Number)
      const next = new Date(Date.UTC(day[0], day[1] - 1, day[2]) + 9 * 864e5).toISOString().slice(0, 10)
      await card.getByLabel('День').fill(next)
      await card.getByRole('radio', { name: 'Ночная' }).click()
      await card.getByRole('button', { name: 'Назначить первую смену' }).click()
      await expect(card.getByText(/^Первая смена: .+, с 20:00, ночная смена$/)).toBeVisible()
      const mentor = card.getByLabel('Наставник')
      await mentor.fill('Ольга Петрова')
      await mentor.blur()
      await expect(card.getByText('Наставник: Ольга Петрова')).toBeVisible()
      await card.getByLabel(/^Договор с вузом или колледжем/).check()
      await expect(card.getByText('Документы по практике: 1 из 4')).toBeVisible()
      const [row] = await sql<{ shift_kind: string; mentor_name: string; practice_docs: string[] }[]>`select shift_kind, mentor_name, practice_docs from applications where id = ${gleb}`
      expect(row).toEqual({ shift_kind: 'night', mentor_name: 'Ольга Петрова', practice_docs: ['contract'] })
    })
    await fields.step('без ошибок консоли и сети', async () => {
      expect(problems.filter((p) => !p.includes('422'))).toEqual([])
    })
    await context.close()
  }

  // ── «+ Кандидат» без согласия ───────────────────────────────────────
  const consent = new h.Scenario('hr-pipeline: «+ Кандидат» по рекомендации и приглашение с подтверждением')
  {
    const { context, page } = await h.open(consent, h.DESKTOP)
    await consent.step('основание обязательно; добавлен с датой рождения и учёбой, без согласия', async () => {
      await h.loginHr(page)
      await page.getByRole('button', { name: '+ Кандидат' }).click()
      const form = page.getByRole('dialog', { name: 'Новый кандидат' })
      await form.getByLabel('Имя', { exact: true }).fill(`Тимур${tag}`)
      await form.getByLabel('Фамилия', { exact: true }).fill('Ахмедов')
      await form.getByLabel('Телефон').fill(`+7 907 ${String(100 + Math.floor(Math.random() * 800))}-12-34`)
      await form.getByLabel('Дата рождения').fill(formatBirthDate(born(19)).replace(/\./g, ''))
      await expect(form.getByText('19 лет')).toBeVisible()
      await form.getByLabel('Вуз или колледж').fill('Колледж № 32')
      await form.getByRole('button', { name: 'Добавить' }).click()
      await expect(form.getByText('Выбери основание', { exact: false })).toBeVisible()
      await form.getByRole('radio', { name: /Согласия нет: рекомендация/ }).check()
      await form.getByRole('button', { name: 'Добавить' }).click()
      const card = page.getByRole('dialog', { name: /^Заявка/ })
      await expect(card.getByText('Согласия на обработку данных нет', { exact: false })).toBeVisible()
      const [row] = await sql<{ consent_source: string; birth_date: string; school: string }[]>`
        select consent_source, birth_date::text as birth_date, school from applications where name = ${`Тимур${tag}`}`
      expect(row).toEqual({ consent_source: 'none', birth_date: born(19), school: 'Колледж № 32' })
    })
    await consent.step('«Пригласить» доступно только после подтверждения', async () => {
      const card = page.getByRole('dialog', { name: /^Заявка/ })
      await card.getByRole('button', { name: 'Пригласить на собеседование' }).click()
      const invite = card.getByRole('button', { name: 'Пригласить', exact: true })
      await expect(invite).toBeDisabled()
      await card.getByText('Согласия нет. Пригласить всё равно', { exact: false }).click()
      await expect(invite).toBeEnabled()
    })
    await context.close()
  }

  // ── Телефон ─────────────────────────────────────────────────────────
  const mobile = new h.Scenario('hr-pipeline: карточка на телефоне без горизонтальной прокрутки')
  {
    const { context, page } = await h.open(mobile, h.MOBILE)
    await mobile.step('карточка «К оформлению» на 390 px', async () => {
      const id = await seed({ name: 'Вера', birth: born(23), start: 'now', status: 'hired', practice: true })
      await h.loginHr(page)
      const card = await openCard(page, id)
      await expect(card.getByRole('heading', { name: 'Оформление' })).toBeVisible()
      const o = await h.overflow(page)
      h.none(o.out, 'вылезает за экран')
      expect(o.scrolled).toBe(0)
    })
    await context.close()
  }

  await cleanup()
  return [fields, consent, mobile]
}
