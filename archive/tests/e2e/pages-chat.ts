// Заявка, страницы и чат глазами кандидата: поля кейса (ФИО, дата рождения с 18 лет, учёба, когда можно выйти),
// отметка согласия, /consent без входа, политика, подвал, приглашение друга, ответы сервера в форме, ловушка,
// практика и счёт игры, страница вакансий с практикой и роликами, чат с подсказкой поля, таймаутом и заявкой из чата.
// Только он: E2E_ONLY=pages-chat pnpm test:e2e

import { randomBytes } from 'node:crypto'
import type { Page, Request } from 'playwright'
import { CONSENT_VERSION } from '../../shared/applications'
import { deadlineWords, RESPONSE_WORDS, responseDeadline } from '../../shared/candidateStatus'
import { contacts } from '../../shared/content/content'
import { asksPortfolio, estimateNote, freePractice, paidPractice, vacancies } from '../../shared/content/vacancies'
import type { E2eHarness } from './_harness'

/** Неразрывные пробелы и невидимые символы типографа — в обычные пробелы */
const plain = (t: string) =>
  t
    .replace(/[  ]/g, ' ')
    .replace(/⁠/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Свой телефон каждой заявке: лимиты по номеру не мешают соседним шагам и прогонам */
const phone = () => `+7 9${Array.from(randomBytes(9), (b) => String(b % 10)).join('')}`
/** Имя только из букв — по нему находим заявку в базе */
const uniqueName = (base: string) => `${base} ${Array.from(randomBytes(4), (b) => 'абвгдежзиклмнопрстуф'[b % 20]).join('')}`

/** Состояние «профиля» браузера до загрузки страницы: рекорд игры, метка источника */
const profileInit = (state: Record<string, unknown>) =>
  `localStorage.setItem('ochakovo.profile', JSON.stringify({ state: ${JSON.stringify({ name: '', source: null, muted: true, attachScore: true, conveyorBest: 0, ...state })}, version: 1 }))`

/** Отметить чекбокс как человек — нажатием на подпись: само поле визуально скрыто */
async function tick(page: Page, id: string, on = true) {
  const box = page.locator(`#${id}`)
  if ((await box.isChecked()) === on) return
  await page.locator(`label[for="${id}"]`).click({ position: { x: 12, y: 12 } })
}

/** Дата рождения ДД.ММ.ГГГГ: столько-то лет назад от текущего момента, со сдвигом в днях */
function bornAgo(years: number, days = 0) {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  d.setDate(d.getDate() + days)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

/** Поля кейса как человек: фамилия, имя, дата рождения цифрами (точки ставит маска), телефон, вуз, «Сразу» */
async function fillContacts(page: Page, name: string, tel: string, birth = bornAgo(20)) {
  await page.getByRole('textbox', { name: 'Фамилия', exact: true }).fill('Проверкина')
  await page.getByRole('textbox', { name: 'Имя', exact: true }).fill(name)
  await page.getByRole('textbox', { name: 'Дата рождения', exact: true }).pressSequentially(birth.replace(/\D/g, ''))
  await page.getByRole('textbox', { name: /^Телефон или Telegram/ }).fill(tel)
  await page.getByRole('textbox', { name: 'Вуз или колледж', exact: true }).fill('МГУПП')
  await page.locator('label:has(input[name="apply-start-ready"][value="now"])').click()
}

export default async (h: E2eHarness) => {
  const { expect } = h

  // ── Согласие и поля формы ─────────────────────────────────────────────
  const consent = new h.Scenario('pages-chat: заявка — поля кейса, согласие, практика, счёт игры, повтор номера')
  await (async () => {
    const { page } = await h.open(consent, h.DESKTOP)
    // Рекорд в игре есть — в блоке «Смена» появляется «Показать результат игры»
    await page.addInitScript(profileInit({ conveyorBest: 17 }))
    const posts: Request[] = []
    page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/applications' && posts.push(r))
    const name = uniqueName('Согласна')
    const tel = phone()

    await consent.step('пустая форма: фокус на фамилии, ошибки у полей кейса; без согласия заявка не уходит', async () => {
      await page.goto('/apply', { waitUntil: 'networkidle' })
      const send = page.getByRole('button', { name: 'Отправить заявку' })
      await send.click()
      await expect(page.locator('#apply-last-name')).toBeFocused()
      await expect(page.locator('#apply-last-name-error')).toHaveText('Укажи фамилию')
      await expect(page.locator('#apply-birth-date-error')).toContainText('дату рождения')
      await expect(page.locator('#apply-school-error')).toContainText('«Уже не учусь»')
      await expect(page.locator('#apply-start-ready-error')).toContainText('когда сможешь выйти')
      await fillContacts(page, name, tel)
      // Маска сама расставила точки
      await expect(page.locator('#apply-birth-date')).toHaveValue(bornAgo(20))
      await expect(page.locator('#apply-birth-date')).toHaveAttribute('inputmode', 'numeric')
      await send.click()
      await expect(page.locator('#apply-consent-error')).toContainText('Без согласия')
      await expect(page.locator('#apply-consent')).toBeFocused()
      expect(posts.length, 'запрос ушёл без обязательной отметки').toBe(0)
      // Возраст — по дате рождения: отдельной отметки «Мне есть 18 лет» нет
      await expect(page.locator('#apply-adult')).toHaveCount(0)
      await expect(page.getByRole('checkbox', { name: /^Даю согласие на обработку персональных данных/ })).toHaveCount(1)
      await expect(page.locator('label[for="apply-consent"] a[href="/consent"]')).toHaveCount(1)
      // Политика — отдельной ссылкой, вне отметки согласия
      await expect(page.locator('label[for="apply-consent"] a[href="/privacy"]')).toHaveCount(0)
      await expect(page.locator('form a[href="/privacy"]')).toHaveCount(1)
    })

    await consent.step('согласие → заявка: поля кейса в базе, согласие с версией, код приглашения, практика, «остаться», счёт выключен', async () => {
      await tick(page, 'apply-consent')
      // Практика от вуза — рядом с учёбой, «остаться после сезона» — в свёрнутом «Необязательно»
      await tick(page, 'apply-practice')
      await expect(page.locator('#apply-stay')).toHaveCount(0)
      await page.getByRole('button', { name: /^Необязательно/ }).click()
      await tick(page, 'apply-stay')
      // Переключатель счёта в блоке «Смена» — выключаем: рекорд не должен уйти в заявку
      await expect(page.getByRole('checkbox', { name: /^Показать результат игры/ })).toBeChecked()
      await tick(page, 'apply-attach-score', false)
      await page.getByRole('button', { name: 'Отправить заявку' }).click()
      await expect(page.getByRole('heading', { level: 1, name: /Заявка\s*отправлена/ })).toBeVisible()
      const myCode = await page.evaluate(() => localStorage.getItem('ochakovo.ref'))
      expect(myCode, 'у браузера нет кода приглашения').toMatch(/^[a-z2-9]{6}$/)
      const [row] = await h.sql<
        { consent_at: Date | null; consent_version: string; consent_source: string; ref_code: string | null; practice_school: boolean; wants_to_stay: boolean; game: { conveyorBest: number }; adult: boolean | null; suspected_spam: boolean; last_name: string; birth_date: Date | string | null; school: string; start_ready: string }[]
      >`select consent_at, consent_version, consent_source, ref_code, practice_school, wants_to_stay, game, adult, suspected_spam, last_name, birth_date, school, start_ready from applications where name = ${name}`
      expect(row, 'заявки нет в базе').toBeTruthy()
      expect(row.consent_at).toBeTruthy()
      expect(row.consent_version).toBe(CONSENT_VERSION)
      expect(row.consent_source).toBe('site_form')
      expect(row.ref_code, 'код приглашения не закрепился за заявкой').toBe(myCode)
      expect(row.practice_school).toBe(true)
      expect(row.wants_to_stay).toBe(true)
      expect(row.adult, 'возраст не вывелся из даты рождения').toBe(true)
      expect(row.last_name).toBe('Проверкина')
      expect(row.birth_date, 'дата рождения не сохранилась').toBeTruthy()
      expect(row.school).toBe('МГУПП')
      expect(row.start_ready).toBe('now')
      expect(row.game.conveyorBest, 'счёт ушёл, хотя «Показать результат игры» выключен').toBe(0)
      expect(row.suspected_spam, 'человек попал в ловушку').toBe(false)
      // Срок ответа на экране успеха — конкретным днём по календарю отдела, без «двух рабочих дней с момента заявки»
      await expect(page.locator('main')).toContainText(`HR позвонит ${deadlineWords(responseDeadline(new Date()))}.`)
    })

    await consent.step('тот же номер сразу ещё раз — «Заявка с этого номера уже принята», номер не раскрыт', async () => {
      await page.getByRole('button', { name: 'Отправить ещё одну заявку' }).click()
      await fillContacts(page, name, tel)
      await tick(page, 'apply-consent')
      const reply = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/applications' && r.request().method() === 'POST')
      await page.getByRole('button', { name: 'Отправить заявку' }).click()
      const res = await reply
      expect(res.status()).toBe(409)
      expect(Object.keys((await res.json()) as object)).toEqual(['error'])
      await expect(page.getByRole('alert')).toContainText('Заявка с этого номера уже принята, с тобой свяжутся.')
    })
  })()

  // ── Ответы сервера, ловушка, срок ────────────────────────────────────
  const server = new h.Scenario('pages-chat: 429, ловушка и срок ответа у кнопки', true)
  await server.step('429 — «С этой сети сейчас много заявок. Подожди N секунд или напиши в WhatsApp»', async () => {
    const { context, page } = await h.open(server, h.MOBILE)
    await page.route('**/api/applications', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '42' }, body: JSON.stringify({ error: 'rate_limited', retryAfter: 42 }) })
        : route.continue(),
    )
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await fillContacts(page, uniqueName('Ярмарка'), phone())
    await tick(page, 'apply-consent')
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    const alert = page.getByRole('alert')
    await expect.poll(async () => plain(await alert.innerText())).toBe('С этой сети сейчас много заявок. Подожди 42 секунды или напиши в WhatsApp.')
    await expect(alert.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', `https://wa.me/${contacts.whatsapp}`)
    // Данные остались, кнопка — та же «Отправить заявку»
    await expect(page.getByRole('textbox', { name: 'Имя', exact: true })).not.toHaveValue('')
    await context.close()
  })
  await server.step('ловушка не видна и недоступна с клавиатуры, срок ответа — один раз, у кнопки', async () => {
    const { context, page } = await h.open(server, h.DESKTOP)
    await page.goto('/apply', { waitUntil: 'networkidle' })
    const trap = page.locator('#apply-website')
    await expect(trap).toHaveCount(1)
    await expect(trap).toHaveAttribute('tabindex', '-1')
    const box = await trap.boundingBox()
    expect(box === null || box.x + box.width < 0, 'поле-ловушку видно на экране').toBe(true)
    expect(await trap.evaluate((el) => Boolean(el.closest('[aria-hidden="true"]'))), 'ловушку читает скринридер').toBe(true)
    // После согласия Tab ведёт на кнопку отправки, минуя ловушку
    await page.locator('#apply-consent').focus()
    await page.keyboard.press(h.TAB)
    const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent || '')
    expect(focused).not.toBe('apply-website')
    const text = plain(await page.locator('main').innerText())
    expect(text.split(`в течение ${RESPONSE_WORDS}`).length - 1, 'срок ответа на форме повторяется').toBe(1)
    const button = page.getByRole('button', { name: 'Отправить заявку' })
    const promise = page.getByText(`HR позвонит в течение ${RESPONSE_WORDS}.`)
    const [b, p] = [await button.boundingBox(), await promise.boundingBox()]
    expect(b && p && p.y > b.y && p.y - (b.y + b.height) < 80, 'срок ответа не у кнопки').toBe(true)
    await context.close()
  })

  // ── Приглашение друга ────────────────────────────────────────────────
  const invite = new h.Scenario('pages-chat: приглашение друга')
  await (async () => {
    const { page } = await h.open(invite, h.MOBILE)
    await page.addInitScript({
      content: `Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        navigator.clipboard.writeText = async (t) => { window.__copied = t };`,
    })
    const name = uniqueName('Друг')
    const inviter = 'kvas29'
    await invite.step('по чужой ссылке: строка под шапкой, «Иду с другом» отмечено «по приглашению», поля контакта друга нет', async () => {
      await page.goto(`/?src=ref_${inviter}`, { waitUntil: 'networkidle' })
      // На телефоне строка короткая — без «на практику», чтобы влезть в одну строку
      await expect(page.locator('header')).toContainText('Тебя позвали')
      expect(plain(await page.locator('header').innerText())).toContain('Тебя позвали в «Очаково».')
      await page.goto('/apply', { waitUntil: 'networkidle' })
      await expect(page.getByRole('checkbox', { name: /^Иду с другом/ })).toBeChecked()
      await expect(page.locator('label[for="apply-friend-toggle"]')).toContainText('по приглашению')
      await expect(page.getByRole('textbox', { name: 'Имя друга', exact: true })).toBeVisible()
      // Контакт друга не спрашиваем: поле про телефон или ник на форме одно — своё
      await expect(page.getByRole('textbox', { name: /телефон|ник/i })).toHaveCount(1)
      await expect(page.getByRole('textbox', { name: /друг/i })).toHaveCount(1)
      // Шапка не закрывает начало страницы
      const line = await page.locator('header').boundingBox()
      const kicker = await page.getByText(/^Сезон \d{4}/).boundingBox()
      expect(line && kicker && kicker.y >= line.y + line.height, 'строка приглашения закрывает подзаголовок').toBe(true)
    })
    await invite.step('код уходит с заявкой: источник friend-<код>, свой код закреплён, на успехе «Позвать друга» со своей ссылкой', async () => {
      await fillContacts(page, name, phone())
      await tick(page, 'apply-consent')
      await page.getByRole('button', { name: 'Отправить заявку' }).click()
      await expect(page.getByRole('heading', { level: 1, name: /Заявка\s*отправлена/ })).toBeVisible()
      const myCode = await page.evaluate(() => localStorage.getItem('ochakovo.ref'))
      const [row] = await h.sql<{ source: string | null; ref_code: string | null; friend: string }[]>`select source, ref_code, friend from applications where name = ${name}`
      expect(row.source).toBe(`friend-${inviter}`)
      expect(row.ref_code).toBe(myCode)
      expect(row.friend, 'отметка «Иду с другом» без имени').toBe('имя не указано')
      await expect(page.locator('header')).not.toContainText('Тебя позвали')
      const call = page.getByRole('button', { name: 'Позвать друга' })
      await expect(call).toBeVisible()
      await call.click()
      await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '')).toContain(`?src=ref_${myCode}`)
      expect(plain(await page.locator('body').innerText())).not.toMatch(/бонус/i)
    })
  })()
  await invite.step('своя ссылка не засчитывается', async () => {
    const { context, page } = await h.open(invite, h.DESKTOP)
    await page.addInitScript({ content: `localStorage.setItem('ochakovo.ref', 'mnpq23')` })
    await page.goto('/?src=ref_mnpq23', { waitUntil: 'networkidle' })
    await expect(page.locator('header')).not.toContainText('Тебя позвали')
    const source = await page.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.profile') ?? '{}').state?.source ?? null)
    expect(source).toBeNull()
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByRole('checkbox', { name: /^Иду с другом/ })).not.toBeChecked()
    await context.close()
  })

  // ── /consent, политика, подвал ───────────────────────────────────────
  const legal = new h.Scenario('pages-chat: /consent, политика и подвал', true)
  await legal.step('/consent открывается без входа: оператор, цели, перечень, действия, срок, отзыв, версия', async () => {
    const { context, page, problems } = await h.open(legal, h.MOBILE)
    await page.goto('/consent', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Согласие на обработку данных')
    // Заголовки разделов набраны капсом через CSS — сравниваем без регистра
    const text = plain(await page.locator('main').innerText()).toLowerCase()
    for (const part of ['АО МПБК «Очаково»', 'ИНН', 'Зачем', 'Какие данные', 'Что с ними делаем', 'Сезон и ещё 12 месяцев', 'Как отозвать', `Версия текста — ${CONSENT_VERSION}`, contacts.email])
      expect(text, `на /consent нет «${part}»`).toContain(part.toLowerCase())
    expect(await page.title()).toContain('Согласие')
    h.none(problems, 'ошибки консоли и ответы 4xx/5xx')
    await context.close()
  })
  await legal.step('политика: все поля формы и анкеты, источники данных, переписка в Telegram и MAX', async () => {
    const { context, page } = await h.open(legal, h.DESKTOP)
    await page.goto('/privacy', { waitUntil: 'networkidle' })
    const text = plain(await page.locator('main').innerText()).toLowerCase()
    for (const part of ['фамилия', 'отчество', 'дата рождения', 'вуз или колледж', 'уже не учусь', 'когда можешь выйти', 'курс', 'направление', 'вакансия', 'формат', 'месяцы', 'комментарий', 'гражданство', 'медкнижка', 'смены', 'портфолио', 'практика от вуза', 'остаться после сезона', 'с 18 лет', 'с другом', 'показать результат игры', 'код приглашения', 'откуда данные', 'hh.ru', 'ярмарк', 'telegram', 'max', 'текст согласия'])
      expect(text, `в политике нет «${part}»`).toContain(part)
    await context.close()
  })
  for (const [label, options] of [['390', h.MOBILE], ['1440', h.DESKTOP]] as const)
    await legal.step(`${label}: подвал — адрес и маршрут по источнику, строка о команде, без «Прототип»`, async () => {
      const { context, page } = await h.open(legal, options)
      await page.goto('/vacancies', { waitUntil: 'networkidle' })
      const footer = plain(await page.locator('footer').innerText())
      expect(footer).toContain(`${contacts.address}. ${contacts.routeShort}.`)
      expect(footer).toContain('Решение команды на кейс «Открой#Моспром» для АО МПБК «Очаково». Неофициальный сайт компании · фото с ochakovo.ru')
      expect(footer).not.toMatch(/Прототип/i)
      const r = await h.overflow(page)
      expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
      await context.close()
    })

  // ── Вакансии и анкета ────────────────────────────────────────────────
  const jobs = new h.Scenario('pages-chat: вакансии и анкета', true)
  await jobs.step('порядок: оплачиваемая практика, бесплатная, работа; сноска общая; «Срочный набор» не рядом с ориентиром', async () => {
    const { context, page } = await h.open(jobs, h.DESKTOP)
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    expect(plain(await page.locator('main').innerText())).toContain(plain(estimateNote))
    const order = await page.locator('main section[id] h2').allInnerTexts()
    expect(order.map((t) => plain(t).toLowerCase())).toEqual(['оплачиваемая практика', 'бесплатная практика по договорённости', 'работа'])
    const rows = await page.locator('li[id^="vacancy-row-"]').evaluateAll((els) => els.map((e) => e.id.replace('vacancy-row-', '')))
    expect(rows.length).toBe(vacancies.length)
    expect(rows.slice(0, paidPractice.length).sort()).toEqual(paidPractice.map((v) => v.id).sort())
    expect(rows.slice(paidPractice.length, paidPractice.length + freePractice.length).sort()).toEqual(freePractice.map((v) => v.id).sort())
    for (const row of await page.locator('li[id^="vacancy-row-"]').allInnerTexts())
      expect(/Срочный набор/i.test(row) && /ориентир/i.test(row), `«Срочный набор» у ориентира: ${plain(row).slice(0, 80)}`).toBe(false)
    // Что даёт компания на оплачиваемой практике — из shared/content/practice.ts
    await expect(page.getByRole('list', { name: 'Что даёт компания' }).locator('li')).toHaveCount(6)
    await expect(page.locator('#free')).toContainText('кабинет')
    const r = await h.overflow(page)
    expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    await context.close()
  })
  await jobs.step('«Посмотреть смену»: ролик не грузится заранее, по нажатию играет; 390 без прокрутки вбок', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    const videos: string[] = []
    page.on('request', (r) => r.url().endsWith('.mp4') && videos.push(r.url()))
    await page.goto('/vacancies?open=bottling-operator', { waitUntil: 'networkidle' })
    const row = page.locator('#vacancy-row-bottling-operator')
    await expect(row.locator('video')).toHaveAttribute('preload', 'none')
    expect(videos, 'ролик загрузился до нажатия').toEqual([])
    await row.getByRole('button', { name: /^Посмотреть смену/ }).click()
    await expect.poll(() => videos.length, { message: 'по нажатию ролик не запросился' }).toBeGreaterThan(0)
    expect(videos[0]).toContain('-480.mp4')
    await expect(row).toContainText('Без слов')
    // Ролик есть и у лаборанта — на телефоне в «Подробнее»; у ролей без ролика кнопки нет и в раскрытой строке
    const lab = page.locator('#vacancy-row-lab-chemist')
    await expect(lab.getByRole('button', { name: /^Посмотреть смену/ })).toHaveCount(0)
    await lab.getByRole('button', { name: 'Подробнее' }).click()
    await expect(lab.getByRole('button', { name: /^Посмотреть смену/ })).toHaveCount(1)
    const store = page.locator('#vacancy-row-storekeeper')
    await store.getByRole('button', { name: 'Подробнее' }).click()
    await expect(store.getByRole('button', { name: 'Свернуть' })).toHaveAttribute('aria-expanded', 'true')
    await expect(store.getByRole('button', { name: /^Посмотреть смену/ })).toHaveCount(0)
    const r = await h.overflow(page)
    expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    await context.close()
  })
  await jobs.step('390: строки короткие, быстрый фильтр «Только дневные» прячет ночные роли, «Сбросить» возвращает все', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    const rows = page.locator('li[id^="vacancy-row-"]')
    // Свёрнутая строка роли — не длиннее экрана: название, сумма, график и «Откликнуться»
    const box = await page.locator('#vacancy-row-bottling-operator').boundingBox()
    expect(box && box.height < 600, `строка роли на телефоне ${box?.height} px`).toBe(true)
    const day = page.getByRole('button', { name: /^Только дневные/ })
    await day.click()
    await expect(day).toHaveAttribute('aria-pressed', 'true')
    const dayOnly = vacancies.filter((v) => v.schedule !== 'По договорённости' && (v.nights === false || /только дневн/i.test(v.schedule))).map((v) => v.id)
    await expect(rows).toHaveCount(dayOnly.length)
    await expect(page.locator('#vacancy-row-bottling-operator')).toHaveCount(0)
    await expect(page.locator('main')).toContainText(`Показано ${dayOnly.length} из ${vacancies.length}`)
    await page.getByRole('button', { name: 'Сбросить' }).click()
    await expect(rows).toHaveCount(vacancies.length)
    const r = await h.overflow(page)
    expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    await context.close()
  })
  await jobs.step('телефон или Telegram: переключатель меняет клавиатуру, ник уходит в заявку как раньше', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    await page.goto('/apply', { waitUntil: 'networkidle' })
    const reach = page.getByRole('textbox', { name: /^Телефон или Telegram/ })
    await expect(reach).toHaveAttribute('inputmode', 'tel')
    await expect(reach).toHaveAttribute('type', 'tel')
    await page.locator('label:has(input[name="apply-reach-mode"][value="telegram"])').click()
    await expect(reach).toHaveAttribute('inputmode', 'text')
    await expect(reach).toBeFocused()
    await reach.fill('kvas_fan')
    await reach.blur()
    await expect(page.locator('#apply-reach-error')).toHaveCount(0)
    await expect(page.locator('main')).toContainText('HR напишет в мессенджер')
    // Обратно на телефон: ник для номера не подходит — поле пустое, клавиатура цифровая
    await page.locator('label:has(input[name="apply-reach-mode"][value="phone"])').click()
    await expect(reach).toHaveValue('')
    await expect(reach).toHaveAttribute('inputmode', 'tel')
    await context.close()
  })
  await jobs.step('бесплатная практика: отклик ставит отметку «Практика от вуза», вакансия подставлена', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    await page.goto('/vacancies#free', { waitUntil: 'networkidle' })
    const v = freePractice[0]
    await page.locator(`#vacancy-row-${v.id}`).getByRole('link', { name: 'Откликнуться' }).click()
    await expect(page).toHaveURL(new RegExp(`/apply\\?vacancy=${v.id}&practice=1`))
    await expect(page.locator('#apply-practice')).toBeChecked()
    await expect(page.locator('#apply-vacancy')).toHaveValue(v.id)
    await context.close()
  })
  await jobs.step('портфолио: у оператора линии розлива нет, у практики в офисе — есть', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    const office = vacancies.find((v) => asksPortfolio(v))!
    for (const [id, has] of [['bottling-operator', false], [office.id, true]] as const) {
      await page.goto(`/apply?vacancy=${id}`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: /^Необязательно/ }).click()
      await expect(page.locator('#apply-portfolio')).toHaveCount(has ? 1 : 0)
    }
    await context.close()
  })
  await jobs.step('моложе 18: «Берём с 18 лет» у даты, заявка не уходит; «Уже не учусь» снимает обязательность вуза', async () => {
    const { context, page } = await h.open(jobs, h.MOBILE)
    const posts: Request[] = []
    page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/applications' && posts.push(r))
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await fillContacts(page, uniqueName('Школьник'), phone(), bornAgo(18, 1))
    await page.locator('#apply-birth-date').focus()
    await page.locator('#apply-reach').focus()
    await expect(page.locator('#apply-birth-date-error')).toContainText('Берём с 18 лет')
    await expect(page.getByRole('link', { name: /^Задания на главной/ })).toBeVisible()
    await page.getByRole('textbox', { name: 'Вуз или колледж', exact: true }).fill('')
    // «Уже не учусь» — вариант переключателя «Учусь / Уже не учусь» над полем вуза
    await page.locator('label:has(#apply-not-studying)').click()
    await expect(page.locator('#apply-not-studying')).toBeChecked()
    await expect(page.locator('#apply-course')).toHaveCount(0)
    await expect(page.locator('#apply-practice')).toHaveCount(0)
    await tick(page, 'apply-consent')
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.locator('#apply-birth-date')).toBeFocused()
    await expect(page.locator('#apply-school-error')).toHaveCount(0)
    expect(posts.length, 'заявка младше 18 ушла на сервер').toBe(0)
    // «С определённого месяца» спрашивает месяц
    await page.locator('label:has(input[name="apply-start-ready"][value="month"])').click()
    await expect(page.locator('#apply-start-month')).toBeVisible()
    await context.close()
  })
  await jobs.step('сервер ответил 422 underage — у даты «Берём с 18 лет»', async () => {
    const { context, page } = await h.open(jobs, h.DESKTOP)
    await page.route('**/api/applications', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'validation', errors: { birthDate: 'x' }, codes: { birthDate: 'underage' } }) })
        : route.continue(),
    )
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await fillContacts(page, uniqueName('Сервер'), phone())
    await tick(page, 'apply-consent')
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.locator('#apply-birth-date-error')).toContainText('Берём с 18 лет')
    await expect(page.getByRole('alert')).toContainText('с 18 лет')
    await context.close()
  })

  // ── «Моя заявка»: дорога, подготовка, первая смена, бот, выбор времени, отзыв согласия ──────────
  /** Заявка через API с полями кейса — для «Моей заявки» нужен её номер и ключ статуса */
  const createApp = async (page: Page, extra: Record<string, unknown> = {}) => {
    const res = await page.request.post('/api/applications', {
      data: { name: uniqueName('Статус'), lastName: 'Проверкина', birthDate: bornAgo(20), phone: phone(), school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, ...extra },
    })
    expect(res.status(), 'заявка не создалась').toBe(201)
    return (await res.json()) as { id: string; statusToken: string; name: string; phone: string; vacancyId: string; practiceSchool?: boolean; format?: string }
  }
  /** Та же заявка в этом браузере — так её видит «Моя заявка» после отправки формы */
  const rememberApp = (app: { id: string; statusToken: string; name: string; phone: string; vacancyId: string }, practice: boolean) =>
    `localStorage.setItem('ochakovo.application', ${JSON.stringify(
      JSON.stringify({ state: { last: { id: app.id, name: app.name, phone: app.phone, contact: '', vacancyId: app.vacancyId, friend: '', token: app.statusToken, ...(practice ? { practice: true } : {}) } }, version: 0 }),
    )})`

  const mine = new h.Scenario('pages-chat: моя заявка — дорога, подготовка, первая смена, бот, выбор времени', true)
  await mine.step('новая заявка на практику: «Куда ехать и что взять» — автобус от «Озёрной», кабинет 525, общежитие; «Как подготовиться» нет', async () => {
    const { context, page } = await h.open(mine, h.MOBILE)
    const app = await createApp(page, { vacancyId: 'lab-chemist', practiceSchool: true, startReady: 'month', startMonth: 4 })
    await page.addInitScript({ content: rememberApp(app, true) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByText('Заявка у отдела персонала')).toBeVisible()
    const visit = page.getByRole('region', { name: 'Куда ехать и что взять' })
    // Дорога — списком по станциям: «м. «Озёрная»» и под ней корпоративный автобус
    await expect(visit.locator('dt').first()).toHaveText('м. «Озёрная»')
    await expect(visit.locator('dd').first()).toContainText('корпоративный автобус')
    await expect(visit).toContainText('кабинет 525')
    await expect(visit).toContainText('3 400 ₽')
    await expect(visit.getByRole('link', { name: 'Позвонить в отдел подбора' })).toHaveAttribute('href', /^tel:\d+$/)
    await expect(page.getByText(/^Как подготовиться/)).toHaveCount(0)
    // На телефоне путь до первой смены — сразу после статуса, выше «Позвать друга»; текущий шаг отмечен «сейчас»
    const path = await page.getByText('Путь до первой смены').boundingBox()
    const call = await page.getByRole('button', { name: 'Позвать друга' }).boundingBox()
    expect(path && call && path.y < call.y, 'шаги ниже «Позвать друга»').toBe(true)
    await expect(page.locator('li[aria-current="step"]')).toContainText('сейчас')
    // Шаг «Первая смена» — месяц из «Когда сможешь выйти»
    await expect(page.locator('li[aria-current], ol li').filter({ hasText: 'Первая смена' })).toContainText('не раньше апреля')
    const r = await h.overflow(page)
    expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    await context.close()
  })
  await mine.step('заявка на работу без практики: документов по практике нет, заголовок «Дорога и общежитие»', async () => {
    const { context, page } = await h.open(mine, h.DESKTOP)
    const app = await createApp(page, { vacancyId: 'store-worker' })
    await page.addInitScript({ content: rememberApp(app, false) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    const visit = page.getByRole('region', { name: 'Дорога и общежитие' })
    await expect(visit).toContainText('корпоративный автобус')
    await expect(visit).not.toContainText('Документы по практике')
    await context.close()
  })
  await mine.step('«К оформлению» с датой: блок «Первая смена» и «Как подготовиться к оформлению»', async () => {
    const { context, page } = await h.open(mine, h.MOBILE)
    const app = await createApp(page, { vacancyId: 'bottling-operator', practiceSchool: true })
    await h.sql`update applications set status = 'hired', first_shift_at = now() + interval '3 days', shift_kind = 'day' where id = ${app.id}`
    await page.addInitScript({ content: rememberApp(app, true) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByText('Ждём на оформление')).toBeVisible()
    await expect(page.locator('p', { hasText: /^Первая смена$/ })).toBeVisible()
    await expect(page.locator('main')).toContainText('дневная смена')
    await expect(page.getByText('Как подготовиться к оформлению')).toBeVisible()
    await expect(page.locator('main')).toContainText('медицинская книжка')
    await context.close()
  })
  await mine.step('бот подключён: «Получать ответ HR в Telegram» на 390 без прокрутки, ссылка открывает бота; без бота кнопок нет', async () => {
    const { context, page } = await h.open(mine, h.MOBILE)
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bots: { telegram: 'ochakovo_test_bot', max: null }, assistant: 'offline' }) }),
    )
    const deep = 'https://t.me/ochakovo_test_bot?start=app_e2e'
    await page.route('**/api/applications/*/bot-link', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ telegram: deep }) }))
    // Окно бота не открываем по-настоящему: запоминаем адрес, куда его отправили
    await page.addInitScript({
      content: `window.__opened = []; window.open = () => { const tab = { closed: false, close() {}, location: {} }; Object.defineProperty(tab.location, 'href', { set: (v) => window.__opened.push(v) }); return tab };`,
    })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await fillContacts(page, uniqueName('Бот'), phone())
    await tick(page, 'apply-consent')
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Заявка\s*отправлена/ })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 0))
    const button = page.getByRole('button', { name: 'Получать ответ HR в Telegram' })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box && box.y + box.height <= 844, 'кнопку бота не видно без прокрутки').toBe(true)
    await expect(page.getByRole('button', { name: /в MAX$/ })).toHaveCount(0)
    await expect(page.locator('main')).toContainText('Чтобы отвязать его, отправь /stop')
    await button.click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([deep])
    await expect(page.locator('main')).toContainText('Ответ придёт в Telegram')
    await context.close()
    // Настоящий сервер этого прогона без ботов: кнопок нет
    const { context: c2, page: p2 } = await h.open(mine, h.MOBILE)
    const app = await createApp(p2)
    await p2.addInitScript({ content: rememberApp(app, false) })
    await p2.goto('/apply', { waitUntil: 'networkidle' })
    await expect(p2.getByText('Заявка у отдела персонала')).toBeVisible()
    await expect(p2.getByRole('button', { name: /^Получать ответ HR/ })).toHaveCount(0)
    await c2.close()
  })
  await mine.step('выбор времени: до 6 часов кнопками, занятое — «Это время уже заняли, выбери другое», запись, перенос, «позвоните»', async () => {
    const { context, page } = await h.open(mine, h.MOBILE)
    const app = await createApp(page)
    const start = new Date(Date.now() + 2 * 864e5)
    start.setUTCMinutes(0, 0, 0)
    const hours = Array.from({ length: 8 }, (_, i) => new Date(start.getTime() + i * 3600e3).toISOString())
    let booked: string | null = null
    let posts = 0
    let none = 0
    await page.route('**/api/applications/*/booking**', async (route) => {
      const req = route.request()
      expect(req.headers()['x-status-token']).toBe(app.statusToken)
      if (req.url().endsWith('/booking/none')) {
        none++
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      }
      if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hours: booked ? hours.slice(2) : hours, booked }) })
      if (req.method() === 'POST') {
        posts++
        if (posts === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'taken' }) })
        booked = (req.postDataJSON() as { startsAt: string }).startsAt
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      }
      booked = null
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.addInitScript({ content: rememberApp(app, false) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByText('Выбери время собеседования')).toBeVisible()
    const choices = page.locator('ul li button').filter({ hasText: /\d{2}:\d{2}/ })
    await expect(choices).toHaveCount(6)
    await choices.first().click()
    await expect(page.getByRole('status')).toHaveText('Это время уже заняли, выбери другое.')
    await choices.nth(1).click()
    await expect(page.getByText('Время выбрано на этой странице — его можно перенести или отменить.')).toBeVisible()
    expect(booked).toBe(hours[1])
    await page.getByRole('button', { name: 'Перенести' }).click()
    await expect(page.getByText('Другое время собеседования')).toBeVisible()
    await page.getByRole('button', { name: 'Ни одно время не подходит — позвоните' }).click()
    await expect(page.getByText('HR позвонит и предложит другое время.')).toBeVisible()
    expect(none).toBe(1)
    await context.close()
  })

  await mine.step('ссылка на заявку: другой браузер видит тот же номер и статус, фрагмента в адресе нет; неверный ключ — «Ссылка не подошла»', async () => {
    const { context, page } = await h.open(mine, h.DESKTOP)
    await page.addInitScript({
      content: `Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        navigator.clipboard.writeText = async (t) => { window.__copied = t };`,
    })
    const app = await createApp(page)
    await page.addInitScript({ content: rememberApp(app, false) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Сохранить ссылку на заявку' }).click()
    await expect(page.locator('main')).toContainText('не публикуй её')
    const link = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '')
    expect(link).toMatch(new RegExp(`/apply#app=${app.id}\\.`))
    await context.close()
    // Чистый браузер: ссылка открывает статус, ключ уходит из адреса, имени и телефона в браузере нет
    const { context: b, page: other } = await h.open(mine, h.MOBILE)
    await other.goto(new URL(link).pathname + new URL(link).hash, { waitUntil: 'networkidle' })
    await expect(other.getByText('Заявка у отдела персонала')).toBeVisible()
    await expect(other.locator('main')).toContainText(app.id)
    expect(new URL(other.url()).hash).toBe('')
    const saved = await other.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.application') ?? '{}').state?.last)
    expect(saved).toMatchObject({ id: app.id, name: '', phone: '' })
    // Неверный ключ: сообщение и контакты, прежняя заявка в браузере на месте
    await other.goto(`/apply#app=${app.id}.${'z'.repeat(32)}`, { waitUntil: 'networkidle' })
    await expect(other.getByRole('alert')).toContainText('Ссылка не подошла')
    await expect(other.getByRole('alert')).toContainText(contacts.email)
    expect(new URL(other.url()).hash).toBe('')
    expect(await other.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.application') ?? '{}').state?.last?.id)).toBe(app.id)
    await b.close()
  })

  await mine.step('отзыв согласия на странице (ответ сервера подменён): «Оставить» ничего не делает, «Удалить заявку» стирает копию', async () => {
    const { context, page } = await h.open(mine, h.MOBILE)
    const app = await createApp(page)
    let calls = 0
    await page.route('**/api/applications/*/withdraw', (route) => {
      calls++
      expect(route.request().headers()['x-status-token']).toBe(app.statusToken)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.addInitScript({ content: rememberApp(app, false) })
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Отозвать согласие и удалить заявку' }).click()
    await expect(page.getByRole('button', { name: 'Оставить' })).toBeFocused()
    await page.getByRole('button', { name: 'Оставить' }).click()
    expect(calls).toBe(0)
    await page.getByRole('button', { name: 'Отозвать согласие и удалить заявку' }).click()
    await page.getByRole('button', { name: 'Удалить заявку' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'согласие отозвано' })).toBeVisible()
    expect(calls).toBe(1)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.application') ?? '{}').state?.last ?? null)).toBeNull()
    await expect(page.locator('header').getByRole('link', { name: /^Моя заявка/ })).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: 'Заявка' })).toBeVisible()
    await context.close()
  })

  // Отзыв согласия — по настоящему API (w2-platform). Пока маршрута нет, сценарий пропускается с причиной
  const withdraw = new h.Scenario('pages-chat: отозвать согласие и удалить заявку')
  await (async () => {
    const { context, page } = await h.open(withdraw, h.MOBILE)
    // Проба своей заявкой: маршрут есть — она удаляется (2xx), маршрута нет — 404 даже со своим ключом
    const spare = await createApp(page)
    const probe = await page.request.post(`/api/applications/${spare.id}/withdraw`, { headers: { 'x-status-token': spare.statusToken } })
    if (!probe.ok()) {
      withdraw.skip('на сервере нет POST /api/applications/:id/withdraw (w2-platform)')
      await context.close()
      return
    }
    const app = await createApp(page)
    await withdraw.step('чужой ключ — 404, заявка на месте', async () => {
      const res = await page.request.post(`/api/applications/${app.id}/withdraw`, { headers: { 'x-status-token': 'y'.repeat(32) } })
      expect(res.status()).toBe(404)
      const [row] = await h.sql<{ anonymized_at: Date | null }[]>`select anonymized_at from applications where id = ${app.id}`
      expect(row.anonymized_at).toBeNull()
    })
    await withdraw.step('с подтверждением: заявка удалена по запросу, статус — 404, копия в браузере стёрта, в шапке «Откликнуться»', async () => {
      await page.addInitScript({ content: rememberApp(app, false) })
      await page.goto('/apply', { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Отозвать согласие и удалить заявку' }).click()
      await expect(page.getByRole('group', { name: /^Удалить заявку/ })).toBeVisible()
      await page.getByRole('button', { name: 'Удалить заявку' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'согласие отозвано' })).toBeVisible()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.application') ?? '{}').state?.last ?? null)).toBeNull()
      await expect(page.locator('header').getByRole('link', { name: 'Откликнуться' }).first()).toBeVisible()
      const status = await page.request.get(`/api/applications/${app.id}/status`, { headers: { 'x-status-token': app.statusToken } })
      expect(status.status()).toBe(404)
      const [row] = await h.sql<{ anonymized_reason: string }[]>`select anonymized_reason from applications where id = ${app.id}`
      expect(row.anonymized_reason).toBe('request')
    })
    await context.close()
  })()

  // ── Счётчики: только при ID от сервера и после согласия ─────────────
  const counters = new h.Scenario('pages-chat: Яндекс Метрика и пиксель VK — только при ID и согласии', true)
  const external = (url: string) => /mc\.yandex\.ru|top-fragment\.mail\.ru/.test(url)
  await counters.step('без ID: ни плашки, ни одного запроса к счётчикам, в политике нет раздела «Аналитика»', async () => {
    const { context, page } = await h.open(counters, h.DESKTOP)
    const calls: string[] = []
    page.on('request', (r) => external(r.url()) && calls.push(r.url()))
    for (const path of ['/', '/apply', '/privacy']) await page.goto(path, { waitUntil: 'networkidle' })
    await expect(page.getByRole('region', { name: 'Счётчики посещений' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Аналитика/ })).toHaveCount(0)
    expect(calls).toEqual([])
    await context.close()
  })
  await counters.step('с ID: до «Разрешить» запросов нет; после — счётчики и цели без имени и телефона', async () => {
    const { context, page } = await h.open(counters, h.DESKTOP)
    const calls: string[] = []
    page.on('request', (r) => external(r.url()) && calls.push(r.url()))
    // Метатег, который ставит сервер при заданных ID; скрипты счётчиков подменены пустыми — наружу ничего не уходит
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue()
      const res = await route.fetch()
      const headers = { ...res.headers() }
      for (const k of ['content-security-policy', 'content-encoding', 'content-length']) delete headers[k]
      const body = (await res.text()).replace('<head>', `<head><meta name="analytics" content='{"metrika":"12345678","vk":"3456789"}'>`)
      return route.fulfill({ response: res, headers, body })
    })
    await page.route(/mc\.yandex\.ru|top-fragment\.mail\.ru/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }))
    await page.goto('/apply', { waitUntil: 'networkidle' })
    const bar = page.getByRole('region', { name: 'Счётчики посещений' })
    await expect(bar).toBeVisible()
    expect(calls, 'счётчики загрузились без согласия').toEqual([])
    await bar.getByRole('button', { name: 'Разрешить' }).click()
    await expect.poll(() => calls.some((u) => u.includes('mc.yandex.ru/metrika/tag.js')) && calls.some((u) => u.includes('top-fragment.mail.ru'))).toBe(true)
    expect(await page.evaluate(() => localStorage.getItem('ochakovo.analytics'))).toBe('yes')
    await expect(bar).toHaveCount(0)
    await expect(page.locator('footer')).toContainText('Выключить счётчики')
    const name = uniqueName('Счётчик')
    const tel = phone()
    await fillContacts(page, name, tel)
    await tick(page, 'apply-consent')
    await page.getByRole('button', { name: 'Отправить заявку' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Заявка\s*отправлена/ })).toBeVisible()
    const sent = await page.evaluate(() => {
      const w = window as unknown as { ym?: { a?: unknown[][] }; _tmr?: unknown[] }
      return { ym: JSON.stringify(w.ym?.a ?? []), tmr: JSON.stringify(w._tmr ?? []) }
    })
    expect(sent.ym).toContain('"reachGoal","application"')
    expect(sent.tmr).toContain('"goal":"application"')
    expect(sent.ym).toContain('"webvisor":false')
    for (const secret of [name, tel, tel.replace(/\D/g, '')]) expect(sent.ym + sent.tmr, 'в счётчики ушли личные данные').not.toContain(secret)
    await page.goto('/privacy', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: /Аналитика/ })).toBeVisible()
    await context.close()
  })

  // ── Чат ──────────────────────────────────────────────────────────────
  const chat = new h.Scenario('pages-chat: чат', true)
  /** Открыть чат ссылкой «открыть чат» под списком вакансий */
  const openChat = async (page: Page) => {
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'открыть чат' }).click()
    const dialog = page.getByRole('dialog', { name: /Квасыч/ })
    await expect(dialog).toBeVisible()
    return dialog
  }
  await chat.step('запрос несёт код приглашения, в панели нет <header>, точка у Квасыча мигает три раза', async () => {
    const { context, page } = await h.open(chat, h.MOBILE)
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    const dot = page.getByRole('complementary', { name: 'Чат с Квасычем' }).getByRole('button', { name: 'Спросить Квасыча', exact: true }).locator('span[aria-hidden] > span').first()
    await expect(dot).toBeVisible()
    expect(await dot.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe('3')
    const body = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/dialog')
    await page.getByRole('button', { name: 'открыть чат' }).click()
    const sent = (await body).postDataJSON() as { refCode?: string }
    expect(sent.refCode).toBe(await page.evaluate(() => localStorage.getItem('ochakovo.ref')))
    const dialog = page.getByRole('dialog', { name: /Квасыч/ })
    await expect(dialog.locator('[data-entry]').first()).toBeVisible()
    await expect(dialog.locator('header')).toHaveCount(0)
    await context.close()
  })
  await chat.step('подсказка поля: имя, телефон с inputmode=tel; заявка из чата → «Моя заявка» в шапке и статус на /apply', async () => {
    const { context, page } = await h.open(chat, h.MOBILE)
    // Настоящая заявка — чтобы /apply показал её живой статус по ключу из ответа чата
    const name = uniqueName('Чат')
    // Поля кейса обязательны для заявки с сайта; дата рождения — 20 лет назад от текущего момента
    const caseFields = { lastName: 'Проверкина', birthDate: new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10), school: 'МГУПП', startReady: 'now' }
    const res = await page.request.post('/api/applications', { data: { name, phone: phone(), ...caseFields, consent: true, consentVersion: CONSENT_VERSION } })
    const app = (await res.json()) as { id: string; statusToken: string; phone: string }
    expect(app.statusToken, 'сервер не отдал ключ статуса').toBeTruthy()
    await page.route('**/api/dialog', async (route) => {
      const event = (route.request().postDataJSON() as { event: { type: string; text?: string } }).event
      const reply =
        event.type === 'start'
          ? { messages: [{ text: 'Как тебя зовут?', input: 'name' }] }
          : event.text === 'Аня'
            ? { messages: [{ text: 'Телефон или ник?', input: 'phone' }] }
            : { messages: [{ text: 'Заявка у HR.' }], application: { id: app.id, token: app.statusToken, name, phone: app.phone, contact: '', vacancyId: '', friend: '' } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) })
    })
    const dialog = await openChat(page)
    const input = dialog.getByRole('textbox')
    await expect(input).toHaveAttribute('placeholder', 'Имя')
    await expect(input).toHaveAttribute('autocomplete', 'given-name')
    await expect(dialog.getByRole('button', { name: 'Ник вместо номера' })).toHaveCount(0)
    await input.fill('Аня')
    await dialog.getByRole('button', { name: 'Отправить', exact: true }).click()
    await expect(input).toHaveAttribute('inputmode', 'tel')
    await expect(dialog.getByRole('button', { name: /^Сколько платят/ })).toHaveCount(0)
    // На цифровой клавиатуре нет букв: ник набирается после переключения, и обратно
    await dialog.getByRole('button', { name: 'Ник вместо номера' }).click()
    await expect(input).toHaveAttribute('inputmode', 'text')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('placeholder', '@ник в Telegram или MAX')
    await dialog.getByRole('button', { name: 'Ввести номер телефона' }).click()
    await expect(input).toHaveAttribute('inputmode', 'tel')
    await input.fill(app.phone)
    await dialog.getByRole('button', { name: 'Отправить', exact: true }).click()
    await expect(dialog).toContainText('Заявка у HR.')
    await expect(input).not.toHaveAttribute('inputmode', 'tel')
    await page.keyboard.press('Escape')
    await expect(page.locator('header').getByRole('link', { name: /^Моя заявка, номер/ })).toHaveCount(1)
    await page.goto('/apply', { waitUntil: 'networkidle' })
    await expect(page.getByText('Заявка у отдела персонала')).toBeVisible()
    await context.close()
  })
  await chat.step('компьютер: на шаге телефона подсказка «Телефон или @ник», переключателя клавиатуры нет', async () => {
    const { context, page } = await h.open(chat, h.DESKTOP)
    await page.route('**/api/dialog', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [{ text: 'Телефон или ник?', input: 'phone' }] }) }),
    )
    const dialog = await openChat(page)
    const input = dialog.getByRole('textbox')
    await expect(input).toHaveAttribute('placeholder', 'Телефон или @ник')
    await expect(dialog.getByRole('button', { name: 'Ник вместо номера' })).toHaveCount(0)
    await context.close()
  })
  await chat.step('бот молчит 30 секунд — «Квасыч не ответил за 30 секунд» и «Повторить»', async () => {
    const { context, page } = await h.open(chat, h.DESKTOP)
    // Ждать полминуты незачем: таймер ответа 30 000 мс в этой вкладке срабатывает через 0,4 с
    await page.addInitScript({
      content: `const t = window.setTimeout; window.setTimeout = (fn, ms, ...a) => t(fn, ms === 30000 ? 400 : ms, ...a);`,
    })
    let hang = true
    await page.route('**/api/dialog', async (route) => {
      if (hang) {
        await new Promise((r) => setTimeout(r, 2500))
        await route.abort().catch(() => {})
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [{ text: 'Привет, это Квасыч.' }] }) })
    })
    const dialog = await openChat(page)
    await expect(dialog).toContainText('Квасыч не ответил за 30 секунд.')
    hang = false
    await dialog.getByRole('button', { name: 'Повторить' }).click()
    await expect(dialog).toContainText('Привет, это Квасыч.')
    await context.close()
  })
  await chat.step('в покое кнопка чата не опрашивает страницу', async () => {
    const { context, page } = await h.open(chat, h.DESKTOP)
    await page.addInitScript({
      content: `const f = Document.prototype.elementFromPoint; window.__probes = 0;
        Document.prototype.elementFromPoint = function (...a) { window.__probes++; return f.apply(this, a) };`,
    })
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const before = await page.evaluate(() => (window as unknown as { __probes: number }).__probes)
    await page.waitForTimeout(2500)
    const after = await page.evaluate(() => (window as unknown as { __probes: number }).__probes)
    expect(after - before, 'кнопка чата проверяет страницу по таймеру').toBe(0)
    await context.close()
  })

  return [consent, server, invite, legal, jobs, mine, withdraw, counters, chat]
}
