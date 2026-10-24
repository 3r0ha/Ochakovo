// Вторая волна игры в браузере: викторина «7 вопросов об „Очаково“» (/game?t=quiz), лента по сиду и вызов
// другу (/game?c=…), картинка для сторис, события game_start и share. Только он: E2E_ONLY=w2-game pnpm test:e2e
// (и E2E_BROWSER=webkit — в движке Safari)

import type { Page } from 'playwright'
import { COMPANY_QUIZ_ROUND } from '../../shared/content/companyQuiz'
import { encodeChallenge } from '../../src/game/challenge'
import type { E2eHarness } from './_harness'

const plain = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ').trim()

/** Маяки воронки и «Поделиться» — в массивы страницы: что ушло и сколько раз */
const spyScript = () => {
  const w = window as unknown as { __beacons: string[]; __shared: { text?: string; url?: string }[] }
  w.__beacons = []
  w.__shared = []
  const record = (data: unknown) => {
    if (data instanceof Blob) void data.text().then((t) => w.__beacons.push(t))
    else w.__beacons.push(String(data))
  }
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: unknown) => (record(data), true) })
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { text?: string; url?: string }) => void w.__shared.push(d) })
  // Картинку для сторис — скачиванием: меню «Поделиться» с файлом в браузере без окна не открыть
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
  try {
    localStorage.setItem('ochakovo.game.warmup', '1')
  } catch {
    // about:blank без хранилища
  }
}

const events = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { __beacons: string[] }).__beacons)).map((b) => JSON.parse(b) as { type: string; task?: string; kind?: string })

/** Сыграть раунд, ничего не нажимая, и собрать ленту: номер слота → вид бутылки */
async function watchRound(page: Page) {
  const seen = new Map<number, string>()
  const result = page.locator('[data-game-scale]')
  const started = Date.now()
  while (!(await result.count()) && Date.now() - started < 40_000) {
    const now = await page.locator('[data-slot]').evaluateAll((els) => els.map((e) => [Number(e.getAttribute('data-slot')), e.getAttribute('data-kind') ?? '']))
    for (const [slot, kind] of now as [number, string][]) seen.set(slot, kind)
    await page.waitForTimeout(150)
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0])
}

