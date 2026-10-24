// Первый экран и общее для главной: слова кейса и читаемый заголовок на ноутбуках, сумма с первым кадром,
// «Позвать друга» с личным кодом, остановка лент, ₽ и стрелки своими шрифтами, шов-ленты, появление заголовков,
// плавная прокрутка без вечного цикла. Только он: E2E_ONLY=home-hero pnpm test:e2e

import type { Page } from 'playwright'
import sharp from 'sharp'
import type { E2eHarness } from './_harness'

/**
 * Головы с волосами на кадре первого экрана (photos-src/excursion.jpg, 2280×1520 px), слева направо — с запасом
 * в несколько пикселей. По ним проверяем, что буквы заголовка не ложатся на лица
 */
const FACES: [number, number, number, number][] = [
  [100, 390, 190, 505],
  [335, 435, 425, 535],
  [430, 432, 525, 540],
  [505, 445, 575, 535],
  [595, 445, 700, 565],
  [712, 420, 790, 535],
  [760, 410, 850, 535],
  [905, 412, 1010, 540],
  [955, 335, 1045, 435],
  [995, 355, 1100, 495],
  [1090, 360, 1145, 465],
  [1135, 385, 1228, 495],
  [1420, 455, 1495, 565],
  [1455, 425, 1515, 495],
  [1425, 270, 1585, 435],
  [1650, 245, 1830, 435],
]
const FACES_FRAME = { w: 2280, h: 1520 }

/** Относительная яркость цвета sRGB (WCAG) */
const luminance = (r: number, g: number, b: number) => {
  const c = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

/**
 * Читаемость строк заголовка первого экрана по пикселям. Три снимка не нужны — хватает двух:
 * фон без букв (буквы прозрачные) и маска букв (всё скрыто, каждая строка своим каналом R, G или B на чёрном).
 * Пиксель буквы — покрытие маски от половины. Для каждого считаем контраст цвета строки с фоном под ним
 * и попадание в лица кадра. Возвращает по строке: долю пикселей ниже 3:1 и число пикселей на лицах
 */
async function headlineLegibility(page: Page) {
  const setup = await page.evaluate(
    ({ faces, frame }) => {
      const lines = [...document.querySelectorAll<HTMLElement>('section.hero h1 .hero-line, section.hero [data-hero-brand]')].filter((e) => e.getBoundingClientRect().height > 0).slice(0, 3)
      const info = lines.map((el, i) => {
        el.dataset.mask = 'rgb'[i]
        const [r, g, b] = (getComputedStyle(el).color.match(/[\d.]+/g) ?? []).map(Number)
        return { name: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), color: [r, g, b] as [number, number, number] }
      })
      // Лица в координатах окна: object-fit: cover, object-position и transform самого кадра
      const img = document.querySelector<HTMLImageElement>('section.hero .hero-img')
      if (!img || !img.naturalWidth) return { info, faces: [] as number[][] }
      const W = img.offsetWidth
      const H = img.offsetHeight
      const box = img.getBoundingClientRect()
      const k = box.width / W
      const ar = img.naturalWidth / img.naturalHeight
      const s = Math.max(W / ar, H)
      const [px, py] = getComputedStyle(img).objectPosition.split(' ').map((v) => parseFloat(v) / 100)
      const ox = (W - ar * s) * px
      const oy = (H - s) * py
      const at = (fx: number, fy: number) => [box.left + (ox + fx * ar * s) * k, box.top + (oy + fy * s) * k]
      return { info, faces: faces.map(([x1, y1, x2, y2]) => [...at(x1 / frame.w, y1 / frame.h), ...at(x2 / frame.w, y2 / frame.h)]) }
    },
    { faces: FACES, frame: FACES_FRAME },
  )
  const shoot = async (css: string) => {
    const tag = await page.addStyleTag({ content: css })
    await page.waitForTimeout(100)
    const png = await page.screenshot()
    await tag.evaluate((t) => (t as Element).remove())
    return sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  }
  const bg = await shoot('[data-mask], [data-mask] * { color: transparent !important; text-shadow: none !important; }')
  const mask = await shoot(`
    html, body { background: #000 !important; }
    body * { visibility: hidden !important; }
    [data-mask], [data-mask] * { visibility: visible !important; text-shadow: none !important; }
    [data-mask="r"], [data-mask="r"] * { color: #f00 !important; }
    [data-mask="g"], [data-mask="g"] * { color: #0f0 !important; }
    [data-mask="b"], [data-mask="b"] * { color: #00f !important; }
  `)
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-mask]').forEach((e) => delete e.dataset.mask))
  const { width, height } = bg.info
  const scale = width / (await page.evaluate(() => innerWidth))
  const faces = setup.faces.map((f) => f.map((v) => v * scale))
  return setup.info.map((line, ch) => {
    const textL = luminance(...line.color)
    let letters = 0
    let low = 0
    let onFaces = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3
        if (mask.data[i + ch] < 128) continue
        letters++
        const bgL = luminance(bg.data[i], bg.data[i + 1], bg.data[i + 2])
        if ((Math.max(textL, bgL) + 0.05) / (Math.min(textL, bgL) + 0.05) < 3) low++
        if (faces.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2)) onFaces++
      }
    return { name: line.name, letters, lowShare: letters ? low / letters : 1, onFaces }
  })
}

