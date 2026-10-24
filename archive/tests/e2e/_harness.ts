// Общее для сквозных проверок: класс сценария, помощники страниц и тип E2eHarness для сценариев-плагинов.
//
// Сценарий-плагин — файл scripts/e2e/<имя>.ts (без «_» и «.» в начале имени):
//
//   import type { E2eHarness } from './_harness'
//   export default async (h: E2eHarness) => {
//     const s = new h.Scenario('hr-desk: обзвон')
//     await s.step('вход', async () => { const { page } = await h.open(s, h.DESKTOP); await h.loginHr(page) })
//     return [s]
//   }
//
// scripts/e2e.ts запускает плагины по алфавиту после встроенных сценариев, на том же сервере и в той же
// одноразовой базе. E2E_ONLY=hr-desk — только этот плагин (через запятую — несколько, builtin — встроенные).

import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type postgres from 'postgres'
import type { Browser, BrowserContext, BrowserContextOptions, Cookie, Page } from 'playwright'
import { expect as baseExpect } from 'playwright/test'

export const expect = baseExpect.configure({ timeout: 10_000 })

let shotsDir = ''
/** Снимки упавших шагов — во временной папке: она создаётся при первом снимке, путь печатается в конце прогона */
export const shots = () => (shotsDir ||= mkdtempSync(join(tmpdir(), 'ochakovo-e2e-')))

/** E2E_BROWSER=webkit — движок Safari (как на iPhone); по умолчанию Chromium */
export const isWebkit = process.env.E2E_BROWSER === 'webkit'
/** В Safari Tab по умолчанию ходит только по полям и кнопкам, по всем элементам — Option+Tab */
export const TAB = isWebkit ? 'Alt+Tab' : 'Tab'

export const MOBILE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
export const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } }
export const sec = (ms: number) => (ms / 1000).toFixed(1)

// ── Сценарии и шаги ─────────────────────────────────────────────────────

export class Scenario {
  lines: string[] = []
  ok = true
  skipped = false
  ms = 0
  pages: Page[] = []
  skip(reason: string) {
    this.ok = false
    this.skipped = true
    this.lines.push(`  – пропущено: ${reason}`)
  }
  /** Ошибки консоли и сети по страницам — печатаются рядом с упавшим шагом */
  problems = new Map<Page, string[]>()
  /** independent — шаги не зависят друг от друга: после упавшего проверяем остальные */
  constructor(
    readonly name: string,
    readonly independent = false,
  ) {}

  /** Шаг сценария. В цепочке первый упавший шаг останавливает сценарий: следующие от него зависят */
  async step(title: string, fn: () => Promise<void>) {
    if (this.skipped || (!this.ok && !this.independent)) return
    const t = Date.now()
    try {
      await fn()
      this.lines.push(`  ✓ ${title} (${sec(Date.now() - t)} с)`)
    } catch (e) {
      this.ok = false
      const message = String((e as Error).message ?? e)
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 8)
        .map((l) => `      ${l}`)
        .join('\n')
      this.lines.push(`  ✗ ${title}\n${message}`)
      // Снимок страницы, на которой шёл шаг, — последней открытой в сценарии
      const page = this.pages.findLast((p) => !p.isClosed())
      if (page) {
        const file = join(shots(), `${this.name}-${title}.png`.replace(/[^\p{L}\p{N}.-]+/gu, '_'))
        await page.screenshot({ path: file }).catch(() => {})
        this.lines.push(`      снимок: ${file}`)
        const seen = this.problems.get(page) ?? []
        if (seen.length) this.lines.push(`      в консоли и сети:\n${seen.slice(-5).map((l) => `        ${l}`).join('\n')}`)
      }
    } finally {
      this.ms += Date.now() - t
    }
  }
}

