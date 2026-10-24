// Секции главной глазами человека: «Вопросы», вакансии трёх форматов, «Условия» таблицей, каждое фото один раз,
// «Собери лето» с бутылкой, деньгами за смену и «Поделиться расчётом», колода «Правда или миф»,
// «Спросить Квасыча» с ботами из /api/config и «Напомнить о наборе», появление заголовков.
// Владелец во второй волне — w2-home. Только он: E2E_ONLY=home-sections pnpm test:e2e

import { readFileSync } from 'node:fs'
import type { Page } from 'playwright'
import { contacts, myths } from '../../shared/content/content'
import { stages } from '../../shared/content/production'
import { faq } from '../../shared/content/faq'
import { freePractice, scheduleByUnit, scheduleLine, scheduleNote, scheduleSummary, SHIFT_HOURS_2_2, shiftHours, shiftPay, vacancies, vacancyById } from '../../shared/content/vacancies'
import type { E2eHarness } from './_harness'

/** Неразрывные пробелы и невидимые символы типографа — в обычные пробелы */
const plain = (t: string) =>
  t
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\u2060/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const rub = (n: number) => n.toLocaleString('ru-RU')

/** Реплики фрагмента «Спросить Квасыча» — из исходника BotBlock.tsx (их же сверяет проверка с движком) */
const botSample = (() => {
  const src = readFileSync(new URL('../../src/home/BotBlock.tsx', import.meta.url), 'utf8')
  const start = src.indexOf('const BOT_SAMPLE')
  return [...src.slice(start, src.indexOf('\n]', start)).matchAll(/q:\s*'([^']+)',\s*a:\s*'([^']+)'/g)].map((m) => ({ q: m[1], a: m[2].replace(/\\n/g, '\n') }))
})()

/** Строка «за смену» в «Собери лето» — как её должен показать экран по shiftPay */
function shiftLine(id: string) {
  const s = shiftPay(vacancyById(id)!)
  if (!s) return null
  return plain(`≈ ${rub(s.perShift)} ₽ на руки за смену, ≈ ${rub(s.perHour)} ₽ в час при ${Math.round(s.shiftsPerMonth)} сменах в месяц по ${SHIFT_HOURS_2_2} часов`)
}

/**
 * Все показанные картинки главной: имя кадра (без ширины и формата) и «владелец» — этап «Пути кваса», карточка мифа,
 * итог подбора или секция. Один и тот же кадр у двух владельцев — повтор
 */
async function photosOnPage(page: Page, claims: string[]) {
  return page.evaluate((claims) => {
    const out: { name: string; owner: string }[] = []
    const norm = (t: string | null | undefined) => (t ?? '').replace(/⁠/g, '').replace(/\s+/g, ' ')
    for (const img of document.querySelectorAll('img')) {
      if (!img.currentSrc || !img.getClientRects().length) continue
      const name = decodeURIComponent(img.currentSrc.split('/').pop() ?? '').replace(/-\d+\.(avif|webp|jpe?g|png)$/, '')
      const section = img.closest('section[id]')?.id ?? 'page'
      let owner = section
      if (section === 'path') owner = `path:${img.alt || img.closest('[aria-label]')?.getAttribute('aria-label') || ''}`
      if (section === 'myth') {
        const box = img.closest('article') ?? img.parentElement?.parentElement
        owner = `myth:${claims.find((c) => norm(box?.textContent).includes(c)) ?? '?'}`
      }
      out.push({ name, owner })
    }
    return out
  }, claims)
}

function repeats(seen: { name: string; owner: string }[]) {
  const owners = new Map<string, Set<string>>()
  for (const p of seen) owners.set(p.name, (owners.get(p.name) ?? new Set()).add(p.owner))
  return [...owners].filter(([, o]) => o.size > 1).map(([name, o]) => `${name}: ${[...o].join(' | ')}`)
}

/** Пройти колоду «Правда или миф» до итога, по пути отдать каждую карточку в onCard. Возвращает утверждения по порядку */
async function playMyth(page: Page, h: E2eHarness, onCard?: () => Promise<void>) {
  const myth = page.locator('#myth')
  const claims: string[] = []
  for (let i = 1; i <= 5; i++) {
    const claim = myth.locator('article p').first()
    await h.expect(claim).toBeVisible()
    claims.push(plain((await claim.innerText()).replace(/^Факт \d из \d:\s*/, '')))
    await onCard?.()
    await myth.getByRole('button', { name: i % 2 ? 'Правда →' : '← Миф' }).click()
    await onCard?.()
    await myth.getByRole('button', { name: i < 5 ? 'Следующий факт' : 'Итог' }).click()
  }
  await h.expect(myth.getByRole('heading', { name: /из 5/ })).toBeVisible()
  return claims
}