/** Неразрывные пробелы и невидимые символы типографа — в обычные пробелы */
const plain = (t: string) =>
  t
    .replace(/[  ]/g, ' ')
    .replace(/⁠/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Алфавит кода приглашения — как у бота (src/lib/ref.ts): без 0, 1, i, l, o */
const REF_LINK = /[?&]src=ref_[abcdefghjkmnpqrstuvwxyz23456789]{6}(?![a-z0-9])/

/** Текст виден в окне без прокрутки: элемент целиком внутри окна */
async function inFirstScreen(page: Page, text: string) {
  return page.evaluate(
    ({ text }) => {
      const norm = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ')
      const hero = document.querySelector('section.hero')
      if (!hero) return 'нет первого экрана'
      const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!norm(n.textContent ?? '').includes(text)) continue
        const el = n.parentElement!
        if (el.closest('.sr-only, [aria-hidden="true"]')) continue
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        if (r.top >= 0 && r.bottom <= innerHeight + 0.5) return ''
        return `«${text}» за экраном: ${Math.round(r.top)}–${Math.round(r.bottom)} при высоте ${innerHeight}`
      }
      return `«${text}» не найдено`
    },
    { text },
  )
}

/** Сколько раз сработал requestAnimationFrame за ms миллисекунд (счётчик ставит addInitScript) */
async function rafCalls(page: Page, ms: number) {
  const from = await page.evaluate(() => (window as unknown as { __raf: number }).__raf)
  await page.waitForTimeout(ms)
  return (await page.evaluate(() => (window as unknown as { __raf: number }).__raf)) - from
}

const countRaf = () => {
  const w = window as unknown as { __raf: number }
  const raf = window.requestAnimationFrame.bind(window)
  w.__raf = 0
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      w.__raf++
      cb(t)
    })
}

/** Идущие анимации с этим именем (CSS-анимации и переходы) */
const running = (page: Page, name: string) =>
  page.evaluate((name) => document.getAnimations().filter((a) => a.playState === 'running' && (a as CSSAnimation).animationName === name).length, name)

/** Анимации и переходы на слое зерна главной: их нет никогда */
const grainAnimations = (page: Page) => page.evaluate(() => document.querySelector('.grain')?.getAnimations().length ?? -1)

