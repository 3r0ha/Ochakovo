// Замер главной в собранном виде под троттлингом, как в аудите: RTT 150 мс, 1,6 Мбит/с, CPU ×4, телефон.
// Запуск: node scripts/perf.mjs [адрес] [прогонов]. Печатает медианы:
//   lcpMs, transferredKB, longestTaskMs, tbtMs, cls, loadMs — как раньше;
//   sumAfterFcpMs — через сколько после первой отрисовки (FCP) сумма первого экрана и «Откликнуться» видны
//     (в окне, непрозрачность не меньше 0,95); замер выборкой на каждом кадре requestAnimationFrame, 0 — в том же кадре;
//   sumAfterFcpReducedMs — то же при «уменьшить движение», reducedGapMs — разница двух режимов;
//   idle — 8 секунд покоя на /#faq (телефон и компьютер): сколько раз сработал requestAnimationFrame
//     и какие CSS-анимации идут. Вечный цикл — это сотни вызовов (кадр за кадром); в покое rafCalls около нуля.
// PERF_FILES=1 — ещё 25 самых тяжёлых файлов первого прогона.
//
// Большой список HR (hr, в том же отчёте): панель /hr на ноутбуке (1440×900, без троттлинга) с 5000 синтетических заявок.
// Ответы /api/hr/* подменяются в браузере (page.route), сервер и база не нужны, входить в панель не нужно:
//   firstRenderMs — от начала загрузки страницы до первой строки списка на экране;
//   searchMs — отклик поиска по номеру заявки: от последней буквы до новой строки в списке минус пауза набора
//     (SEARCH_DELAY_MS из src/components/hr/FilterBar.tsx), то есть сколько считает и рисует сам список;
//   emptyPollBytes — опрос «ничего не поменялось»: запрос с If-None-Match и ответ 304 без тела, заголовки в обе стороны.
// Цели: первая отрисовка до 1 с, поиск до 100 мс, пустой опрос до 5 КБ (поле ok).
// PERF_ONLY=hr — только этот замер (секунд двадцать); PERF_ONLY=home — только главная.
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { register } from 'tsx/esm/api'

const base = process.argv[2] ?? 'http://localhost:8787'
const runs = Number(process.argv[3] ?? 3)
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
const DESKTOP = { viewport: { width: 1440, height: 900 } }

/** Сеть и процессор как у слабого телефона в мобильной сети */
async function throttle(ctx, page) {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  return cdp
}

