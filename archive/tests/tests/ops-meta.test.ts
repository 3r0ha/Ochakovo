// Превью ссылок: у /, /vacancies, /game и /apply свои title, description и og-теги с абсолютной картинкой от SITE_URL,
// цифры — из shared; предзагрузка фото только на главной; robots.txt и sitemap.xml; честное описание в index.html.
// Запуск: pnpm test ops-meta (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { brotliDecompressSync } from 'node:zlib'
import { responsePromise } from '../../shared/candidateStatus'
import { formatRub, maxEntryPay, minMonthlyPay, scheduleSummary, vacancies } from '../../shared/content/vacancies'
import { createApp, GAME_SECONDS, renderPage } from '../../server/app'
import { loadAdapters } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { withTestDb } from './_db'

const SITE = 'https://season.example.ru'
const template = readFileSync('index.html', 'utf8')
/** Пробелы в числах и после предлогов — неразрывные; сравниваем текст без этой разницы */
const plain = (s: string) => s.replace(/&nbsp;| | /g, ' ')
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function metaOf(html: string) {
  const prop = (name: string) => {
    const m = html.match(new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]*)"`))
    return m ? decode(m[1]) : null
  }
  const all = (name: string) => [...html.matchAll(new RegExp(`<meta\\s+(?:property|name)="${name}"`, 'g'))].length
  return {
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
    titles: [...html.matchAll(/<title>/g)].length,
    description: prop('description'),
    descriptions: all('description'),
    ogTitle: prop('og:title'),
    ogTitles: all('og:title'),
    ogDescription: prop('og:description'),
    ogImage: prop('og:image'),
    ogImages: all('og:image'),
    ogUrl: prop('og:url'),
    ogLocale: prop('og:locale'),
    twitter: prop('twitter:card'),
    robots: prop('robots'),
    canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null,
    preloads: [...html.matchAll(/<link\b[^>]*\bdata-home-only\b/g)].length,
  }
}

test('index.html: честное описание с суммой из shared, ёлочки в title, общие og-теги', () => {
  const text = plain(template)
  for (const word of ['квест', 'пропуск в сезон', 'Пройди']) assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `в index.html нет «${word}»`)
  const m = metaOf(template)
  assert.match(m.title, /«Очаково»/, 'название в ёлочках')
  const sum = plain(formatRub(minMonthlyPay))
  assert.ok(plain(m.title).includes(sum), `в title сумма ${sum} из minMonthlyPay — после смены зарплат поправьте index.html`)
  assert.ok(plain(m.description ?? '').includes(`от ${sum} в месяц`), `в описании «от ${sum} в месяц»`)
  assert.match(m.description ?? '', /с 18 лет, без опыта, официально\. Задания на пару минут и заявка без резюме\.$/)
  assert.equal(m.ogLocale, 'ru_RU')
  assert.equal(m.twitter, 'summary_large_image')
  assert.equal(m.preloads, 2, 'предзагрузка фото первого экрана на месте')
})

test('renderPage: свои теги без повторов, абсолютные адреса, предзагрузка только на главной', () => {
  const paths = ['/', '/vacancies', '/game', '/apply']
  const pages = paths.map((p) => ({ path: p, ...metaOf(renderPage(template, p, `${SITE}/`, { home: 'abc' })) }))
  for (const p of pages) {
    assert.equal(p.titles, 1, `${p.path}: один title`)
    assert.equal(p.descriptions, 1, `${p.path}: одно описание`)
    assert.equal(p.ogTitles, 1, `${p.path}: один og:title`)
    assert.equal(p.ogImages, 1, `${p.path}: один og:image`)
    assert.match(p.title, /«Очаково»/, `${p.path}: название в ёлочках`)
    assert.equal(p.ogTitle, p.title)
    assert.ok(p.ogImage?.startsWith(`${SITE}/og/`), `${p.path}: og:image абсолютный от SITE_URL — ${p.ogImage}`)
    assert.equal(p.ogUrl, `${SITE}${p.path}`)
    assert.equal(p.canonical, `${SITE}${p.path}`)
    assert.equal(p.ogLocale, 'ru_RU')
    assert.equal(p.twitter, 'summary_large_image')
    assert.equal(p.robots, null, `${p.path}: страница открыта поиску`)
    assert.equal(p.preloads, p.path === '/' ? 2 : 0, `${p.path}: предзагрузка фото главной`)
    for (const s of [p.title, p.description ?? '']) assert.doesNotMatch(s, /!|\.\.\.|…|квест/, `${p.path}: без «!», многоточий и «квест»`)
  }
  assert.equal(new Set(pages.map((p) => p.title)).size, 4, 'у каждой страницы свой title')
  assert.equal(new Set(pages.map((p) => p.description)).size, 4, 'у каждой страницы своё описание')

  const [home, vac, game, apply] = pages
  const sum = plain(formatRub(minMonthlyPay))
  assert.ok(plain(home.description!).startsWith(`Летняя работа и оплачиваемая практика на заводе «Очаково» в Москве: от ${sum} в месяц`), home.description!)
  assert.equal(home.ogImage, `${SITE}/og/home.png?v=abc`, 'версия картинки в адресе')
  assert.ok(plain(vac.title).startsWith(`${vacancies.length} ваканси`), vac.title)
  assert.ok(plain(vac.description!).includes(`от ${minMonthlyPay.toLocaleString('ru-RU').replace(/ /g, ' ')} до ${plain(formatRub(maxEntryPay))}`), vac.description!)
  // nb() ставит неразрывный пробел после «по»; посреди фразы график — со строчной
  assert.ok(plain(vac.description!).toLowerCase().includes(plain(scheduleSummary.title).toLowerCase()), vac.description!)
  assert.match(plain(vac.description!), /^Оплачиваемая практика .+ Бесплатная практика по договорённости/)
  assert.equal(vac.ogImage, `${SITE}/og/vacancies.png`)
  assert.ok(game.title.startsWith(`Поймай брак · ${GAME_SECONDS} секунд`), game.title)
  assert.equal(game.ogImage, `${SITE}/og/game.png`)
  assert.ok(plain(apply.description!).includes(`${responsePromise('call')}.`), 'срок ответа HR — из shared/candidateStatus.ts')
  assert.equal(apply.ogImage, `${SITE}/og/home.png?v=abc`)

  // Длина раунда в превью совпадает с игрой
  const game2 = readFileSync('src/game/useConveyorGame.ts', 'utf8').match(/export const GAME_SECONDS = (\d+)/)?.[1]
  assert.equal(Number(game2), GAME_SECONDS, 'GAME_SECONDS в server/app.ts и src/game/useConveyorGame.ts')

  // Прочие страницы: превью главной без canonical; панель HR закрыта от поиска
  const other = metaOf(renderPage(template, '/privacy', SITE))
  assert.equal(other.canonical, null)
  assert.equal(other.ogUrl, null)
  assert.equal(other.ogImage, `${SITE}/og/home.png`)
  assert.equal(other.preloads, 0)
  assert.equal(metaOf(renderPage(template, '/hr', SITE)).robots, 'noindex, nofollow')
  assert.equal(metaOf(renderPage(template, '/hr/login', SITE)).robots, 'noindex, nofollow')
  assert.equal(metaOf(renderPage(template, '/vacancies/', SITE)).canonical, `${SITE}/vacancies`, 'хвостовой «/» — та же страница')
})