/** Ошибки консоли, исключения и ответы 4xx/5xx страницы */
export function watch(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => {
    // Ответы 4xx/5xx пишем ниже с адресом — консольное «Failed to load resource» без адреса не дублируем
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text().slice(0, 200)}`)
  })
  page.on('pageerror', (e) => problems.push(`исключение: ${e.message.slice(0, 200)}`))
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)
  })
  return problems
}

/** Новый контекст браузера со страницей: адрес сайта, русская локаль, учёт ошибок для сценария */
export async function openPage(browser: Browser, baseURL: string, s: Scenario, options: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, baseURL, locale: 'ru-RU' })
  // tsx (esbuild) оборачивает функции в __name(...) — в код, который уходит в page.evaluate, тоже
  await context.addInitScript({ content: 'window.__name = (f) => f' })
  const page = await context.newPage()
  const problems = watch(page)
  s.pages.push(page)
  s.problems.set(page, problems)
  return { context, page, problems }
}

/** Список должен быть пустым; иначе — читаемая ошибка без диффа */
export function none(list: string[], title: string) {
  if (list.length) throw new Error(`${title} (${list.length}):\n${list.slice(0, 12).join('\n')}`)
}

/** Счётчик «Смена» в шапке (ссылка или кнопка — неважно): его подпись — точный прогресс, «Смена N из 4…» */
export const shiftLink = (page: Page) => {
  const header = page.locator('header')
  return header.getByRole('button', { name: /^Смена/ }).or(header.getByRole('link', { name: /^Смена/ })).first()
}
export async function shiftCount(page: Page) {
  const label = (await shiftLink(page).getAttribute('aria-label')) ?? ''
  const m = label.match(/(\d) из 4/)
  if (!m) throw new Error(`Не понял подпись смены: «${label}»`)
  return Number(m[1])
}

// ── Вход в HR-панель ────────────────────────────────────────────────────

/**
 * Вход администратора на открытой странице, после него страница на /hr. Первый вход — формой; дальше cookie той же
 * сессии: вход в HR ограничен пятью попытками с адреса, а все сценарии прогона идут с одного адреса
 */
export function hrLogin(admin: { email: string; password: string }) {
  let session: Cookie[] | null = null
  return async (page: Page) => {
    if (session) {
      await page.context().addCookies(session)
      // Сессию мог закрыть сценарий с выходом — тогда входим формой
      if ((await page.request.get('/api/hr/me')).ok()) {
        await page.goto('/hr')
        await page.waitForURL(/\/hr(\?|$)/)
        return
      }
      await page.context().clearCookies()
    }
    await page.goto('/hr/login')
    await page.getByRole('textbox', { name: 'Рабочая почта' }).fill(admin.email)
    await page.getByLabel('Пароль', { exact: true }).fill(admin.password)
    await page.getByRole('button', { name: 'Войти' }).click()
    await page.waitForURL(/\/hr(\?|$)/)
    session = await page.context().cookies()
  }
}

// ── Задания на главной ──────────────────────────────────────────────────

export async function doMoney(page: Page) {
  const money = page.locator('#money')
  // Практика идёт с марта или апреля до середины августа: сентябрь у роли по умолчанию недоступен, добавляем май
  const may = money.getByRole('group', { name: 'Месяцы' }).getByRole('button', { name: 'май' })
  await may.click()
  await expect(may).toHaveAttribute('aria-pressed', 'true')
  // «Подставить в заявку», после первого раза — «Обновить …»
  await money.getByRole('button', { name: /^(Подставить в заявку|Обновить)/ }).click()
}

/** Подбор работы: первый ответ на каждый вопрос. Возвращает название вакансии из итога */
export async function doQuiz(page: Page) {
  const quiz = page.locator('#quiz')
  for (let i = 1; i <= 4; i++) {
    await expect(quiz.getByText(`${i}/4`, { exact: true })).toBeVisible()
    await quiz.locator('ul li button').first().click()
  }
  const result = quiz.getByRole('heading', { name: /Тебе подойдёт/ })
  await expect(result).toBeVisible()
  // Если в «Собери лето» выбрана другая должность, итог спрашивает, какую отправить в заявке, — берём вакансию из подбора
  const pick = quiz.getByRole('group', { name: /Какую отправить в заявке/ })
  if (await pick.count()) {
    const fromQuiz = pick.getByRole('button', { name: /по подбору/ })
    await fromQuiz.click()
    await expect(fromQuiz).toHaveAttribute('aria-pressed', 'true')
  }
  return ((await result.innerText()).replace(/Тебе подойдёт/i, '').trim() || '').replace(/\s+/g, ' ')
}

export async function doMyth(page: Page) {
  const myth = page.locator('#myth')
  for (let i = 1; i <= 5; i++) {
    await myth.getByRole('button', { name: i % 2 ? 'Правда →' : '← Миф' }).click()
    await myth.getByRole('button', { name: i < 5 ? 'Следующий факт' : 'Итог' }).click()
  }
}

export async function doGame(page: Page) {
  const play = page.locator('#play')
  await play.getByRole('button', { name: 'Играть' }).click()
  // Тренировка: одна из двух бутылок без крышки, порядок случайный. Угадали — тренировка сама закрывается
  const first = play.getByRole('button', { name: 'Бутылка 1' })
  await first.click()
  const outcome = await Promise.race([
    first.waitFor({ state: 'detached' }).then(() => 'done', () => 'timeout'),
    play.getByText(/нормальная/).waitFor().then(() => 'wrong', () => 'timeout'),
  ])
  if (outcome === 'wrong') await play.getByRole('button', { name: 'Бутылка 2' }).click()
  await expect(first, 'тренировка не закрылась').toHaveCount(0)
  // Раунд засчитывается, только если пойман хоть один брак: жмём на бутылку с браком, как человек, — по её месту на ленте
  const defect = play.locator('[data-kind]:not([data-kind="ok"])[data-state="moving"]')
  const caught = play.locator('[data-kind]:not([data-kind="ok"])[data-state="caught"]')
  for (let tries = 0; tries < 200 && !(await caught.count()); tries++) {
    const box = await defect.first().boundingBox().catch(() => null)
    const stage = await play.locator('[data-kind]').first().evaluate((el) => el.parentElement!.getBoundingClientRect()).catch(() => null)
    if (box && stage && box.x > stage.left + 10 && box.x + box.width < stage.right - 10) await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7)
    else await page.waitForTimeout(100)
  }
  expect(await caught.count(), 'брак не пойман').toBeGreaterThan(0)
  // Отсчёт и раунд на 20 секунд, без ускорения: тестовых крючков в игре нет
  await expect(shiftLink(page)).toHaveAttribute('aria-label', /^Смена закрыта/, { timeout: 45_000 })
}

// ── Проверки страницы ───────────────────────────────────────────────────

/** Горизонтальная прокрутка и элементы, вылезающие за край экрана (не внутри обрезающих контейнеров) */
export async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    window.scrollTo(9999, window.scrollY)
    const scrolled = window.scrollX
    window.scrollTo(0, window.scrollY)
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        // Обрезающий контейнер или своя горизонтальная прокрутка (карусель) — не вылезает за страницу
        if (getComputedStyle(p).overflowX !== 'visible') return true
      }
      return false
    }
    const out: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[inert], [aria-hidden="true"], svg, script, style')) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${Math.round(r.left)}…${Math.round(r.right)}]`)
        if (out.length >= 5) break
      }
    }
    return { innerWidth: window.innerWidth, vw, scrolled, out }
  })
}

