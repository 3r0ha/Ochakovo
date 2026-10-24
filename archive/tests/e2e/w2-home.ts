// Главная по полному кейсу (w2-home): блок оплачиваемой практики со слоганом и образом, «Смена изнутри» с роликами,
// история «Квас делают люди» с таймлайном и цифрами, наставники и Квасыч, контрольные вопросы рядом с заданиями,
// контроль качества в «Пути кваса» нарисованной линией. Только он: E2E_ONLY=w2-home pnpm test:e2e

import { brands, companyFigures, timeline } from '../../shared/content/company'
import { perks } from '../../shared/content/content'
import { dorm } from '../../shared/content/handbook'
import { paidPracticeInfo } from '../../shared/content/practice'
import { paidPractice } from '../../shared/content/vacancies'
import { LEGEND, legendParagraphs } from '../../src/home/legend'
import type { E2eHarness } from './_harness'

/** Неразрывные пробелы и невидимые символы типографа — в обычные пробелы */
const plain = (t: string) =>
  t
    .replace(/[  ]/g, ' ')
    .replace(/⁠/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const rub = (n: number) => n.toLocaleString('ru-RU').replace(/\s/g, ' ')

export default async (h: E2eHarness) => {
  const s = new h.Scenario('w2-home: главная по полному кейсу', true)

  for (const [label, options] of [
    ['390', h.MOBILE],
    ['1440', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: «Практика» — слоган, 4 отдела и 5 ролей с суммами, что даёт компания, кадр из ролика`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/')
      const section = page.locator('#practice')
      await section.scrollIntoViewIfNeeded()
      const text = plain(await section.innerText())
      // Заголовок рядом с суммой: h2 и строка суммы до вычета налога
      h.expect(plain(await section.locator('h2').innerText()).toLowerCase()).toBe('практика с наставником')
      h.expect(plain(await section.locator('[data-practice-sum]').innerText())).toBe(`от ${rub(paidPracticeInfo.payFrom)} до ${rub(paidPracticeInfo.payTo)} ₽ в месяц`)
      h.expect(text).toContain('до вычета налога')
      // Четыре отдела с пиктограммами брендбука и все пять ролей со своими суммами
      await h.expect(section.locator('[data-practice-unit]')).toHaveCount(4)
      await h.expect(section.locator('[data-practice-unit] [data-pictogram]')).toHaveCount(4)
      for (const v of paidPractice) {
        const row = section.getByRole('link', { name: new RegExp(v.title, 'i') })
        await h.expect(row).toContainText(`от ${rub(v.pay!.from)}`)
      }
      // Главные факты задачи w2-hm-c1
      for (const want of ['НАСТАВНИК', 'БЕЗ ИСПЫТАТЕЛЬНОГО СРОКА', `ОБЩЕЖИТИЕ ЗА ${rub(dorm.priceStudent)} ₽`, 'ОБЕД ЗА ПОЛЦЕНЫ', 'СПЕЦОДЕЖДА И МЕДОСМОТР', 'СКИДКА НА ПРОДУКЦИЮ'])
        h.expect(text.toUpperCase()).toContain(want)
      h.expect(text).toContain(plain(perks.find((p) => p.title === 'Спецодежда и медосмотр')!.text))
      h.expect(text).toContain('Бесплатная практика по договорённости')
      h.expect(text).not.toMatch(/ДМС|с первого дня|сезонная работа/i)
      // Кадр «наставник и новичок у пульта» загрузился
      const img = section.locator('figure img')
      await img.scrollIntoViewIfNeeded()
      await h.expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      h.expect(await img.getAttribute('alt')).toBeTruthy()
      await h.expect(section.getByRole('link', { name: /^Откликнуться/ })).toHaveAttribute('href', '/apply')
      await context.close()
    })
  }

  await s.step('«Смена изнутри»: три ролика, до нажатия видео не грузится, по нажатию идёт без звука, вне экрана — пауза', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    const mp4: string[] = []
    page.on('request', (r) => r.url().endsWith('.mp4') && mp4.push(r.url()))
    await page.goto('/', { waitUntil: 'networkidle' })
    const section = page.locator('#shift')
    await section.scrollIntoViewIfNeeded()
    await h.expect(section.locator('[data-shift-video]')).toHaveCount(3)
    await h.expect(section.locator('video')).toHaveCount(3)
    for (const v of await section.locator('video').all()) h.expect(await v.getAttribute('preload')).toBe('none')
    await page.waitForTimeout(500)
    h.expect(mp4, 'ролик загрузился без нажатия').toEqual([])
    // Ссылки на вакансии под роликами оператора и лаборанта
    await h.expect(section.getByRole('link', { name: /Оператор линии розлива/ })).toHaveAttribute('href', '/vacancies?open=bottling-operator')
    await h.expect(section.getByRole('link', { name: /Лаборант/ })).toHaveAttribute('href', '/vacancies?open=lab-chemist')
    await section.getByRole('button', { name: /Посмотреть смену: Оператор линии розлива/ }).click()
    const video = section.locator('[data-shift-video="bottling-operator"] video')
    await h.expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true)
    h.expect(await video.evaluate((el) => (el as HTMLVideoElement).muted), 'ролик со звуком').toBe(true)
    h.expect(mp4.length).toBeGreaterThan(0)
    await page.locator('#faq').scrollIntoViewIfNeeded()
    await h.expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
    await context.close()
  })

  for (const [label, options] of [
    ['390', h.MOBILE],
    ['1440', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: «Квас делают люди» — легенда дословно, годы таймлайна, «Очаково» сегодня в цифрах и бренды`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/')
      const history = page.locator('#history')
      await history.scrollIntoViewIfNeeded()
      const text = plain(await history.innerText())
      h.expect(plain(await history.locator('h2').innerText()).toLowerCase()).toBe(LEGEND.title.toLowerCase())
      h.expect(text).toContain(plain(legendParagraphs()[0]))
      for (const y of LEGEND.years) h.expect(text).toContain(plain(y.text))
      await h.expect(history.locator('[data-history-stop]')).toHaveCount(3)
      for (const t of timeline.filter((x) => x.id !== 'today')) await h.expect(history.locator(`[data-history-stop="${t.id}"]`)).toContainText(t.when)
      for (const f of companyFigures) h.expect(text).toContain(plain(f.value))
      for (const b of brands) h.expect(text.toUpperCase()).toContain(plain(b.name).toUpperCase())
      h.expect(text).not.toMatch(/пив|сидр|джин/i)
      await context.close()
    })
  }

  await s.step('390: наставники — три шага, Квасыч, «Спросить Квасыча» открывает чат с вопросом про наставника', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.goto('/')
    const mentors = page.locator('#mentors')
    await mentors.scrollIntoViewIfNeeded()
    const text = plain(await mentors.innerText())
    for (const sentence of [...LEGEND.mentor, LEGEND.kvasych]) h.expect(text).toContain(plain(sentence))
    for (const step of LEGEND.steps) h.expect(text.toLowerCase()).toContain(step)
    await mentors.getByRole('button', { name: 'Спросить Квасыча' }).click()
    const dialog = page.getByRole('dialog', { name: /Квасыч/ })
    await h.expect(dialog).toBeVisible()
    await h.expect(dialog.getByText('Кто будет учить?', { exact: true })).toBeVisible()
    await context.close()
  })

  for (const [label, options] of [
    ['390', h.MOBILE],
    ['1440', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: контрольные вопросы рядом с заданием «Правда или миф», ссылка на /game?t=quiz`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/')
      const card = page.locator('#myth [data-company-quiz]')
      await card.scrollIntoViewIfNeeded()
      await h.expect(card).toBeVisible()
      await h.expect(card).toContainText('вопросов об')
      await h.expect(card.getByRole('link', { name: /Проверить себя/ })).toHaveAttribute('href', '/game?t=quiz')
      // Телефон: карточка после колоды «Правда или миф», а не между счётом и карточкой факта
      const [stack, quiz] = await Promise.all([page.locator('#myth article').first().boundingBox(), card.boundingBox()])
      if (label === '390') h.expect(quiz!.y).toBeGreaterThan(stack!.y + stack!.height - 1)
      await context.close()
    })
  }

  await s.step('«Путь кваса», контроль качества: нарисованная линия с браком и кнопка в «Поймай брак» — 1440 и 390', async () => {
    {
      const { context, page } = await h.open(s, h.DESKTOP)
      await page.goto('/')
      const path = page.locator('#path')
      await path.scrollIntoViewIfNeeded()
      await path.getByRole('tab', { name: /Контроль качества/ }).click()
      const fragment = page.locator('#path-panel [data-qc-fragment]')
      await h.expect(fragment).toBeVisible()
      const box = await fragment.boundingBox()
      h.expect(box!.height).toBeGreaterThan(200)
      await h.expect(fragment).toHaveAttribute('aria-label', /брак/)
      await h.expect(fragment).toContainText('Брак')
      await path.getByRole('button', { name: 'Попробовать в «Поймай брак»' }).click()
      await h.expect.poll(async () => (await page.locator('#play').boundingBox())!.y).toBeLessThan(500)
      await context.close()
    }
    {
      const { context, page } = await h.open(s, h.MOBILE)
      await page.goto('/')
      const fragment = page.locator('#path ol [data-qc-fragment]')
      await h.expect(fragment).toHaveCount(1)
      const box = await fragment.evaluate((el) => el.getBoundingClientRect().height)
      h.expect(box).toBeGreaterThan(150)
      await context.close()
    }
  })

  await s.step('390: вся главная без прокрутки вбок, пиктограммы на месте, без ДМС и алкоголя', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    const bad: string[] = []
    page.on('response', (r) => r.url().includes('/brand/pictograms/') && r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`))
    await page.goto('/', { waitUntil: 'networkidle' })
    await h.readThrough(page)
    await page.waitForLoadState('networkidle')
    h.none(bad, 'пиктограммы не загрузились')
    const r = await h.overflow(page)
    h.expect(r.scrolled, 'страница прокручивается вбок').toBe(0)
    h.none(r.out, 'за краем экрана')
    const body = plain(await page.locator('main').innerText())
    h.expect(body).not.toMatch(/ДМС|\bпиво|\bсидр|джин-тоник/i)
    await context.close()
  })

  return [s]
}