export default async (h: E2eHarness) => {
  const expect = h.expect
  const quiz = new h.Scenario('w2-game: контрольные вопросы', true)

  for (const [label, options] of [['390', h.MOBILE], ['1440', h.DESKTOP]] as const) {
    await quiz.step(`${label}: /game?t=quiz — ${COMPANY_QUIZ_ROUND} вопросов, ответ — сразу объяснение, итог — счёт и ссылка на практику`, async () => {
      const { context, page } = await h.open(quiz, options)
      await page.addInitScript(spyScript)
      await page.goto('/game?t=quiz')
      await expect(page.locator('h1')).toBeVisible()
      expect(plain(await page.locator('h1').innerText()).toLowerCase()).toBe(`${COMPANY_QUIZ_ROUND} вопросов об «очаково»`)
      await expect(page).toHaveTitle(new RegExp(`^${COMPANY_QUIZ_ROUND} вопросов об «Очаково» — `))
      await expect(page.getByRole('link', { name: 'Викторина' })).toHaveAttribute('aria-current', 'page')
      // На ноутбуке первый вопрос и варианты — в первом экране
      if (label === '1440') {
        const box = await page.locator('[data-quiz-option]').first().boundingBox()
        expect(box && box.y + box.height <= page.viewportSize()!.height, 'варианты ниже первого экрана').toBe(true)
      }
      const keyboard = label === '1440'
      let right = 0
      for (let i = 0; i < COMPANY_QUIZ_ROUND; i++) {
        await expect(page.locator('[data-quiz-progress]')).toContainText(`${i + 1}/${COMPANY_QUIZ_ROUND}`)
        await expect(page.locator('[data-quiz-option="open"]')).toHaveCount(await page.locator('[data-quiz-option]').count())
        // На ноутбуке — клавишами 1–4, на телефоне — пальцем
        if (keyboard) await page.keyboard.press(String((i % 3) + 1))
        else await page.locator('[data-quiz-option]').nth(i % 3).tap()
        const feedback = page.locator('[data-quiz-feedback]')
        await expect(feedback).toBeVisible()
        await expect(page.locator('[data-quiz-option="right"]')).toHaveCount(1)
        await expect(page.locator('[data-quiz-option="right"]')).toContainText('Правильный ответ')
        const ok = (await feedback.getAttribute('data-quiz-feedback')) === 'right'
        if (ok) right++
        else await expect(page.locator('[data-quiz-option="wrong"]')).toContainText('Твой ответ')
        await expect(feedback).toContainText(ok ? 'Верно' : 'Неверно')
        await expect(feedback).toContainText('Источник:')
        const next = page.locator('[data-quiz-next]')
        await expect(next).toBeFocused()
        if (keyboard) await page.keyboard.press('Enter')
        else await next.tap()
      }
      const result = page.locator('[data-quiz-result]')
      await expect(result).toBeFocused()
      expect(plain(await result.innerText())).toContain(`${right} из ${COMPANY_QUIZ_ROUND} верных ответов`)
      await expect(page.locator('[data-quiz-practice] a[href="/vacancies#paid"]')).toHaveText(/Оплачиваемая практика/i)
      await expect(page.locator('[data-quiz-practice] a[href="/apply"]')).toBeVisible()
      expect(plain(await page.locator('[data-quiz-practice]').innerText())).toMatch(/от 56 000 до 70 000 ₽ в месяц до вычета налога/)
      await expect(page.locator('[data-quiz-review] li')).toHaveCount(COMPANY_QUIZ_ROUND - right)
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.companyQuiz') ?? '{}').state)
      expect(stored.best).toEqual({ score: right, total: COMPANY_QUIZ_ROUND })
      // Первый законченный раунд — одно событие воронки, без счёта
      await expect.poll(async () => (await events(page)).filter((e) => e.type === 'task_done').map((e) => e.task)).toEqual(['company'])
      const done = (await events(page)).filter((e) => e.type === 'task_done')
      expect(JSON.stringify(done)).not.toMatch(/score|best/)
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка: ${o.out.join(', ')}`).toBe(0)
      if (!h.isWebkit) h.none(await h.unnamedControls(context, page), 'элементы без подписи')
      h.none((await h.contrastProblems(page)).map((p) => `${p.text}: ${p.ratio} < ${p.need}`), 'контраст')
      // «Ещё раз» — новый раунд с первого вопроса
      await page.getByRole('button', { name: 'Ещё раз' }).click()
      await expect(page.locator('[data-quiz-progress]')).toContainText(`1/${COMPANY_QUIZ_ROUND}`)
      await expect(page.locator('[data-quiz-question]')).toBeFocused()
      await context.close()
    })
  }

  await quiz.step('1440: переключатель режимов на /game ведёт к вопросам, фокус — на новый заголовок', async () => {
    const { context, page } = await h.open(quiz, h.DESKTOP)
    await page.goto('/game')
    await expect(page.getByRole('link', { name: 'Поймай брак', exact: true }).first()).toBeVisible()
    await page.locator('main').getByRole('link', { name: 'Викторина' }).click()
    await expect(page).toHaveURL(/\/game\?t=quiz$/)
    await expect(page.locator('h1')).toBeFocused()
    await expect(page).toHaveTitle(new RegExp(`^${COMPANY_QUIZ_ROUND} вопросов об «Очаково» — `))
    await page.locator('main').getByRole('link', { name: 'Поймай брак' }).click()
    await expect(page).toHaveURL(/\/game$/)
    await expect(page).toHaveTitle(/^Поймай брак — /)
    await context.close()
  })

  const duel = new h.Scenario('w2-game: вызов другу и картинка для сторис', true)
  const c = encodeChallenge({ seed: 2718281828, score: 290, caught: 13, extra: 1, total: 14 })

  await duel.step('две вкладки с одним c: одинаковая лента по слотам; строка над лентой, сравнение и «Откликнуться вдвоём»; события', async () => {
    const [a, b] = await Promise.all([h.open(duel, h.MOBILE), h.open(duel, h.DESKTOP)])
    for (const x of [a, b]) await x.page.addInitScript(spyScript)
    await Promise.all([a.page.goto(`/game?c=${c}`), b.page.goto(`/game?c=${c}`)])
    for (const { page } of [a, b]) {
      expect(plain(await page.locator('[data-game-challenge]').innerText())).toBe('Тебе прислали результат: поймано 13 из 14, лишних 1. Лента та же.')
      await page.getByRole('button', { name: 'Играть' }).click()
    }
    const [beltA, beltB] = await Promise.all([watchRound(a.page), watchRound(b.page)])
    // Телефон и ноутбук видят разное число бутылок на ленте, но вид бутылки по номеру — один
    const common = beltA.filter(([slot]) => beltB.some(([s]) => s === slot))
    expect(common.length).toBeGreaterThan(15)
    for (const [slot, kind] of common) expect(beltB.find(([s]) => s === slot)![1], `слот ${slot}`).toBe(kind)
    for (const { page } of [a, b]) {
      await expect(page.locator('[data-game-compare]')).toBeVisible()
      expect(plain(await page.locator('[data-game-compare]').innerText())).toMatch(/^У тебя \d+, у приславшего 290\.$/i)
      await expect(page.getByRole('link', { name: 'Откликнуться вдвоём' })).toHaveAttribute('href', /\/apply\?(vacancy=bottling-operator&)?friend=1$/)
      // «Играть» — одно событие game_start; «Ещё раз» его не повторяет
      await page.getByRole('button', { name: 'Поделиться результатом' }).click()
      const shared = await page.evaluate(() => (window as unknown as { __shared: { url?: string }[] }).__shared)
      expect(shared.length).toBe(1)
      // Друг друга получает ту же ленту: сид в ссылке — из присланного вызова
      expect(shared[0].url).toMatch(new RegExp(`/game\\?c=${c.split('-')[0]}-\\d+-\\d+-\\d+-\\d+&src=ref_[a-z2-9]{6}$`))
      // Маяк читается из Blob асинхронно — ждём, пока событие «Поделиться» запишется
      await expect.poll(async () => (await events(page)).filter((e) => e.type === 'share').map((e) => e.kind)).toEqual(['game'])
      const list = await events(page)
      expect(list.filter((e) => e.type === 'game_start').length).toBe(1)
      expect(JSON.stringify(list)).not.toMatch(/score|caught/)
    }
    await a.context.close()
    await b.context.close()
  })

  await duel.step('неверный c молча не замечается: обычная игра без строки о присланном результате', async () => {
    const { context, page, problems } = await h.open(duel, h.MOBILE)
    for (const bad of ['zzzzzzzz-1-1-1', 'abc-999-1-0-2', '%3Cscript%3E', '']) {
      await page.goto(`/game?c=${bad}`)
      await expect(page.getByRole('button', { name: 'Играть' })).toBeVisible()
      await expect(page.locator('[data-game-challenge]')).toHaveCount(0)
    }
    h.none(problems.filter((p) => p.startsWith('исключение')), 'исключения на странице')
    await context.close()
  })

  await duel.step('«Сохранить картинку для сторис»: PNG 1080×1920 до 400 КБ', async () => {
    const { context, page } = await h.open(duel, h.DESKTOP)
    await page.addInitScript(spyScript)
    await page.goto(`/game?c=${c}`)
    await page.getByRole('button', { name: 'Играть' }).click()
    await expect(page.locator('[data-game-scale]')).toBeVisible({ timeout: 40_000 })
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-game-story]').click()])
    expect(download.suggestedFilename()).toMatch(/^poymay-brak-\d+\.png$/)
    const path = await download.path()
    const { readFileSync } = await import('node:fs')
    const png = readFileSync(path!)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1920])
    expect(png.length).toBeLessThanOrEqual(400 * 1024)
    await expect(page.getByRole('status').filter({ hasText: 'Картинка сохранена' })).toBeVisible()
    await context.close()
  })

  return [quiz, duel]
}