export default async (h: E2eHarness) => {
  const { expect } = h
  const s = new h.Scenario('home-hero: первый экран и движение', true)

  for (const [label, options] of [
    ['390×844', h.MOBILE],
    ['360×740', { ...h.MOBILE, viewport: { width: 360, height: 740 } }],
    ['1440×900', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: в первом экране без прокрутки «практика», «18», «с марта по сентябрь» и «Откликнуться»`, async () => {
      const { context, page } = await h.open(s, options)
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      const facts = plain((await page.locator('[data-hero-facts]').innerText()) ?? '')
      for (const word of ['практика', '18 лет', 'с марта по сентябрь']) expect(facts, `строка фактов: «${facts}»`).toContain(word)
      h.none((await Promise.all(['практика', '18 лет', 'с марта по сентябрь', 'Откликнуться'].map((t) => inFirstScreen(page, t)))).filter(Boolean), 'не в первом экране')
      await context.close()
    })
  }

  await s.step('ноутбуки 1024–1920: первый экран ровно по высоте окна, подпись ленты целиком, заголовок не выше 21 % высоты', async () => {
    const problems: string[] = []
    for (const [w, hh] of [
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1536, 864],
      [1920, 1080],
    ]) {
      const { context, page } = await h.open(s, { viewport: { width: w, height: hh } })
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      const r = await page.evaluate(() => {
        const hero = document.querySelector('section.hero')!.getBoundingClientRect()
        const caption = [...document.querySelectorAll('.hb-root span')].find((e) => /Найди/.test(e.textContent ?? '') && e.getBoundingClientRect().height)
        const line = [...document.querySelectorAll('section.hero h1 .hero-line span[style]')].find((e) => e.getBoundingClientRect().height) as HTMLElement | undefined
        return {
          hero: Math.round(hero.height),
          caption: caption ? Math.round(caption.getBoundingClientRect().bottom) : -1,
          font: line ? parseFloat(getComputedStyle(line).fontSize) : 0,
          vh: innerHeight,
        }
      })
      if (r.hero !== r.vh) problems.push(`${w}×${hh}: первый экран ${r.hero} px`)
      if (r.caption < 0 || r.caption > r.vh) problems.push(`${w}×${hh}: подпись ленты кончается на ${r.caption}`)
      if (r.font > r.vh * 0.21 + 0.5) problems.push(`${w}×${hh}: кегль заголовка ${r.font}`)
      await context.close()
    }
    h.none(problems, 'первый экран на ноутбуках')
  })

  await s.step('ноутбуки 1024–1920: у каждой строки заголовка не больше 5 % пикселей букв ниже 3:1, буквы не на лицах', async () => {
    const problems: string[] = []
    const report: string[] = []
    for (const [w, hh] of [
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1536, 864],
      [1920, 1080],
    ]) {
      const { context, page } = await h.open(s, { viewport: { width: w, height: hh } })
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      // Выезд строк и наезд кадра закончились, курсор не над первым экраном
      await page.mouse.move(0, 0)
      await page.waitForTimeout(800)
      const lines = await headlineLegibility(page)
      if (lines.length < 2) problems.push(`${w}×${hh}: строк заголовка ${lines.length}`)
      for (const l of lines) {
        report.push(`${w}×${hh} «${l.name}»: ниже 3:1 — ${(l.lowShare * 100).toFixed(1)} %, на лицах — ${l.onFaces} px`)
        if (l.letters < 1000) problems.push(`${w}×${hh} «${l.name}»: букв почти нет (${l.letters} px)`)
        if (l.lowShare > 0.05) problems.push(`${w}×${hh} «${l.name}»: ниже 3:1 — ${(l.lowShare * 100).toFixed(1)} % пикселей букв`)
        if (l.onFaces) problems.push(`${w}×${hh} «${l.name}»: ${l.onFaces} px букв на лицах`)
      }
      await context.close()
    }
    if (process.env.E2E_VERBOSE) console.log(report.join('\n'))
    h.none(problems, 'заголовок первого экрана')
  })

  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await s.step(`${reducedMotion === 'reduce' ? 'уменьшение движения' : 'обычный режим'}: сумма, «на руки», факты и кнопки — с первого кадра, без проявления и сдвига`, async () => {
      const { context, page } = await h.open(s, { ...h.MOBILE, reducedMotion })
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator('[data-hero-sum]').waitFor()
      const moving = await page.evaluate(() => {
        const sum = document.querySelector('[data-hero-sum]')!
        const els = [sum, sum.nextElementSibling!, document.querySelector('[data-hero-facts]')!, document.querySelector('.hero-apply')!]
        const out: string[] = []
        for (const el of els) {
          for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p)
            if (Number(cs.opacity) < 1) out.push(`${p.className}: opacity ${cs.opacity}`)
            if (cs.transform !== 'none' && !p.classList.contains('hero')) out.push(`${p.className}: transform ${cs.transform}`)
            if (p.getAnimations().length) out.push(`${p.className}: анимация`)
          }
        }
        return [...new Set(out)]
      })
      h.none(moving, 'сумма или кнопки двигаются')
      if (reducedMotion === 'reduce') expect(await page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName?.startsWith('hero-')).length)).toBe(0)
      await context.close()
    })
  }

  await s.step('«Позвать друга» до заявки: в первом экране и в финале, ссылка с личным кодом', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    // Системное меню «Поделиться» подменяем: ссылку забираем из него
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: string[] }
      w.__shared = []
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { url?: string }) => void w.__shared.push(d.url ?? '') })
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    const hero = page.locator('section.hero').getByRole('button', { name: 'Позвать друга' })
    await expect(hero).toBeVisible()
    await hero.click()
    await page.locator('#final').scrollIntoViewIfNeeded()
    const final = page.locator('#final').getByRole('button', { name: 'Позвать друга' })
    await expect(final).toBeVisible()
    await final.click()
    const shared = await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared)
    expect(shared.length, 'ссылка не ушла в «Поделиться»').toBe(2)
    for (const url of shared) expect(url).toMatch(REF_LINK)
    expect(shared[0], 'у одного браузера один код').toBe(shared[1])
    await context.close()
  })

  await s.step('без системного меню ссылка с кодом копируется в буфер', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string }
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void (w.__copied = t) } })
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('section.hero').getByRole('button', { name: 'Позвать друга' }).click()
    await expect(page.locator('section.hero [role="status"]')).toContainText('Ссылка скопирована')
    expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toMatch(REF_LINK)
    await context.close()
  })

  await s.step('лента первого экрана: «Пауза» останавливает её, брак снимается и со стоящей ленты', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.hb-track').waitFor()
    // Курсор не над лентой — иначе она и так стоит
    await page.mouse.move(5, 100)
    expect(await running(page, 'hb-roll'), 'лента не едет').toBe(1)
    await page.locator('.hb-root').getByRole('button', { name: 'Пауза ленты' }).click()
    await page.mouse.move(5, 100)
    expect(await running(page, 'hb-roll'), 'после «Пауза» лента едет').toBe(0)
    expect(await running(page, 'hb-stripes')).toBe(0)
    // Брак, который сейчас на экране, — мышью; если на экране его нет, кнопкой для клавиатуры
    const spot = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.hb-root [data-defect]')].map((d) => d.getBoundingClientRect()).find((b) => b.left >= 0 && b.right <= innerWidth)
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })
    if (spot) await page.mouse.click(spot.x, spot.y)
    else {
      await page.locator('.hb-root').getByRole('button', { name: 'Снять брак с ленты' }).focus()
      await page.keyboard.press('Enter')
    }
    await expect(page.locator('.hb-root')).toContainText(/брак пойман/i)
    await page.locator('.hb-root').getByRole('button', { name: 'Пуск ленты' }).click()
    await page.mouse.move(5, 100)
    expect(await running(page, 'hb-roll'), 'после «Пуск» лента стоит').toBe(1)
    // Под курсором лента стоит сама
    await page.locator('.hb-root').hover({ position: { x: 300, y: 40 } })
    expect(await running(page, 'hb-roll'), 'под курсором лента едет').toBe(0)
    // И при фокусе с клавиатуры внутри ленты
    await page.mouse.move(5, 100)
    expect(await running(page, 'hb-roll'), 'курсор ушёл, а лента стоит').toBe(1)
    // Фокус после щелчка по «Пуск» — от мыши, он ленту не держит; снимаем его и идём клавишей
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    for (let i = 0; i < 40 && !(await page.evaluate(() => !!document.activeElement?.closest('.hb-root'))); i++) await page.keyboard.press(h.TAB)
    expect(await page.evaluate(() => !!document.activeElement?.closest('.hb-root')), 'Tab не дошёл до ленты').toBe(true)
    expect(await running(page, 'hb-roll'), 'при фокусе в ленте она едет').toBe(0)
    await context.close()
  })

  await s.step('/vacancies, 390, уменьшение движения: все факты строки видны целиком', async () => {
    const { context, page } = await h.open(s, { ...h.MOBILE, reducedMotion: 'reduce' })
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    const cut = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-ticker] li')]
      const shown = items.filter((li) => li.getBoundingClientRect().height)
      return {
        total: items.length,
        count: shown.length,
        cut: shown.map((li) => {
          const r = li.querySelector('span')!.getBoundingClientRect()
          return r.left < -0.5 || r.right > innerWidth + 0.5 ? li.textContent : ''
        }).filter(Boolean),
      }
    })
    // Число фактов задаёт страница вакансий; в спокойном режиме видна одна копия списка — каждый факт один раз
    expect(cut.count, 'фактов в строке').toBeGreaterThan(0)
    expect(cut.count, 'фактов в строке').toBe(cut.total / 2)
    h.none(cut.cut as string[], 'обрезаны')
    await context.close()
  })

  await s.step('/vacancies: «Пауза» останавливает бегущую строку', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.goto('/vacancies', { waitUntil: 'networkidle' })
    await page.mouse.move(5, 5)
    expect(await running(page, 'belt-roll'), 'строка не едет').toBe(1)
    await page.getByRole('button', { name: 'Пауза бегущей строки' }).click()
    await page.mouse.move(5, 5)
    expect(await running(page, 'belt-roll'), 'после «Пауза» строка едет').toBe(0)
    await context.close()
  })

  if (!h.isWebkit) {
    await s.step('₽ и стрелки — своими шрифтами: цена первого экрана, «≈ … ₽» в «Собери лето», стрелка финала', async () => {
      const { context, page } = await h.open(s, h.DESKTOP)
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.locator('#money').scrollIntoViewIfNeeded()
      await page.locator('#final').scrollIntoViewIfNeeded()
      await page.evaluate(() => document.fonts.ready)
      const cdp = await context.newCDPSession(page)
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      const problems: string[] = []
      // Кроме «только свои шрифты» — у ₽ и стрелки именно своё дополнение, у ≈ — Onest
      for (const [what, selector, own] of [
        ['цена первого экрана', '[data-hero-sum]', 'Ochakovo Display Signs'],
        ['«≈» в «Собери лето»', '[data-money-net] > span:first-child', 'Onest'],
        ['«₽» в «Собери лето»', '[data-money-net] > span:last-child', 'Ochakovo Display Signs'],
        ['стрелка финала', '#final a span[aria-hidden] > span:last-child', 'Ochakovo Display Signs'],
      ]) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
        if (!nodeId) {
          problems.push(`${what}: нет на странице`)
          continue
        }
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
        const alien = fonts.filter((f) => !/^(Sofia Sans|Ochakovo Display Signs|Onest)/.test(f.familyName))
        if (!fonts.length || alien.length || !fonts.some((f) => f.familyName === own)) problems.push(`${what}: ${fonts.map((f) => f.familyName).join(', ') || 'шрифтов нет'}`)
      }
      h.none(problems, 'чужие шрифты')
      await context.close()
    })
  }

  for (const [label, options] of [
    ['390', h.MOBILE],
    ['1440', h.DESKTOP],
  ] as const) {
    await s.step(`${label}: шов-ленты между одноцветными секциями — пустота не выше 140 px, в покое стоят, сдвигов вёрстки нет`, async () => {
      const { context, page } = await h.open(s, options)
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number }
        w.__cls = 0
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value
        }).observe({ type: 'layout-shift', buffered: true })
      })
      await page.goto('/', { waitUntil: 'networkidle' })
      // Сдвиги считаем от момента, когда шрифты уже на месте: подмена запасного шрифта — отдельная история (предзагрузка в index.html)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(500)
      await page.evaluate(() => void ((window as unknown as { __cls: number }).__cls = 0))
      await h.readThrough(page)
      await page.waitForTimeout(1000)
      const gaps = await page.evaluate(() => {
        const seen = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"], .sr-only')
        }
        const content = (sec: Element) => [...sec.querySelectorAll('h2,h3,p,li,span,svg,button,a,img,input,label')].filter(seen).map((e) => e.getBoundingClientRect())
        return [...document.querySelectorAll('.belt-seam')].map((seam) => {
          const r = seam.getBoundingClientRect()
          const prev = seam.previousElementSibling!
          const next = seam.nextElementSibling!
          return {
            pair: `${prev.id} → ${next.id}`,
            above: Math.round(r.top - Math.max(...content(prev).map((b) => b.bottom))),
            below: Math.round(Math.min(...content(next).map((b) => b.top)) - r.bottom),
          }
        })
      })
      // Шов — между соседними тёмными разделами: роликами и «Собери лето», «Путём кваса» и игрой
      expect(gaps.map((g) => g.pair)).toEqual(['shift → money', 'path → game'])
      h.none(gaps.filter((g) => g.above > 140 || g.below > 140).map((g) => `${g.pair}: ${g.above} / ${g.below} px`), 'пустота у шва')
      expect(await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest('.belt-seam')).length), 'шов движется в покое').toBe(0)
      expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls), 'CLS при прокрутке').toBe(0)
      // Заголовки секций, появившиеся при прокрутке, в покое без маски и сдвига
      expect(await page.evaluate(() => [...document.querySelectorAll('.reveal:not(.reveal-in)')].filter((e) => e.getClientRects().length).length), 'заголовки остались под маской').toBe(0)
      await context.close()
    })
  }

  await s.step('уменьшение движения: заголовки секций сразу на месте, зерно стоит', async () => {
    const { context, page } = await h.open(s, { ...h.DESKTOP, reducedMotion: 'reduce' })
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.mouse.wheel(0, 2400)
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => document.querySelectorAll('.reveal').length)).toBe(0)
    expect(await grainAnimations(page), 'зерно движется').toBe(0)
    await context.close()
  })

  await s.step('компьютер: колесо прокручивает плавно, в покое цикл кадров стоит, якоря работают', async () => {
    const { context, page } = await h.open(s, h.DESKTOP)
    await page.addInitScript(countRaf)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    await page.mouse.move(700, 450)
    await page.mouse.wheel(0, 900)
    // Зерно статично и во время прокрутки
    expect(await grainAnimations(page), 'зерно движется при прокрутке').toBe(0)
    await expect.poll(() => page.evaluate(() => scrollY), { message: 'колесо не прокрутило' }).toBeGreaterThan(400)
    // Плавная прокрутка доехала и встала: дальше кадров почти нет (чат сверяет положение раз в полсекунды)
    await page.waitForTimeout(2000)
    const idle = await rafCalls(page, 2000)
    expect(idle, `в покое ${idle} кадров за 2 с`).toBeLessThanOrEqual(8)
    // Шапка прячется при прокрутке вниз — чуть вверх, и она снова видна
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(800)
    await page.locator('header').getByRole('link', { name: 'Вопросы' }).first().click()
    await expect
      .poll(() => page.evaluate(() => Math.round(document.querySelector('#faq')!.getBoundingClientRect().top)), { message: 'переход к «Вопросам» не доехал', timeout: 6000 })
      .toBeLessThan(140)
    await context.close()
  })

  await s.step('телефон: плавной прокрутки нет (родная), в покое кадров нет', async () => {
    const { context, page } = await h.open(s, h.MOBILE)
    await page.addInitScript(countRaf)
    await page.goto('/#faq', { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)
    expect(await page.evaluate(() => document.documentElement.classList.contains('lenis')), 'Lenis на касаниях').toBe(false)
    const idle = await rafCalls(page, 3000)
    expect(idle, `в покое ${idle} кадров за 3 с`).toBeLessThanOrEqual(2)
    await context.close()
  })

  return [s]
}