async function once(reducedMotion) {
  const b = await chromium.launch()
  const ctx = await b.newContext({ ...PHONE, reducedMotion })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    window.__perf = { lcp: 0, longest: 0, tbt: 0, cls: 0, sumVisible: 0 }
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__perf.longest = Math.max(window.__perf.longest, e.duration)
        window.__perf.tbt += Math.max(0, e.duration - 50)
      }
    }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value }).observe({ type: 'layout-shift', buffered: true })
    // Видимость суммы и «Откликнуться» на каждом кадре: в окне и непрозрачны (с учётом всех родителей)
    const shown = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) return false
      for (let p = el; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.95) return false
      }
      return true
    }
    const sample = (t) => {
      if (shown(document.querySelector('[data-hero-sum]')) && shown(document.querySelector('.hero-apply'))) window.__perf.sumVisible = t
      else if (t < 30000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const cdp = await throttle(ctx, page)
  let bytes = 0
  const files = []
  const urls = new Map()
  cdp.on('Network.responseReceived', (e) => urls.set(e.requestId, { url: e.response.url, enc: e.response.headers['content-encoding'] ?? e.response.headers['Content-Encoding'] ?? '' }))
  cdp.on('Network.loadingFinished', (e) => {
    bytes += e.encodedDataLength
    const u = urls.get(e.requestId)
    if (u) files.push({ url: u.url.replace(base, ''), kb: Math.round(e.encodedDataLength / 1024), enc: u.enc })
  })
  const t0 = Date.now()
  await page.goto(base + '/', { waitUntil: 'load', timeout: 120000 })
  const loadMs = Date.now() - t0
  await page.waitForTimeout(6000)
  const perf = await page.evaluate(() => ({ ...window.__perf, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0 }))
  await b.close()
  return {
    lcp: Math.round(perf.lcp),
    longest: Math.round(perf.longest),
    tbt: Math.round(perf.tbt),
    cls: +perf.cls.toFixed(3),
    kb: Math.round(bytes / 1024),
    loadMs,
    files,
    // Кадр, в котором сумма уже видна, раньше FCP или совпадает с ним — значит, она в кадре первой отрисовки: 0.
    // Сумма так и не стала видна — заведомо плохое число, чтобы медиана это показала
    sumAfterFcp: perf.sumVisible ? Math.max(0, Math.round(perf.sumVisible - perf.fcp)) : 99999,
  }
}

/** 8 секунд покоя на /#faq: счётчик вызовов requestAnimationFrame и идущие CSS-анимации */
async function idle(device) {
  const b = await chromium.launch()
  const ctx = await b.newContext(device)
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window)
    window.__raf = 0
    window.requestAnimationFrame = (cb) => raf((t) => { window.__raf++; cb(t) })
  })
  await throttle(ctx, page)
  await page.goto(base + '/#faq', { waitUntil: 'load', timeout: 120000 })
  // Переход к разделу, шрифты, ленивые картинки — успокоиться
  await page.waitForTimeout(6000)
  const start = await page.evaluate(() => window.__raf)
  await page.waitForTimeout(8000)
  const res = await page.evaluate((from) => ({
    rafCalls: window.__raf - from,
    running: [...new Set(document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName ?? a.constructor.name))],
  }), start)
  await b.close()
  return res
}

// ── Большой список HR ────────────────────────────────────────────────────
const HR_ROWS = 5000

/** 5000 заявок того же вида, что отдаёт /api/hr/desk: генератор демо-данных (shared/demo.ts) и пустые поля HR */
async function syntheticDesk() {
  register()
  const root = new URL('..', import.meta.url)
  const { demoApplications } = await import(new URL('shared/demo.ts', root).href)
  const { emptyHrFields } = await import(new URL('shared/applications.ts', root).href)
  const statuses = ['new', 'new', 'contacted', 'interview', 'hired', 'started', 'declined']
  const rows = demoApplications(HR_ROWS).map((a, i) => {
    const status = statuses[i % statuses.length]
    return { ...a, ...emptyHrFields(), status, statusUpdatedAt: a.createdAt, reached: ['new', status] }
  })
  return rows
}

