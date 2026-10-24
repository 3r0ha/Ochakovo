// Аналитика на сервере (w2-pl-4): при METRIKA_ID или VK_PIXEL_ID сервер ставит в страницу метатег analytics,
// а CSP открывает домены только того счётчика, чей ID задан. Без ID — CSP как раньше (снимок) и ни одного метатега.
// Метатег читает тот же разбор, что на сайте (src/lib/analytics.ts). Инлайн-сниппетов нет.
// Запуск: pnpm test w2-platform-analytics (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp, renderPage } from '../../server/app'
import { loadAdapters } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { analyticsFromEnv, csp } from '../../server/middleware/security'
import { analyticsIds } from '../../src/lib/analytics'
import { withTestDb } from './_db'

/** CSP без счётчиков — снимок. Поменялась политика — поменяйте снимок осознанно */
const SNAPSHOT =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''
const template = readFileSync('index.html', 'utf8')
/** Документ для analyticsIds: только querySelector метатега */
const docOf = (html: string) => ({
  querySelector: (sel: string) => {
    if (sel !== 'meta[name="analytics"]') return null
    const m = /<meta name="analytics" content='([^']*)' \/>/.exec(html)
    return m ? ({ getAttribute: (n: string) => (n === 'content' ? m[1] : null) } as unknown as Element) : null
  },
})

test('ID счётчиков из окружения: только цифры, прежнее имя VITE_METRIKA_ID, мусор — выключено', () => {
  assert.equal(analyticsFromEnv({}), null)
  assert.equal(analyticsFromEnv({ METRIKA_ID: ' ', VK_PIXEL_ID: '' }), null)
  assert.deepEqual(analyticsFromEnv({ METRIKA_ID: '12345678' }), { metrika: '12345678', vk: null })
  assert.deepEqual(analyticsFromEnv({ VITE_METRIKA_ID: '12345678' }), { metrika: '12345678', vk: null })
  assert.deepEqual(analyticsFromEnv({ VK_PIXEL_ID: '3456789' }), { metrika: null, vk: '3456789' })
  assert.equal(analyticsFromEnv({ METRIKA_ID: '123"><script>', VK_PIXEL_ID: 'abc' }), null, 'не номер — счётчика нет')
})

test('CSP: без ID — снимок; Метрика и пиксель VK — каждый своими доменами', () => {
  assert.equal(csp(null), SNAPSHOT)
  assert.equal(csp({ metrika: null, vk: null }), SNAPSHOT)

  const ym = csp({ metrika: '12345678', vk: null })
  for (const name of ['script-src', 'img-src', 'connect-src']) {
    assert.match(directive(ym, name), /https:\/\/mc\.yandex\.ru/, `Метрика: ${name}`)
    assert.doesNotMatch(directive(ym, name), /mail\.ru/, `без пикселя VK: ${name}`)
  }
  assert.match(directive(ym, 'script-src'), /https:\/\/yastatic\.net/)
  assert.match(directive(ym, 'connect-src'), /wss:\/\/mc\.yandex\.ru/)
  assert.match(ym, /frame-src https:\/\/mc\.yandex\.ru/)

  const vk = csp({ metrika: null, vk: '3456789' })
  for (const name of ['script-src', 'img-src', 'connect-src']) {
    assert.match(directive(vk, name), /https:\/\/top-fwz1\.mail\.ru/, `VK: ${name}`)
    assert.match(directive(vk, name), /https:\/\/top-fragment\.mail\.ru/, `VK: ${name}`)
    assert.doesNotMatch(directive(vk, name), /yandex/, `без Метрики: ${name}`)
  }
  assert.doesNotMatch(vk, /frame-src/)

  const both = csp({ metrika: '12345678', vk: '3456789' })
  assert.match(directive(both, 'script-src'), /mc\.yandex\.ru.*top-fwz1\.mail\.ru/)
  for (const policy of [ym, vk, both]) {
    assert.doesNotMatch(policy, /unsafe-eval/)
    assert.doesNotMatch(directive(policy, 'script-src'), /unsafe-inline/, 'инлайн-сниппетов нет')
    assert.match(policy, /media-src 'self'/)
  }
})

test('метатег: при ID — один, читается сайтом; без ID и в панели HR — нет', () => {
  const ids = { metrika: '12345678', vk: '3456789' }
  const home = renderPage(template, '/', 'https://season.example.ru', {}, ids)
  assert.equal([...home.matchAll(/name="analytics"/g)].length, 1)
  assert.deepEqual(analyticsIds(docOf(home)), ids, 'src/lib/analytics.ts видит оба счётчика')
  const only = renderPage(template, '/vacancies', 'https://season.example.ru', {}, { metrika: null, vk: '3456789' })
  assert.deepEqual(analyticsIds(docOf(only)), { metrika: null, vk: '3456789' })
  assert.doesNotMatch(renderPage(template, '/', 'https://season.example.ru'), /name="analytics"/)
  assert.doesNotMatch(renderPage(template, '/hr', 'https://season.example.ru', {}, ids), /name="analytics"/, 'в панели HR счётчиков нет')
  assert.doesNotMatch(renderPage(template, '/hr/login', 'https://season.example.ru', {}, ids), /name="analytics"/)
  assert.doesNotMatch(home, /mc\.yandex\.ru|mail\.ru/, 'адресов счётчиков в странице нет: скрипты грузит сайт после согласия')
})

test('сервер: заголовок CSP и метатег — по окружению, без пересборки', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'w2-platform-analytics-'))
  try {
    writeFileSync(join(dist, 'index.html'), template)
    await withTestDb('w2-platform-analytics', async (sql) => {
      await new HrRepo(sql).createUser({ email: 'analytics@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
      const storage = new PostgresStorage(sql)
      const bots = await loadAdapters({})
      const app = (env: NodeJS.ProcessEnv) => createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', ...env }, distDir: dist })

      const off = await app({})
      const offPage = await off.request('/')
      assert.equal(offPage.headers.get('content-security-policy'), SNAPSHOT)
      assert.doesNotMatch(await offPage.text(), /name="analytics"/)
      assert.equal((await off.request('/api/health/live')).headers.get('content-security-policy'), SNAPSHOT)

      const on = await app({ METRIKA_ID: '12345678', VK_PIXEL_ID: '3456789' })
      const onPage = await on.request('/apply')
      const policy = onPage.headers.get('content-security-policy') ?? ''
      assert.match(directive(policy, 'script-src'), /mc\.yandex\.ru/)
      assert.match(directive(policy, 'script-src'), /top-fwz1\.mail\.ru/)
      assert.deepEqual(analyticsIds(docOf(await onPage.text())), { metrika: '12345678', vk: '3456789' })
      assert.doesNotMatch(await (await on.request('/hr')).text(), /name="analytics"/)

      const ymOnly = await app({ METRIKA_ID: '12345678' })
      const ymPolicy = (await ymOnly.request('/')).headers.get('content-security-policy') ?? ''
      assert.match(ymPolicy, /mc\.yandex\.ru/)
      assert.doesNotMatch(ymPolicy, /mail\.ru/)
      await new Promise((r) => setTimeout(r, 100))
    })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
