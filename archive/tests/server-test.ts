// Проверки платформы: здоровье, заголовки безопасности, CSP и счётчики, лимиты запросов, защита от чужих сайтов,
// JSON-ошибки, права кандидата, сжатие и кэш собранного сайта, ролики с Range (если есть dist — после vite build;
// DIST_DIR — своя папка сборки).
// Нужна база: TEST_DATABASE_URL или DATABASE_URL (по умолчанию ochakovo_test). Запуск: pnpm test:server

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { CONSENT_VERSION } from '../shared/applications'
import { createApp } from '../server/app'
import { csp } from '../server/middleware/security'
import { loadAdapters, type Registry } from '../server/channels/registry'
import { connect, migrate, PostgresStorage } from '../server/db'
import type { RateRule } from '../server/middleware/rate-limit'

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://localhost:5432/ochakovo_test'
const dist = (process.env.DIST_DIR || 'dist').replace(/\/+$/, '')
process.env.TRUST_PROXY = '1'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, details?: unknown) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`, details ?? '')
  }
}

const sql = connect(url)
try {
  await migrate(sql)
} catch (e) {
  console.error(`Нет доступа к базе ${url.replace(/\/\/[^@]*@/, '//***@')}: ${(e as Error).message}`)
  console.error('Создайте тестовую базу: createdb ochakovo_test (или задайте TEST_DATABASE_URL)')
  process.exit(1)
}
const storage = new PostgresStorage(sql)
const bots = await loadAdapters({})

// Маленькие лимиты, чтобы проверить 429 за пару запросов
const rules: RateRule[] = [
  { name: 'applications', burst: 2, perMinute: 1, match: (m, p) => m === 'POST' && p === '/api/applications' },
  { name: 'api', burst: 1000, perMinute: 1000, match: (_m, p) => p.startsWith('/api/') && !p.startsWith('/api/health') },
]
const app = await createApp({
  storage,
  engine: null,
  bots,
  hrToken: 'test-token',
  env: { ...process.env, NODE_ENV: 'test', SITE_URL: 'https://season.example.ru', GIGACHAT_AUTH_KEY: '', YANDEX_DISK_TOKEN: '', YANDEX_DISK_REFRESH_TOKEN: '', METRIKA_ID: '', VITE_METRIKA_ID: '', VK_PIXEL_ID: '' },
  rateRules: rules,
  distDir: dist,
})

const from = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { 'x-forwarded-for': ip, ...(init.headers ?? {}) } })

console.log('Здоровье')
{
  const live = await app.request('/api/health/live')
  check('live — 200', live.status === 200)
  // Готовность честная: без движка диалогов сервер не готов, даже если база отвечает
  const ready = await app.request('/api/health/ready')
  const readyBody = (await ready.json()) as { status: string; db: { ok: boolean }; engine?: boolean }
  check('ready без движка диалогов — 503, база отвечает', ready.status === 503 && readyBody.db.ok && readyBody.engine === false, readyBody)
  const withEngine = await createApp({ storage, engine: { handle: async () => ({ messages: [] }) } as never, bots, hrToken: '', env: { NODE_ENV: 'test' }, rateRules: rules })
  const readyOk = await withEngine.request('/api/health/ready')
  check('ready с движком — 200', readyOk.status === 200, await readyOk.json())
  const full = await app.request('/api/health')
  const body = (await full.json()) as Record<string, unknown>
  check('health — статус, версия, режим помощника', full.status === 200 && body.status === 'ok' && typeof body.version === 'string' && body.assistant === 'offline', body)
  const text = JSON.stringify(body)
  check('health — без секретов и адресов', !/token|password|postgres:\/\/|key/i.test(text), text)
}

console.log('Заголовки безопасности')
{
  const res = await app.request('/api/health/live')
  const h = res.headers
  const policy = h.get('content-security-policy') ?? ''
  check('CSP: только свой источник скриптов', policy.includes("script-src 'self'") && !policy.includes('unsafe-eval'), policy)
  check('CSP: запрет встраивания в чужие сайты', policy.includes("frame-ancestors 'none'"))
  check('nosniff, DENY, referrer-policy', h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && Boolean(h.get('referrer-policy')))
  check('номер запроса в ответе', /^[0-9a-f-]{36}$/.test(h.get('x-request-id') ?? ''))
  check('нет CORS-заголовков', !h.has('access-control-allow-origin'))
  const own = await app.request('/api/health/live', { headers: { 'x-request-id': 'trace-12345678' } })
  check('свой x-request-id сохраняется', own.headers.get('x-request-id') === 'trace-12345678')
}

console.log('Счётчики: CSP и метатег только при ID')
{
  // Снимок политики без счётчиков: поменялась — поменяйте снимок осознанно (и в scripts/tests/w2-platform-analytics.test.ts)
  const snapshot =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
    "connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  const off = (await app.request('/api/health/live')).headers.get('content-security-policy')
  check('без METRIKA_ID и VK_PIXEL_ID — CSP как в снимке', off === snapshot && csp(null) === snapshot, off)
  const withIds = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', METRIKA_ID: '12345678', VK_PIXEL_ID: '3456789' }, rateRules: rules })
  const on = (await withIds.request('/api/health/live')).headers.get('content-security-policy') ?? ''
  const scripts = on.split('; ').find((d) => d.startsWith('script-src')) ?? ''
  check('с ID — домены Метрики и пикселя VK в script-src, img-src, connect-src', /mc\.yandex\.ru/.test(scripts) && /top-fwz1\.mail\.ru/.test(scripts) && /img-src[^;]*mc\.yandex\.ru[^;]*top-fwz1/.test(on) && /connect-src[^;]*mc\.yandex\.ru[^;]*top-fwz1/.test(on), on)
  check('инлайн-скриптов CSP не разрешает и с ID', !/script-src[^;]*unsafe-inline/.test(on) && !on.includes('unsafe-eval'))
  const ymOnly = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', METRIKA_ID: '12345678' }, rateRules: rules })
  const ym = (await ymOnly.request('/api/health/live')).headers.get('content-security-policy') ?? ''
  check('только Метрика — доменов VK нет', ym.includes('mc.yandex.ru') && !ym.includes('mail.ru'), ym)
}

console.log('Права кандидата')
{
  const withdraw = await app.request('/api/applications/NOPE0000/withdraw', from('10.9.0.1', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-status-token': 'x'.repeat(32) } }))
  check('отзыв согласия с чужим ключом — 404', withdraw.status === 404, withdraw.status)
  const link = await app.request('/api/applications/NOPE0000/bot-link', from('10.9.0.2', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-status-token': 'x'.repeat(32) } }))
  check('ссылка на бота без ботов — 404', link.status === 404, link.status)
}

console.log('Чужие сайты')
{
  const body = JSON.stringify({ name: 'А' })
  const evil = await app.request('/api/applications', from('10.0.0.9', { method: 'POST', body, headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' } }))
  check('POST с чужого Origin — 403', evil.status === 403)
  const own = await app.request('/api/applications', from('10.0.0.8', { method: 'POST', body, headers: { origin: 'https://season.example.ru', 'content-type': 'application/json' } }))
  check('POST со своего Origin доходит до API (422 на неполную заявку)', own.status === 422, own.status)
  const noOrigin = await app.request('/api/applications', from('10.0.0.7', { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
  check('POST без Origin (сервер-сервер) доходит до API', noOrigin.status === 422, noOrigin.status)
}

console.log('Лимиты запросов')
{
  const post = (ip: string) =>
    app.request('/api/applications', from(ip, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
  const a = await post('10.0.0.1')
  const b = await post('10.0.0.1')
  const c = await post('10.0.0.1')
  check('третья заявка подряд с одного IP — 429', a.status !== 429 && b.status !== 429 && c.status === 429, [a.status, b.status, c.status])
  check('429 с Retry-After', Number(c.headers.get('retry-after')) > 0)
  const other = await post('10.0.0.2')
  check('другой IP не страдает', other.status !== 429, other.status)
  const health = await Promise.all(Array.from({ length: 20 }, () => app.request('/api/health/live', from('10.0.0.1'))))
  check('проверки здоровья не ограничены', health.every((r) => r.status === 200))
}

console.log('Страница о данных')
{
  const off = (await (await app.request('/api/privacy')).json()) as { yandex360: boolean }
  check('без токена Диска Яндекс 360 не упоминается', off.yandex360 === false, off)
  const withDisk = await createApp({ storage, engine: null, bots, hrToken: 'test-token', env: { NODE_ENV: 'test', YANDEX_DISK_TOKEN: 'x' }, rateRules: rules })
  const on = (await (await withDisk.request('/api/privacy')).json()) as { yandex360: boolean }
  check('с токеном Диска — упоминается', on.yandex360 === true, on)
}

console.log('Ошибки')
{
  const missing = await app.request('/api/nope')
  const body = (await missing.json()) as { error?: string }
  check('неизвестный путь API — JSON 404', missing.status === 404 && body.error === 'not_found', body)
  const unauthorized = await app.request('/api/applications', from('10.0.0.3'))
  check('HR-данные без входа закрыты', unauthorized.status === 401 || unauthorized.status === 403, unauthorized.status)
  // Слоты второй волны подключены, но пустые: неизвестный путь под /api/hr — тот же JSON 404, а не 401 от чужого middleware
  const slot = await app.request('/api/hr/no-such-section', from('10.0.0.4'))
  const slotBody = (await slot.json()) as { error?: string }
  check('неизвестный путь под /api/hr — JSON 404', slot.status === 404 && slotBody.error === 'not_found', [slot.status, slotBody])
}

console.log('Настройки сайта')
{
  const res = await app.request('/api/config')
  const body = (await res.json()) as Record<string, unknown>
  const bots = body.bots as Record<string, unknown> | undefined
  check(
    'GET /api/config — SiteConfig: bots.telegram и bots.max, режим помощника',
    res.status === 200 && !!bots && 'telegram' in bots && 'max' in bots && (body.assistant === 'offline' || body.assistant === 'gigachat'),
    body,
  )
  check('без ботов имён нет', bots?.telegram === null && bots?.max === null, bots)
  check('в настройках нет секретов', !/token|secret|password|key|postgres:/i.test(JSON.stringify(body)), body)
  check('кэш — минута', res.headers.get('cache-control') === 'public, max-age=60', res.headers.get('cache-control'))

  // Имя бота — только у поднявшегося адаптера и только если оно задано. Токены и секреты в ответ не попадают
  const registry = (active: string[]): Registry => ({ get: () => undefined, active: () => active, failed: () => [], start: () => {} })
  const secrets = { TELEGRAM_BOT_TOKEN: '123456:tg-secret-token', MAX_BOT_TOKEN: 'max-secret-token', TELEGRAM_WEBHOOK_SECRET: 'hook-secret', GIGACHAT_AUTH_KEY: 'giga-secret' }
  const config = async (active: string[], names: Record<string, string>) => {
    const a = await createApp({ storage, engine: null, bots: registry(active), hrToken: '', env: { NODE_ENV: 'test', ...secrets, ...names }, rateRules: rules })
    const r = await a.request('/api/config')
    return { text: await r.clone().text(), body: (await r.json()) as { bots: { telegram: string | null; max: string | null }; assistant: string } }
  }
  const both = await config(['telegram', 'max'], { TELEGRAM_BOT_USERNAME: '@ochakovo_kvasych_bot', MAX_BOT_NICK: 'id7712345678_bot' })
  check('оба адаптера работают и имена заданы — имена без @', both.body.bots.telegram === 'ochakovo_kvasych_bot' && both.body.bots.max === 'id7712345678_bot', both.body)
  check('с ключом GigaChat — помощник gigachat', both.body.assistant === 'gigachat', both.body)
  check('токены, секрет вебхука и ключ не попадают в ответ', Object.values(secrets).every((v) => !both.text.includes(v)) && !/secret|token/i.test(both.text), both.text)
  const tgOnly = await config(['telegram'], { TELEGRAM_BOT_USERNAME: 'ochakovo_kvasych_bot', MAX_BOT_NICK: 'id7712345678_bot' })
  check('MAX не поднялся — его имени нет, даже если ник задан', tgOnly.body.bots.telegram === 'ochakovo_kvasych_bot' && tgOnly.body.bots.max === null, tgOnly.body)
  const noName = await config(['telegram', 'max'], {})
  check('адаптер работает, имя не задано — null', noName.body.bots.telegram === null && noName.body.bots.max === null, noName.body)
  const link = await config(['telegram'], { TELEGRAM_BOT_USERNAME: 'https://t.me/ochakovo_kvasych_bot' })
  check('имя из ссылки t.me — без адреса', link.body.bots.telegram === 'ochakovo_kvasych_bot', link.body)
  const junk = await config(['telegram'], { TELEGRAM_BOT_USERNAME: 'бот кваса' })
  check('странное имя — как не заданное', junk.body.bots.telegram === null, junk.body)
}

console.log('Согласие на обработку данных')
{
  let n = 0
  const apply = (body: Record<string, unknown>) =>
    app.request('/api/applications', from(`10.7.0.${++n}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  const phone = `+7 917 ${String(Math.floor(1e6 + Math.random() * 8e6)).replace(/^(\d{3})(\d{2})(\d{2})$/, '$1-$2-$3')}`
  // Поля кейса обязательны для заявки с сайта; дата рождения — 20 лет назад от текущего момента
  const base = { name: 'Проверка согласия', phone, lastName: 'Проверкина', birthDate: new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10), school: 'МГУПП', startReady: 'now' }
  const missing = await apply(base)
  const missingBody = (await missing.json()) as { error?: string; errors?: Record<string, string> }
  check('без consent:true — 422 с ошибкой в поле consent', missing.status === 422 && missingBody.error === 'validation' && !!missingBody.errors?.consent, [missing.status, missingBody])
  const old = await apply({ ...base, consent: true, consentVersion: '0' })
  const oldBody = (await old.json()) as { errors?: Record<string, string> }
  check('неизвестная версия текста — 422', old.status === 422 && !!oldBody.errors?.consent, [old.status, oldBody])
  const ok = await apply({ ...base, consent: true, consentVersion: CONSENT_VERSION })
  const saved = (await ok.json()) as { id?: string }
  const [row] = saved.id
    ? await sql<{ consent_at: Date | null; consent_version: string; consent_source: string }[]>`select consent_at, consent_version, consent_source from applications where id = ${saved.id}`
    : []
  check(
    'с согласием — 201, в базе время, версия и источник «форма на сайте»',
    ok.status === 201 && !!row?.consent_at && row.consent_version === CONSENT_VERSION && row.consent_source === 'site_form',
    [ok.status, row],
  )
  const repeat = await apply({ ...base, consent: true, consentVersion: CONSENT_VERSION })
  const repeatText = await repeat.text()
  check('повтор того же телефона — 409 без номера и токена', repeat.status === 409 && repeatText === JSON.stringify({ error: 'already_applied' }), [repeat.status, repeatText])
}

