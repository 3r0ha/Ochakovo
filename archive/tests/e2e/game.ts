// «Поймай брак» в браузере: строка о работе в первом экране /game, этикетка «КВАС» на бутылках (знак «ОЧАКОВО»
// только на бутылках от 70 px), честный итог при нажатиях на всё подряд, масштаб завода, «Поделиться» с кодом
// приглашения, рекорд только растёт. Только он: E2E_ONLY=game pnpm test:e2e

import type { Page } from 'playwright'
import { formatRub, minMonthlyPay } from '../../shared/content/vacancies'
import type { E2eHarness } from './_harness'

const plain = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ').trim()

/** Бутылки на странице: размер обёртки и виден ли знак «ОЧАКОВО» на этикетке */
const bottles = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      const mark = el.querySelector('[data-wordmark]')
      return { h: Math.round(r.height), w: Math.round(r.width * 10) / 10, kvas: Boolean(el.querySelector('[data-kvas]')), mark: mark ? getComputedStyle(mark).display !== 'none' : false }
    }),
  )

export default async (h: E2eHarness) => {
  const s = new h.Scenario('game: «Поймай брак»', true)
  const expect = h.expect

  for (const [label, options] of [
    ['390', h.MOBILE],
    ['360×740', { ...h.MOBILE, viewport: { width: 360, height: 740 } }],
    ['1440', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: /game — «Играть» и правило в первом экране, под лентой «Летняя работа на этом заводе от … ₽ в месяц» и «Откликнуться», галочки нет`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/game')
      const vh = page.viewportSize()!.height
      // Пришли играть — кнопка и правило видны без прокрутки
      for (const el of [page.getByRole('button', { name: 'Играть' }), page.getByText('Жми на брак, нормальные пропускай')]) {
        const box = await el.boundingBox()
        expect(box && box.y + box.height <= vh, 'кнопка «Играть» или правило ниже первого экрана').toBe(true)
      }
      const job = page.locator('[data-game-job]')
      await expect(job).toBeVisible()
      expect(plain(await job.locator('p').innerText())).toBe(plain(`Летняя работа на этом заводе от ${formatRub(minMonthlyPay)} в месяц`))
      const apply = job.getByRole('link', { name: 'Откликнуться' })
      await expect(apply).toHaveAttribute('href', '/apply')
      await expect(page.locator('main input[type="checkbox"]')).toHaveCount(0)
      const o = await h.overflow(page)
      expect(o.scrolled, `горизонтальная прокрутка: ${o.out.join(', ')}`).toBe(0)
      await context.close()
    })

    await s.step(`${label}: этикетка «КВАС» на бутылках; ниже 70 px знака «ОЧАКОВО» нет`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/game')
      await page.locator('figure').first().waitFor()
      // Памятка под лентой: 64 px на телефоне, 80 px на ноутбуке
      const legend = await bottles(page, 'figure > span')
      expect(legend.length).toBe(4)
      for (const b of legend) {
        expect(b.kvas, '«КВАС» на этикетке').toBe(true)
        expect(b.w, 'пропорция бутылки').toBeCloseTo(b.h * 0.4, 0)
        expect(b.mark, `знак у бутылки ${b.h} px`).toBe(b.h >= 70)
      }
      // Демо-лента — крупные бутылки: знак виден
      const belt = (await bottles(page, 'span:has(> svg[viewBox="0 0 40 100"])')).filter((b) => b.h >= 70)
      expect(belt.length).toBeGreaterThan(0)
      for (const b of belt) expect(b.mark && b.kvas).toBe(true)
      expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('/favicon.svg')
      await context.close()
    })
  }

  await s.step('390: нажатия по всем бутылкам — разбор со «Снято N нормальных бутылок», без предложения работы; рекорд не падает', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('ochakovo.game.warmup', '1')
        // Прежний рекорд выше любого раунда: после смены он не должен уменьшиться
        localStorage.setItem('ochakovo.profile', JSON.stringify({ state: { conveyorBest: 9999, attachScore: true, muted: true }, version: 1 }))
      } catch {
        // about:blank без хранилища
      }
    })
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: { text?: string; url?: string }[] }
      w.__shared = []
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { text?: string; url?: string }) => void w.__shared.push(d) })
    })
    await page.goto('/game')
    await page.getByRole('button', { name: 'Играть' }).click()
    const result = page.locator('[data-game-scale]')
    const started = Date.now()
    while (!(await result.count()) && Date.now() - started < 40_000) {
      const points = await page.locator('[data-state="moving"]').evaluateAll((els) =>
        els.flatMap((e) => {
          const r = e.getBoundingClientRect()
          return r.left > 4 && r.right < innerWidth - 4 ? [{ x: r.left + r.width / 2, y: r.top + r.height * 0.6 }] : []
        }),
      )
      for (const p of points) await page.mouse.click(p.x, p.y)
      await page.waitForTimeout(100)
    }
    await expect(result).toBeVisible()
    const panel = plain(await result.locator('..').innerText())
    expect(panel).toMatch(/Снят[оа] \d+ нормальн(ых|ые|ая) бутыл/)
    expect(panel).not.toContain('снимает брак на выходе')
    expect(panel).not.toContain('Без единой ошибки')
    expect(panel).toMatch(/За 20 секунд мимо тебя проехал[аио]? \d+ бутыл[а-я]+\. Завод разливает до 70 000 бутылок в час, то есть до 389 за те же 20 секунд\./)
    await expect(page.locator('h3')).toContainText('Время вышло')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ochakovo.profile') ?? '{}').state?.conveyorBest)).toBe(9999)

    await page.getByRole('button', { name: 'Поделиться результатом' }).click()
    const shared = await page.evaluate(() => (window as unknown as { __shared: { text?: string; url?: string }[] }).__shared)
    expect(shared.length).toBe(1)
    // Вызов той же ленты: /game?c=<сид>-<очки>-<поймано>-<лишние>-<брака>&src=ref_<код>
    expect(shared[0].url).toMatch(/\/game\?c=[0-9a-z]{1,7}-\d+-\d+-\d+-\d+&src=ref_[a-z2-9]{6}$/)
    const mistakes = Number(plain(await page.locator('dt', { hasText: 'Лишние нажатия' }).locator('..').locator('dd').innerText()))
    expect(mistakes).toBeGreaterThanOrEqual(3)
    expect(shared[0].text).toContain(`лишних нажатий ${mistakes}`)
    await context.close()
  })

  return [s]
}