async function hrScale() {
  const rows = await syntheticDesk()
  const body = JSON.stringify({ rows, erased: [] })
  const etag = '"perf-5000"'
  const delay = Number(readFileSync(new URL('../src/components/hr/FilterBar.tsx', import.meta.url), 'utf8').match(/SEARCH_DELAY_MS = (\d+)/)?.[1] ?? 150)
  const user = { id: 1, email: 'perf@ochakovo.test', name: 'Замер', role: 'admin', disabled: false, createdAt: new Date().toISOString(), lastLoginAt: null }
  const b = await chromium.launch()
  const ctx = await b.newContext(DESKTOP)
  const page = await ctx.newPage()
  // Те же заголовки, что у сервера (server/api/hr.ts, versioned): ETag, private no-cache, Vary
  const versionHeaders = { etag, 'cache-control': 'private, no-cache', vary: 'Cookie, X-HR-Token' }
  await page.route('**/api/hr/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/hr/me') return route.fulfill({ json: { user, channels: [], sms: null, demoTools: false } })
    if (path === '/api/hr/desk' || (path === '/api/hr/applications' && route.request().method() === 'GET')) {
      if ((route.request().headers()['if-none-match'] ?? '') === etag) return route.fulfill({ status: 304, headers: versionHeaders, body: '' })
      return route.fulfill({ status: 200, headers: { ...versionHeaders, 'content-type': 'application/json; charset=utf-8' }, body: path === '/api/hr/desk' ? body : JSON.stringify(rows) })
    }
    if (['/api/hr/staff', '/api/hr/views'].includes(path)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: { error: 'not_found' } })
  })
  await page.addInitScript(() => {
    window.__hr = { first: 0 }
    const sample = () => {
      if (document.querySelector('tbody tr')) window.__hr.first = performance.now()
      else if (performance.now() < 30000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.goto(base + '/hr', { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction(() => window.__hr.first > 0, null, { timeout: 30000 })
  const firstRenderMs = Math.round(await page.evaluate(() => window.__hr.first))
  const shown = await page.locator('tbody tr').count()

  // Поиск по номеру заявки из середины списка: время от ввода до перерисовки списка
  const target = rows[Math.floor(rows.length / 2)]
  const search = page.getByRole('searchbox', { name: 'Поиск' })
  await search.click()
  await page.evaluate(() => {
    const tbody = document.querySelector('tbody')
    window.__hr.input = 0
    window.__hr.changed = 0
    document.querySelector('input[type="search"]').addEventListener('input', () => (window.__hr.input = performance.now()))
    new MutationObserver(() => {
      if (window.__hr.input && !window.__hr.changed) requestAnimationFrame(() => (window.__hr.changed = performance.now()))
    }).observe(tbody, { childList: true, subtree: true })
  })
  await search.fill(target.id)
  await page.waitForFunction(() => window.__hr.changed > 0, null, { timeout: 10000 })
  const raw = await page.evaluate(() => window.__hr.changed - window.__hr.input)
  const found = await page.locator('tbody tr').count()
  const searchMs = Math.max(0, Math.round(raw - delay))

  // Пустой опрос: панель спрашивает список при возвращении на вкладку — ответ 304 без тела
  const poll = page.waitForResponse((r) => r.url().endsWith('/api/hr/desk') && r.status() === 304, { timeout: 10000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const res = await poll
  const sizes = await res.request().sizes()
  const emptyPollBytes = sizes.requestHeadersSize + sizes.requestBodySize + sizes.responseHeadersSize + sizes.responseBodySize
  await b.close()
  return {
    rows: rows.length,
    deskKB: Math.round(Buffer.byteLength(body) / 1024),
    firstRenderMs,
    shownRows: shown,
    searchMs,
    searchRawMs: Math.round(raw),
    searchDelayMs: delay,
    found,
    emptyPollBytes,
    ok: firstRenderMs < 1000 && searchMs < 100 && emptyPollBytes < 5 * 1024 && found >= 1,
  }
}

const only = process.env.PERF_ONLY
const report = {}
let results = []
if (only !== 'hr') {
  const reduced = []
  for (let i = 0; i < runs; i++) {
    results.push(await once('no-preference'))
    reduced.push((await once('reduce')).sumAfterFcp)
  }
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
  const med = (k) => median(results.map((r) => r[k]))
  const sumNormal = med('sumAfterFcp')
  const sumReduced = median(reduced)
  Object.assign(report, {
    lcpMs: med('lcp'),
    transferredKB: med('kb'),
    longestTaskMs: med('longest'),
    tbtMs: med('tbt'),
    cls: med('cls'),
    loadMs: med('loadMs'),
    sumAfterFcpMs: sumNormal,
    sumAfterFcpReducedMs: sumReduced,
    reducedGapMs: Math.abs(sumNormal - sumReduced),
    idle: { phone: await idle(PHONE), desktop: await idle(DESKTOP) },
  })
}
if (only !== 'home') report.hr = await hrScale()
console.log(JSON.stringify(report))
if (process.env.PERF_FILES && results[0]) for (const f of results[0].files.sort((a, b) => b.kb - a.kb).slice(0, 25)) console.log(`${String(f.kb).padStart(5)} KB ${f.enc.padEnd(3)} ${f.url}`)