/** Контраст текста по WCAG AA: 4,5:1, крупный текст — 3:1. Учитывает полупрозрачный цвет и opacity родителей */
export async function contrastProblems(page: Page) {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number]
    // Цвета Tailwind v4 с прозрачностью приходят как oklab()/color-mix() — переводим в sRGB через canvas
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (c: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = c
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA
    const lum = ([r, g, b]: RGBA) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return (x + 0.05) / (y + 0.05)
    }
    /** Фон под элементом: непрозрачный слой ближайшего предка и полупрозрачные слои над ним; картинка — неизвестно */
    const background = (el: Element): RGBA | null => {
      const layers: RGBA[] = []
      for (let p: Element | null = el; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.backgroundImage !== 'none') return null
        const c = parse(cs.backgroundColor)
        if (c[3] > 0) layers.push(c)
        if (c[3] >= 0.99) break
      }
      let bg: RGBA = [255, 255, 255, 1]
      for (const l of layers.reverse()) bg = over(l, bg)
      return bg
    }
    const out: { text: string; ratio: number; need: number; where: string }[] = []
    const seen = new Set<Element>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || seen.has(el) || !n.textContent?.trim()) continue
      seen.add(el)
      if (el.closest('[aria-hidden="true"], [inert], script, style, noscript, option, :disabled, .sr-only')) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (!r.width || !r.height || cs.visibility === 'hidden') continue
      let opacity = 1
      for (let p: Element | null = el; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity)
      if (opacity < 0.05) continue
      const bg = background(el)
      if (!bg) continue
      const color = parse(cs.color)
      const fg = over([color[0], color[1], color[2], color[3] * opacity], bg)
      const size = parseFloat(cs.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
      const need = large ? 3 : 4.5
      const k = ratio(fg, bg)
      if (k + 0.005 < need) {
        const where = el.closest('section[id], header, footer, nav, form, [role="dialog"]')
        out.push({ text: n.textContent.trim().slice(0, 40), ratio: Math.round(k * 100) / 100, need, where: where ? where.id || where.tagName.toLowerCase() : 'body' })
      }
    }
    return out
  })
}