export default async (h: E2eHarness) => {
  const s = new h.Scenario('home-sections: секции главной', true)
  const claims = myths.map((m) => plain(m.claim))

  await s.step('390: «Вопросы» — восемь сразу, остальные под «Ещё», тексты из faq.ts', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.goto('/')
    const section = page.locator('#faq')
    const list = faq.filter((f) => f.a.trim())
    const questions = section.locator('ul > li > button')
    await h.expect(questions).toHaveCount(Math.min(8, list.length))
    h.expect(list.length, 'в faq.ts меньше восьми ответов').toBeGreaterThanOrEqual(8)
    const shown = (await questions.allInnerTexts()).map((t) => plain(t).toLowerCase())
    h.expect(shown).toEqual(list.slice(0, 8).map((f) => plain(f.q).toLowerCase()))
    for (const b of await questions.all()) await h.expect(b).toBeVisible()
    if (list.length > 8) {
      await section.getByRole('button', { name: new RegExp(`^Ещё ${list.length - 8} вопрос`) }).click()
      await h.expect(questions).toHaveCount(list.length)
      await h.expect(questions.nth(8)).toBeFocused()
    }
    const last = list.at(-1)!
    await questions.last().click()
    await h.expect(section.locator(`#faq-${last.id}`)).toBeVisible()
    h.expect(plain(await section.locator(`#faq-${last.id}`).innerText())).toBe(plain(last.a))
    await context.close()
  })

  for (const [label, options] of [['390', h.MOBILE], ['1440', h.DESKTOP]] as const) {
    await s.step(`${label}: «Вакансии» — три формата: оплачиваемая практика строкой, бесплатная «без оплаты», работа с графиком`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/')
      const section = page.locator('#vacancies')
      const paid = section.locator('[data-vacancy-group="paid"]')
      await h.expect(paid).toContainText('Оплачиваемая практика')
      await h.expect(paid).toContainText(/56\s000–70\s000\s₽/)
      h.expect(await paid.getAttribute('href')).toBe('#practice')
      for (const v of freePractice) {
        const row = section.getByRole('link', { name: new RegExp(v.title, 'i') })
        await h.expect(row).toContainText('без оплаты')
        h.expect(plain(await row.innerText())).not.toMatch(/по итогам собеседования/)
      }
      for (const v of vacancies.filter((x) => x.format === 'Постоянная работа')) {
        const row = section.getByRole('link', { name: new RegExp(v.title, 'i') })
        h.expect(plain(await row.innerText())).toContain(plain(scheduleLine(v)))
      }
      h.expect(plain(await section.innerText())).not.toMatch(/сезонная работа|стажировка|ориентир/i)
      await context.close()
    })

    await s.step(`${label}: «Условия» — таблица: дни зарплаты, график, учёба, документы и дорога с корпоративным автобусом`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/')
      const section = page.locator('#conditions')
      await section.scrollIntoViewIfNeeded()
      const text = plain(await section.innerText())
      for (const want of ['12-ГО И 27-ГО', plain(scheduleSummary.title).toUpperCase(), 'ЭКЗАМЕНЫ НА ЗАВОДЕ', 'ДОГОВОР С ВУЗОМ', 'РЯБИНОВАЯ, 44']) h.expect(text).toContain(want)
      // Дорога — по предложениям маршрута, график — таблицей по отделам из тех же данных, что ответ чата
      for (const line of contacts.route.split(/\.\s+(?=[А-ЯЁ])/)) h.expect(text).toContain(plain(line.replace(/\.$/, '')))
      h.expect(text).toContain('корпоративный автобус')
      for (const part of [shiftHours, scheduleNote, ...scheduleByUnit.flatMap((u) => [u.unit, u.text])]) h.expect(text).toContain(plain(part))
      h.expect(await section.locator('table th[scope="row"]').count(), 'строк графика').toBe(scheduleByUnit.length)
      h.expect(text).not.toMatch(/ДМС|дают общежитие/i)
      h.expect(await section.locator('dl > div').count(), 'строк в таблице').toBe(5)
      h.expect(await section.locator('.text-mute, [class*="text-ink/75"]').count(), 'приглушённые абзацы').toBe(0)
      // Телефон: метка над фактом. Компьютер: метка, факт и подробность в одну строку
      const [dt, dd] = await Promise.all([section.locator('dt').first().boundingBox(), section.locator('dd').first().boundingBox()])
      if (label === '390') h.expect(dt!.y + dt!.height).toBeLessThanOrEqual(dd!.y + 1)
      else h.expect(dt!.x + dt!.width).toBeLessThanOrEqual(dd!.x)
      await context.close()
    })
  }

  for (const [label, options] of [['390', h.MOBILE], ['1440', h.DESKTOP]] as const) {
    await s.step(`${label}: каждое фото на главной один раз — по всем этапам, карточкам и итогу подбора, силосов нет`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/', { waitUntil: 'networkidle' })
      await h.readThrough(page)
      const seen = await photosOnPage(page, claims)
      // «Путь кваса»: каждый этап
      if (label === '1440') {
        const tabs = page.locator('#path [role="tab"]')
        for (let i = 0; i < (await tabs.count()); i++) {
          await tabs.nth(i).click()
          await page.waitForTimeout(800)
          await page.waitForLoadState('networkidle')
          seen.push(...(await photosOnPage(page, claims)))
        }
      } else {
        const cards = page.locator('#path ol > li')
        for (let i = 0; i < (await cards.count()); i++) {
          await cards.nth(i).evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }))
          await page.waitForTimeout(250)
        }
        await page.waitForLoadState('networkidle')
        seen.push(...(await photosOnPage(page, claims)))
      }
      // «Правда или миф»: каждая карточка до и после ответа и итог
      await page.locator('#myth').scrollIntoViewIfNeeded()
      await playMyth(page, h, async () => {
        await page.waitForLoadState('networkidle')
        seen.push(...(await photosOnPage(page, claims)))
      })
      seen.push(...(await photosOnPage(page, claims)))
      // Итог подбора
      await h.doQuiz(page)
      await page.waitForTimeout(700)
      await page.waitForLoadState('networkidle')
      seen.push(...(await photosOnPage(page, claims)))
      // Итог подбора у каждого отдела: подбор из прошлого визита, сохранённый в браузере
      if (label === '1440')
        for (const id of ['bottling-operator', 'lab-chemist', 'automation-intern', 'warehouse-operator', 'merchandiser', 'marketing-intern']) {
          await page.evaluate((id) => {
            const raw = JSON.parse(localStorage.getItem('ochakovo.profile') ?? '{"state":{},"version":1}')
            raw.state = { ...raw.state, quizVacancy: id, quizAnswers: null, moneyVacancy: null, chosenVacancy: null }
            localStorage.setItem('ochakovo.profile', JSON.stringify(raw))
          }, id)
          await page.reload()
          await page.locator('#quiz').scrollIntoViewIfNeeded()
          await h.expect(page.locator('#quiz').getByRole('heading', { name: new RegExp(vacancyById(id)!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })).toBeVisible()
          await page.waitForTimeout(700)
          await page.waitForLoadState('networkidle')
          seen.push(...(await photosOnPage(page, claims)).filter((p) => p.owner === 'quiz'))
        }
      // Колода случайная, поэтому кадры всех этапов и всех карточек с фото — из данных, а не только показанные
      seen.push(...stages.map((st) => ({ name: st.photo, owner: `path:${st.title}` })))
      seen.push(...myths.filter((m) => m.photo && !m.figure && m.id !== 'bottles-per-hour').map((m) => ({ name: m.photo!, owner: `myth:${plain(m.claim)}` })))
      h.expect(seen.length, 'картинок не нашлось').toBeGreaterThan(5)
      h.none(repeats(seen), 'один кадр в двух местах')
      h.expect(seen.filter((p) => p.name === 'silos').map((p) => p.owner), 'силосы').toEqual([])
      // В «Собери лето» фото нет — там бутылка
      h.expect(await page.locator('#money img').count()).toBe(0)
      await context.close()
    })
  }

  await s.step('«Лаборатория» в «Пути кваса»: монохромом и не шире полутора своих 480 px', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await page.locator('#path').getByRole('tab', { name: /Лаборатория/ }).click()
    const lab = page.locator('#path-panel [role="img"][aria-label="Лаборатория"] img')
    await h.expect(lab).toBeVisible()
    const box = await lab.boundingBox()
    h.expect(box!.width).toBeLessThanOrEqual(720 + 1)
    h.expect(await lab.evaluate((el) => getComputedStyle(el).filter)).toContain('grayscale')
    await context.close()
  })

  await s.step('390: «Собери лето» — бутылка наливается с месяцами, у практики нет сентября, за смену и в час, без прокрутки вбок', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: unknown[] }
      w.__shared = []
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: unknown) => void w.__shared.push(data) })
    })
    await page.goto('/')
    const money = page.locator('#money')
    await money.scrollIntoViewIfNeeded()
    const level = () => money.locator('[data-season-bottle]').filter({ visible: true }).locator('g rect').first().evaluate((el) => (el as SVGRectElement).style.transform)
    const before = await level()
    const months = money.getByRole('group', { name: 'Месяцы' })
    await months.getByRole('button', { name: 'март' }).click()
    await h.expect.poll(level).not.toBe(before)
    // Практика — с марта или апреля до середины августа: у практики сентябрь не нажимается, у работы в магазине — нажимается
    await h.expect(months.getByRole('button', { name: 'сентябрь' })).toBeDisabled()
    await h.expect(money.locator('#money-months-note')).toContainText('В сентябре практики нет')
    // «После сессии» — июль и август
    await money.getByRole('button', { name: 'После сессии' }).click()
    for (const [m, on] of [['март', false], ['июнь', false], ['июль', true], ['август', true], ['сентябрь', false]] as const)
      await h.expect(months.getByRole('button', { name: m, exact: true })).toHaveAttribute('aria-pressed', String(on))
    await h.expect(money).toContainText('На руки за 2 месяца')
    // За смену и в час — у всех трёх должностей, теми же числами, что shiftPay
    const roles = money.getByRole('group', { name: 'Должность' }).getByRole('button')
    for (const [i, id] of ['fermentation-assistant', 'lab-chemist', 'store-worker'].entries()) {
      await roles.nth(i).click()
      const want = shiftLine(id)
      h.expect(want, `shiftPay(${id}) пуст`).toBeTruthy()
      h.expect(plain(await money.locator('[data-money-shift]').innerText()).toLowerCase()).toBe(want!.toLowerCase())
      h.expect(plain(await money.innerText())).toContain(plain(scheduleLine(vacancyById(id)!)))
    }
    // Магазин — постоянная работа: сентябрь есть
    await h.expect(months.getByRole('button', { name: 'сентябрь' })).toBeEnabled()
    await roles.first().click()
    await h.expect(months.getByRole('button', { name: 'сентябрь' })).toBeDisabled()
    // Поделиться: тот же расчёт, что на экране, и ссылка-приглашение на #money
    await money.getByRole('button', { name: /^(Подставить в заявку|Обновить)/ }).click()
    await page.waitForTimeout(900)
    const net = plain(await money.locator('[data-money-net]').innerText()).replace(/[^\d ]/g, '').trim()
    await money.getByRole('button', { name: 'Поделиться расчётом' }).click()
    const shared = (await page.evaluate(() => (window as unknown as { __shared: { text: string; url: string }[] }).__shared))[0]
    h.expect(shared, 'navigator.share не вызван').toBeTruthy()
    h.expect(plain(shared.text)).toContain(`≈ ${net} ₽ на руки`)
    h.expect(plain(shared.text)).toContain('июль, август')
    h.expect(new URL(shared.url).pathname + new URL(shared.url).search + new URL(shared.url).hash).toMatch(/^\/\?src=ref_[a-z2-9]{6}#money$/)
    const r = await h.overflow(page)
    h.expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    h.none(r.out, 'за краем экрана')
    await context.close()
  })

  await s.step('1440: итог подбора — график через scheduleLine, у ночных — «бывают ночные»', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.goto('/')
    await h.doQuiz(page)
    const quiz = page.locator('#quiz')
    const title = plain(await quiz.locator('h3').first().innerText()).replace(/^Тебе подойдёт\s*/i, '')
    const v = vacancies.find((x) => x.title.toLowerCase() === title.toLowerCase())
    h.expect(v, `не нашёл вакансию «${title}»`).toBeTruthy()
    h.expect(plain(await quiz.innerText())).toContain(plain(scheduleLine(v!)))
    await context.close()
  })

  await s.step('«Правда или миф»: подзаголовок, счёт из пяти, повтор раздаёт другую колоду', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.goto('/')
    const myth = page.locator('#myth')
    await h.expect(myth).toContainText('Пять фактов о заводе и работе')
    const first = await playMyth(page, h)
    await h.expect(myth.getByRole('heading', { name: /^\d из 5/ })).toBeVisible()
    await myth.getByRole('button', { name: 'Сыграть ещё раз' }).click()
    const second = await playMyth(page, h)
    h.expect(second.join('|'), 'та же колода').not.toBe(first.join('|'))
    await context.close()
  })

  await s.step('«Спросить Квасыча»: без ботов кнопок нет, реплики фрагмента, вопрос из поля уходит в чат', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.goto('/')
    const bot = page.locator('#bot')
    await bot.scrollIntoViewIfNeeded()
    h.expect(await bot.locator('a[href*="t.me"], a[href*="max.ru"]').count()).toBe(0)
    h.expect(await bot.locator('[data-remind]').count(), '«Напомнить о наборе» без бота').toBe(0)
    const text = plain(await bot.innerText())
    h.expect(botSample.length).toBe(2)
    for (const m of botSample) {
      h.expect(text).toContain(plain(m.q))
      for (const para of m.a.split(/\n\s*\n/)) h.expect(text).toContain(plain(para))
    }
    h.expect(await bot.getByRole('button', { name: /\?$/ }).count(), 'три готовых вопроса').toBe(3)
    const question = 'Сколько платят на складе за смену?'
    await bot.getByRole('textbox', { name: 'Вопрос Квасычу' }).fill(question)
    await bot.getByRole('button', { name: 'Спросить' }).click()
    const dialog = page.getByRole('dialog', { name: /Квасыч/ })
    await h.expect(dialog).toBeVisible()
    await h.expect(dialog.getByText(question, { exact: true })).toBeVisible()
    await context.close()
  })

  await s.step('«Спросить Квасыча»: боты из /api/config, метка источника в start', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.route('**/api/config', (r) => r.fulfill({ json: { bots: { telegram: 'ochakovo_test_bot', max: 'id7700_bot' }, assistant: 'offline' } }))
    await page.goto('/?src=fair-mgupp')
    const bot = page.locator('#bot')
    await bot.scrollIntoViewIfNeeded()
    await h.expect(bot.getByRole('link', { name: 'Квасыч в Telegram' })).toHaveAttribute('href', 'https://t.me/ochakovo_test_bot?start=fair-mgupp')
    await h.expect(bot.getByRole('link', { name: 'Квасыч в MAX' })).toHaveAttribute('href', 'https://max.ru/id7700_bot?start=fair-mgupp')
    // «Напомнить о наборе» — диплинк remind-<метка>, рядом с ботами и тише их
    await h.expect(bot.getByRole('link', { name: 'Напомнить о наборе в Telegram' })).toHaveAttribute('href', 'https://t.me/ochakovo_test_bot?start=remind-fair-mgupp')
    await h.expect(bot.getByRole('link', { name: 'Напомнить о наборе в MAX' })).toHaveAttribute('href', 'https://max.ru/id7700_bot?start=remind-fair-mgupp')
    await context.close()
  })

  await s.step('заголовки секций видны: после прокрутки и при уменьшении движения сразу', async () => {
    for (const reduce of [false, true]) {
      const { context, page } = await h.open(s, { ...h.MOBILE, reducedMotion: reduce ? 'reduce' : 'no-preference' })
      await page.goto('/', { waitUntil: 'networkidle' })
      if (!reduce) {
        await h.readThrough(page)
        await page.waitForTimeout(1200)
      }
      // Заголовок спрятан, пока у него класс reveal (сдвиг и маска); после появления класс снимается
      const hidden = await page.evaluate(() =>
        ['practice', 'shift', 'money', 'quiz', 'conditions', 'path', 'game', 'vacancies', 'history', 'mentors', 'bot', 'faq'].flatMap((id) => {
          const h2 = document.querySelector(`#${id} h2`)
          if (!h2) return [`${id}: нет h2`]
          const cs = getComputedStyle(h2)
          if (h2.classList.contains('reveal')) return [`${id}: ещё спрятан (${cs.transform})`]
          return Number(cs.opacity) < 1 || cs.visibility === 'hidden' || cs.transform !== 'none' ? [`${id}: opacity ${cs.opacity}, transform ${cs.transform}`] : []
        }),
      )
      h.none(hidden, `невидимые заголовки${reduce ? ' при уменьшении движения' : ''}`)
      await context.close()
    }
  })

  return [s]
}