console.log('Предзагрузка фото первого экрана')
{
  // Ссылки в index.html должны выбрать те же файлы, что запрашивает Hero, иначе фото качается дважды.
  // Имена кадров, медиазапрос и формулу sizes берём из самого Hero.tsx: поменяется там — тест покажет расхождение.
  const hero = readFileSync('src/home/Hero.tsx', 'utf8')
  const photos = JSON.parse(readFileSync('shared/photos.json', 'utf8')) as Record<string, { w: number; h: number; widths: number[] }>
  const portrait = hero.match(/const PORTRAIT = '([^']+)'/)?.[1]
  const landscape = hero.match(/\? portraitName : '([^']+)'/)?.[1]
  const narrow = hero.match(/const narrow = '([^']+)'/)?.[1]
  const formula = hero.match(/const sizesFor = [^{]*\{\s*const \{ w, h \} = photos\[name\]\s*return (`[^`]+`)/)?.[1]
  check('Hero.tsx читается: кадры, медиазапрос, формула sizes', !!(portrait && landscape && narrow && formula), { portrait, landscape, narrow, formula })
  if (portrait && landscape && narrow && formula) {
    const sizesFor = new Function('w', 'h', `return ${formula}`) as (w: number, h: number) => string
    const links = [...readFileSync('index.html', 'utf8').matchAll(/<link\b[^>]*\bdata-home-only\b[^>]*>/g)].map((m) => m[0])
    const expect = (name: string, media: string) => {
      const p = photos[name]
      const srcset = p?.widths.map((w) => `/photos/${name}-${w}.avif ${w}w`).join(', ')
      const link = links.find((l) => l.includes(`media="${media}"`)) ?? ''
      check(
        `${name}: media «${media}», imagesrcset и imagesizes как у Hero`,
        !!p && link.includes(`imagesrcset="${srcset}"`) && link.includes(`imagesizes="${sizesFor(p.w, p.h)}"`),
        { expected: { srcset, sizes: p && sizesFor(p.w, p.h) }, link },
      )
    }
    expect(portrait, narrow)
    expect(landscape, `not all and ${narrow}`)
    check('других предзагрузок фото нет', links.length === 2, links.length)
  }
}

if (existsSync(`${dist}/index.html`)) {
  console.log('Собранный сайт: сжатие и кэш')
  const asset = readdirSync(`${dist}/assets`).find((f) => /^index-.+\.js$/.test(f))
  const br = await app.request(`/assets/${asset}`, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } })
  const raw = readFileSync(`${dist}/assets/${asset}`)
  check(
    'скрипт отдаётся в brotli, кэш навсегда',
    br.headers.get('content-encoding') === 'br' &&
      br.headers.get('vary') === 'Accept-Encoding' &&
      br.headers.get('cache-control')?.includes('immutable') === true &&
      brotliDecompressSync(Buffer.from(await br.arrayBuffer())).equals(raw),
    Object.fromEntries(br.headers),
  )
  const gz = await app.request(`/assets/${asset}`, { headers: { 'accept-encoding': 'gzip' } })
  check('без brotli — gzip', gz.headers.get('content-encoding') === 'gzip' && gunzipSync(Buffer.from(await gz.arrayBuffer())).equals(raw))
  const plain = await app.request(`/assets/${asset}`)
  check('без Accept-Encoding — как есть, но с Vary', !plain.headers.get('content-encoding') && plain.headers.get('vary') === 'Accept-Encoding' && Buffer.from(await plain.arrayBuffer()).equals(raw))

  const home = await app.request('/', { headers: { 'accept-encoding': 'br' } })
  const homeHtml = brotliDecompressSync(Buffer.from(await home.arrayBuffer())).toString()
  check('главная: brotli, no-cache, есть предзагрузка фото', home.headers.get('content-encoding') === 'br' && home.headers.get('cache-control') === 'no-cache' && homeHtml.includes('rel="preload"'))
  const page = await app.request('/vacancies', { headers: { 'accept-encoding': 'gzip' } })
  const pageHtml = gunzipSync(Buffer.from(await page.arrayBuffer())).toString()
  check('другие страницы: gzip, без предзагрузки фото главной', page.headers.get('content-encoding') === 'gzip' && pageHtml.includes('<div id="root">') && !pageHtml.includes('rel="preload"'))
  const api = await app.request('/api/health', { headers: { 'accept-encoding': 'gzip' } })
  check('JSON API сжимается', api.headers.get('content-encoding') === 'gzip' && api.headers.get('vary')?.includes('Accept-Encoding') === true)
  const img = await app.request('/favicon.svg', { headers: { 'accept-encoding': 'br' } })
  check('картинки кэшируются на неделю', img.status === 200 && img.headers.get('cache-control') === 'public, max-age=604800', Object.fromEntries(img.headers))
  check('чанка vendor-gsap в сборке нет', !readdirSync(`${dist}/assets`).some((f) => f.startsWith('vendor-gsap')))

  // Чанк страницы — modulepreload в самой странице (манифест сборки), главная — без чужих чанков; /.vite наружу не отдаётся
  if (existsSync(`${dist}/.vite/manifest.json`)) {
    const manifest = JSON.parse(readFileSync(`${dist}/.vite/manifest.json`, 'utf8')) as Record<string, { file: string }>
    const html = async (path: string) => gunzipSync(Buffer.from(await (await app.request(path, { headers: { 'accept-encoding': 'gzip' } })).arrayBuffer())).toString()
    for (const [path, src] of [['/apply', 'src/pages/Apply.tsx'], ['/vacancies', 'src/pages/Vacancies.tsx'], ['/game', 'src/pages/Game.tsx'], ['/privacy', 'src/pages/Privacy.tsx']]) {
      const file = manifest[src]?.file
      check(`${path}: modulepreload на свой чанк`, !!file && (await html(path)).includes(`<link rel="modulepreload" crossorigin href="/${file}">`), file)
    }
    const homeHtml = await html('/')
    check('главная не предзагружает чанки других страниц', !/modulepreload[^>]*\/assets\/(Apply|Vacancies|Game|Privacy)-/.test(homeHtml))
    const hidden = await app.request('/.vite/manifest.json')
    check('/.vite/manifest.json — 404', hidden.status === 404, hidden.status)
  } else {
    check('в сборке есть манифест .vite/manifest.json (build.manifest)', false)
  }

  // Ролики «Смена изнутри»: Safari сначала спрашивает bytes=0-1 и ждёт 206
  const video = existsSync(`${dist}/video`) ? readdirSync(`${dist}/video`).find((f) => f.endsWith('.mp4')) : undefined
  if (video) {
    const probe = await app.request(`/video/${video}`, { headers: { range: 'bytes=0-1', 'accept-encoding': 'gzip, br' } })
    check(
      'ролик: Range 0-1 — 206, video/mp4, без сжатия, кэш 30 дней',
      probe.status === 206 &&
        probe.headers.get('content-type') === 'video/mp4' &&
        probe.headers.get('content-range')?.startsWith('bytes 0-1/') === true &&
        !probe.headers.get('content-encoding') &&
        probe.headers.get('accept-ranges') === 'bytes' &&
        /max-age=2592000/.test(probe.headers.get('cache-control') ?? ''),
      Object.fromEntries(probe.headers),
    )
    await probe.arrayBuffer()
  } else {
    check('в сборке есть ролики dist/video/*.mp4', false, 'public/video не скопировался в сборку')
  }
} else {
  console.log(`Собранный сайт: нет ${dist}, проверки сжатия пропущены (сначала vite build)`)
}

await sql.end({ timeout: 5 })
console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
process.exit(failed ? 1 : 0)