/** Интерактивные элементы без доступного имени — по дереву доступности самого браузера (только Chromium: нужен CDP) */
export async function unnamedControls(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: { ignored: boolean; role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[]
  }
  const roles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem'])
  const out: string[] = []
  for (const n of nodes) {
    if (n.ignored || !roles.has(n.role?.value ?? '') || n.name?.value?.trim()) continue
    let html = ''
    if (n.backendDOMNodeId) {
      const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId })) as { object: { objectId?: string } }
      if (object.objectId) {
        const r = (await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.outerHTML.slice(0, 140) }', returnByValue: true })) as { result: { value: string } }
        html = r.result.value
      }
    }
    out.push(`${n.role?.value}: ${html}`)
  }
  await cdp.detach()
  return out
}

/** Прокрутить страницу до конца: секции, которые проявляются при прокрутке, приходят в итоговое состояние */
export async function readThrough(page: Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 120))
    }
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, 300))
  })
}

// ── Контракт сценариев-плагинов ─────────────────────────────────────────

/** Что получает сценарий-плагин scripts/e2e/<имя>.ts */
export type E2eHarness = {
  browser: Browser
  /** Адрес сервера: http://localhost:<порт> */
  baseUrl: string
  /** Одноразовая база сервера — проверять, что дошло до PostgreSQL */
  sql: postgres.Sql
  dbUrl: string
  /** Администратор HR-панели этого прогона */
  admin: { email: string; password: string }
  Scenario: typeof Scenario
  /** Новый контекст браузера со страницей; ошибки консоли и 4xx/5xx копятся в problems и печатаются у упавшего шага */
  open: (s: Scenario, options: BrowserContextOptions) => Promise<{ context: BrowserContext; page: Page; problems: string[] }>
  /** Вход администратора на открытой странице: после него страница на /hr. Первый вход — формой, дальше — той же сессией */
  loginHr: (page: Page) => Promise<void>
  expect: typeof expect
  MOBILE: BrowserContextOptions
  DESKTOP: BrowserContextOptions
  TAB: string
  isWebkit: boolean
  doMoney: typeof doMoney
  doQuiz: typeof doQuiz
  doMyth: typeof doMyth
  doGame: typeof doGame
  shiftCount: typeof shiftCount
  shiftLink: typeof shiftLink
  overflow: typeof overflow
  unnamedControls: typeof unnamedControls
  contrastProblems: typeof contrastProblems
  readThrough: typeof readThrough
  none: typeof none
}

/** Тип экспорта по умолчанию у сценария-плагина */
export type E2ePlugin = (h: E2eHarness) => Promise<Scenario[]>

// ── Загрузка плагинов ───────────────────────────────────────────────────

/** Сценарии-плагины в папке: файлы *.ts без «_» и «.» в начале имени, по алфавиту. name — имя файла без .ts */
export function pluginFiles(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.startsWith('.'))
    .sort()
    .map((f) => ({ name: f.replace(/\.ts$/, ''), path: join(dir, f) }))
}

/**
 * Плагины по очереди: каждый получает тот же E2eHarness (сервер, база, браузер этого прогона) и возвращает свои сценарии.
 * Упавший при загрузке плагин — красный сценарий «<имя>: плагин», остальные идут дальше. wanted — фильтр E2E_ONLY по имени
 */
export async function pluginScenarios(h: E2eHarness, dir: string, wanted: (name: string) => boolean = () => true): Promise<Scenario[]> {
  const out: Scenario[] = []
  for (const file of pluginFiles(dir).filter((f) => wanted(f.name))) {
    try {
      const mod = (await import(pathToFileURL(file.path).href)) as { default?: unknown }
      if (typeof mod.default !== 'function') throw new Error('нет export default async (h: E2eHarness) => Scenario[]')
      const list = (await mod.default(h)) as unknown
      if (!Array.isArray(list) || !list.every((x) => x instanceof Scenario)) throw new Error('плагин вернул не массив Scenario: сценарии создаются через new h.Scenario(…)')
      out.push(...list)
    } catch (e) {
      const s = new Scenario(`${file.name}: плагин`)
      s.ok = false
      s.lines.push(`  ✗ не запустился: ${String((e as Error).message ?? e).split('\n').slice(0, 6).join('\n      ')}`)
      out.push(s)
    }
  }
  return out
}