test('сервер: страницы, сжатие, robots.txt, sitemap.xml и картинки превью', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'ops-meta-'))
  try {
    copyFileSync('index.html', join(dist, 'index.html'))
    mkdirSync(join(dist, 'og'))
    copyFileSync('public/og/home.png', join(dist, 'og/home.png'))
    await withTestDb('ops-meta', async (sql) => {
      await new HrRepo(sql).createUser({ email: 'ops@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
      const storage = new PostgresStorage(sql)
      const bots = await loadAdapters({})
      const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: SITE }, distDir: dist })

      for (const path of ['/', '/vacancies', '/game', '/apply']) {
        const res = await app.request(path)
        assert.equal(res.status, 200, path)
        assert.match(res.headers.get('content-type') ?? '', /^text\/html/)
        assert.equal(res.headers.get('cache-control'), 'no-cache')
        const m = metaOf(await res.text())
        assert.ok(m.ogTitle && m.ogDescription, `${path}: og:title и og:description`)
        assert.ok(m.ogImage?.startsWith(`${SITE}/og/`), `${path}: og:image от SITE_URL`)
      }
      const home = metaOf(await (await app.request('/')).text())
      assert.match(home.ogImage ?? '', /^https:\/\/season\.example\.ru\/og\/home\.png\?v=[0-9a-f]{10}$/, 'хеш картинки в адресе')

      // brotli для главной — заранее, предзагрузка фото на месте; gzip для остальных — на лету
      const br = await app.request('/', { headers: { 'accept-encoding': 'gzip, deflate, br' } })
      assert.equal(br.headers.get('content-encoding'), 'br')
      assert.equal(br.headers.get('vary'), 'Accept-Encoding')
      const brHtml = brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()
      assert.equal(metaOf(brHtml).preloads, 2)
      assert.equal(metaOf(brHtml).ogTitle, home.ogTitle)
      const noBr = await app.request('/', { headers: { 'accept-encoding': 'gzip, br;q=0' } })
      assert.equal(noBr.headers.get('content-encoding'), 'gzip', 'br;q=0 — значит без brotli')
      const gz = await app.request('/game', { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(gz.headers.get('content-encoding'), 'gzip')

      const img = await app.request('/og/home.png')
      assert.equal(img.status, 200)
      assert.equal(img.headers.get('content-type'), 'image/png')
      assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin', 'превью забирают мессенджеры')
      assert.equal((await app.request('/api/health/live')).headers.get('cross-origin-resource-policy'), 'same-origin')

      const robots = await app.request('/robots.txt')
      assert.equal(robots.status, 200)
      const robotsText = await robots.text()
      assert.match(robotsText, /^Disallow: \/hr$/m)
      assert.match(robotsText, /^Disallow: \/api\/$/m)
      assert.match(robotsText, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, 'm'))

      const sitemap = await app.request('/sitemap.xml')
      assert.equal(sitemap.status, 200)
      assert.match(sitemap.headers.get('content-type') ?? '', /^application\/xml/)
      const xml = await sitemap.text()
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1])
      for (const p of ['/', '/vacancies', '/game', '/apply', '/privacy', '/consent']) assert.ok(locs.includes(`${SITE}${p}`), `${p} в карте сайта`)
      assert.ok(locs.every((l) => l.startsWith(`${SITE}/`)), 'адреса абсолютные')
      assert.ok(!locs.some((l) => l.includes('/hr')), 'панели HR в карте нет')

      // Без SITE_URL (разработка) адреса берутся из запроса
      const dev = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test' }, distDir: dist })
      assert.match(metaOf(await (await dev.request('http://localhost:8802/game')).text()).ogImage ?? '', /^http:\/\/localhost:8802\/og\/game\.png/)
      await new Promise((r) => setTimeout(r, 100))
    })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
