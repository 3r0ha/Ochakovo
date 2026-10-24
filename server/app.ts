import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants as zlib } from 'node:zlib'
import { serveStatic } from '@hono/node-server/serve-static'
import { responsePromise } from '@shared/candidateStatus'
import { steps } from '@shared/content/content'
import { formatRub, maxEntryPay, minMonthlyPay, scheduleSummary, vacancies, vacanciesVersion } from '@shared/content/vacancies'
import { Hono, type Context } from 'hono'
import { compress } from 'hono/compress'
import { createApi } from './api'
import type { Registry } from './channels/registry'
import type { PostgresStorage } from './db'
import { opsState, type OpsState } from './db/accessLog'
import type { DialogEngine } from './dialog/types'
import { log, requestLog } from './middleware/logging'
import { rateLimit, type RateRule } from './middleware/rate-limit'
import { analyticsFromEnv, analyticsMeta, originsFromEnv, sameOrigin, securityHeaders, type AnalyticsIds } from './middleware/security'
import { videoFiles } from './middleware/video'
import { providerName, smsFromEnv } from './sms'

// Приложение целиком: общие middleware → проверки здоровья → API → собранный сайт.
// index.ts только запускает его; тесты собирают то же приложение без сети (app.request).

type AppDeps = {
  storage: PostgresStorage
  engine: DialogEngine | null
  bots: Registry
  hrToken: string
  env?: NodeJS.ProcessEnv
  /** Подменить лимиты в тестах */
  rateRules?: RateRule[]
  /** Включена ли выгрузка заявок на Яндекс Диск. По умолчанию — есть ли токен Диска в окружении */
  yandexDiskSync?: () => boolean | Promise<boolean>
  /** Папка собранного сайта; по умолчанию dist/ в корне проекта. Тесты подкладывают свою */
  distDir?: string
}

const startedAt = Date.now()

async function version(): Promise<string> {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Проверка базы с ограничением по времени — зависшая база не должна вешать проверку здоровья */
async function checkDb(storage: PostgresStorage, timeoutMs = 2000) {
  const t = performance.now()
  try {
    await Promise.race([
      storage.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ])
    return { ok: true, ms: Math.round(performance.now() - t) }
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t) }
  }
}

/**
 * Что не так с SITE_URL в рабочей версии; null — всё в порядке. От адреса сайта зависят ссылки из бота,
 * превью ссылок, карта сайта и разрешённый источник запросов, поэтому без него сервер не стартует.
 * http допускается только для localhost и 127.0.0.1 — так идут сквозные проверки
 */
export function siteUrlProblem(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV !== 'production') return null
  const raw = env.SITE_URL?.trim()
  const example = 'например SITE_URL=https://season.ochakovo.ru'
  if (!raw) return `В рабочей версии (NODE_ENV=production) нужен SITE_URL — публичный адрес сайта с https://, ${example}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `SITE_URL не похож на адрес: «${raw}». Нужен полный адрес с https://, ${example}`
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return null
  return `SITE_URL должен начинаться с https:// (http — только для localhost и 127.0.0.1): сейчас «${raw}», ${example}`
}

// ── Превью ссылок ─────────────────────────────────────────────────────────
// Каждая публичная страница отдаёт свои title, description и og-теги: ссылка в мессенджере
// показывает сумму, задание или заявку, а не общий текст. Цифры — из shared, картинки — public/og (scripts/og.mjs).

/** Длина раунда «Поймай брак», секунд — как GAME_SECONDS в src/game/useConveyorGame.ts (сверяет scripts/tests/ops-meta.test.ts) */
export const GAME_SECONDS = 20

const plural = (n: number, forms: [string, string, string]) => {
  const d = n % 10
  const h = n % 100
  return forms[d === 1 && h !== 11 ? 0 : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 1 : 2]
}
/** Неразрывный пробел после коротких предлогов и союзов — превью не оставляет «в» в конце строки */
const nb = (s: string) => s.replace(/(?<=^|[\s«(])(в|во|и|с|со|на|за|от|до|без|к|о|у|по|не|из|а)\s/gi, '$1\u00A0')

export type PageMeta = {
  title: string
  description: string
  /** Имя картинки из public/og без расширения */
  image: 'home' | 'vacancies' | 'game'
  imageAlt: string
}

/** Сколько занимает заявка — из шагов на главной (shared/content/content.ts) */
const applyTime = steps.find((s) => s.title === 'Оставь заявку')?.time ?? '2 минуты'

let metaCache: { version: number; pages: Record<string, PageMeta> } | null = null

/**
 * Страницы со своим превью. Остальные адреса сайта получают превью главной без canonical.
 * Суммы и число вакансий — текущие: HR правит вакансии в панели (server/content/vacancies.ts), и превью
 * пересобирается по номеру версии правок (vacanciesVersion)
 */
export function pageMetas(): Record<string, PageMeta> {
  if (metaCache?.version === vacanciesVersion()) return metaCache.pages
  const range = `${minMonthlyPay.toLocaleString('ru-RU')}–${formatRub(maxEntryPay)}`
  const homeMeta: PageMeta = {
    title: `Работа на лето в «Очаково» — от ${formatRub(minMonthlyPay)} в месяц`,
    description: `Летняя работа и оплачиваемая практика на заводе «Очаково» в Москве: от ${formatRub(minMonthlyPay)} в месяц, с 18 лет, без опыта, официально. Задания на пару минут и заявка без резюме.`,
    image: 'home',
    imageAlt: `Работа на лето в «Очаково»: ${range} в месяц`,
  }
  const vacancyCount = `${vacancies.length} ${plural(vacancies.length, ['вакансия', 'вакансии', 'вакансий'])}`
  /** «Смены по 12 часов» посреди фразы — со строчной */
  const schedule = scheduleSummary.title.charAt(0).toLowerCase() + scheduleSummary.title.slice(1)
  const pages: Record<string, PageMeta> = {
    '/': homeMeta,
    '/vacancies': {
      title: `${vacancyCount} в «Очаково»: практика и работа`,
      // Оплачиваемая практика — 4 отдела по «Описанию практики»: лаборатория, цех розлива, технологический цех, склад
      description: `Оплачиваемая практика в лаборатории, цехах и на складе — от ${minMonthlyPay.toLocaleString('ru-RU')} до ${formatRub(maxEntryPay)} в месяц до вычета налога, ${schedule}. Бесплатная практика по договорённости и постоянная работа. Откликнуться можно без резюме.`,
      image: 'vacancies',
      imageAlt: `${vacancyCount} в «Очаково»: оплачиваемая практика — ${range} в месяц`,
    },
    '/game': {
      title: `Поймай брак · ${GAME_SECONDS} секунд — «Очаково»`,
      description: `Лента с квасом едет ${GAME_SECONDS} секунд: сними с неё бутылки без крышки, с недоливом и с кривой этикеткой. Результат можно приложить к заявке на летнюю работу в «Очаково».`,
      image: 'game',
      imageAlt: 'Поймай брак: лента с бутылками кваса, одна с недоливом',
    },
    '/focus': {
      title: 'Помоги выбрать слоган — анкета «Очаково»',
      description: 'Три слогана и шесть вопросов о практике на заводе «Очаково». Две минуты, анонимно.',
      image: 'home',
      imageAlt: homeMeta.imageAlt,
    },
    '/materials': {
      title: 'Материалы кейса «Очаково»: инструмент, концепция «Смена», мерч, ролики',
      description: 'Решение кейса «Открой#Моспром» для «Очаково» одной страницей: сайт, бот и HR-панель, концепция HR-бренда «Смена», листовки и стенд, коллекция мерча, короткие ролики и обоснование.',
      image: 'home',
      imageAlt: homeMeta.imageAlt,
    },
    '/apply': {
      title: 'Заявка на практику и работу в «Очаково»',
      description: `Заявка за ${applyTime}, резюме не нужно: ФИО, дата рождения, контакт, учёба и когда можно выйти. С 18 лет. ${responsePromise('call')}.`,
      image: 'home',
      imageAlt: homeMeta.imageAlt,
    },
  }
  metaCache = { version: vacanciesVersion(), pages }
  return pages
}

/** Публичные страницы для карты сайта */
export const sitemapPaths = ['/', '/vacancies', '/game', '/apply', '/privacy', '/consent']

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Адрес без хвостового «/» и без пути до страницы: https://season.ochakovo.ru */
const trimBase = (base: string) => base.replace(/\/+$/, '')

/** /vacancies/ и /vacancies — одна страница */
const normalPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') || '/' : path)

/** Страницы с отдельным чанком (src/App.tsx, lazy): чанк качается вместе с основным скриптом, а не после него */
export const pageChunks: Record<string, string> = {
  '/apply': 'src/pages/Apply.tsx',
  '/vacancies': 'src/pages/Vacancies.tsx',
  '/game': 'src/pages/Game.tsx',
  '/focus': 'src/pages/Focus.tsx',
  '/materials': 'src/pages/Materials.tsx',
  '/privacy': 'src/pages/Privacy.tsx',
  '/consent': 'src/pages/Consent.tsx',
}

type ManifestChunk = { file: string; imports?: string[] }

/**
 * modulepreload для страниц из манифеста сборки (dist/.vite/manifest.json, build.manifest в vite.config.ts):
 * чанк страницы и его зависимости, кроме тех, что index.html и так предзагружает. Путь страницы → адреса файлов
 */
export function pagePreloads(manifest: Record<string, ManifestChunk>): Record<string, string[]> {
  const closure = (key: string, seen = new Set<string>()) => {
    if (seen.has(key) || !manifest[key]) return seen
    seen.add(key)
    for (const dep of manifest[key].imports ?? []) closure(dep, seen)
    return seen
  }
  const entry = closure('index.html')
  const out: Record<string, string[]> = {}
  for (const [path, src] of Object.entries(pageChunks)) {
    if (!manifest[src]) continue
    out[path] = [...closure(src)].filter((k) => !entry.has(k)).map((k) => `/${manifest[k].file}`)
  }
  return out
}

/**
 * index.html для адреса path: свои title, description и og-теги, абсолютные ссылки от base.
 * Предзагрузка фото первого экрана (data-home-only) остаётся только на главной.
 * imageVersion — короткий хеш картинки: мессенджеры кэшируют превью по адресу, новая картинка получает новый адрес.
 * analytics — ID счётчиков (METRIKA_ID, VK_PIXEL_ID): метатег для сайта; в панели HR счётчиков нет.
 * preload — чанк страницы и его зависимости (pagePreloads): modulepreload рядом с предзагрузкой Vite
 */
export function renderPage(
  template: string,
  rawPath: string,
  base: string,
  imageVersion: Record<string, string> = {},
  analytics: AnalyticsIds | null = null,
  preload: string[] = [],
): string {
  const path = normalPath(rawPath)
  const hr = path === '/hr' || path.startsWith('/hr/')
  const metas = pageMetas()
  const own = metas[path]
  const meta = own ?? metas['/']
  const root = trimBase(base)
  const v = imageVersion[meta.image]
  const image = `${root}/og/${meta.image}.png${v ? `?v=${v}` : ''}`
  const tags = [
    `<title>${text(meta.title)}</title>`,
    `<meta name="description" content="${attr(nb(meta.description))}" />`,
    ...(own ? [`<link rel="canonical" href="${attr(root + (path === '/' ? '/' : path))}" />`] : []),
    // Рабочая панель HR в поиске не нужна; robots.txt закрывает её ещё и от обхода
    ...(hr ? ['<meta name="robots" content="noindex, nofollow" />'] : []),
    ...(analytics && !hr ? [analyticsMeta(analytics)] : []),
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Очаково" />',
    '<meta property="og:locale" content="ru_RU" />',
    ...(own ? [`<meta property="og:url" content="${attr(root + path)}" />`] : []),
    `<meta property="og:title" content="${attr(meta.title)}" />`,
    `<meta property="og:description" content="${attr(nb(meta.description))}" />`,
    `<meta property="og:image" content="${attr(image)}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${attr(meta.imageAlt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ')

  // Комментарии index.html — для разработчиков, посетителю они не нужны
  let html = template.replace(/[ \t]*<!--[\s\S]*?-->\n?/g, '')
  if (path !== '/') html = html.replace(/<link\b[^>]*\bdata-home-only\b[^>]*>\s*/g, '')
  // Общие теги из index.html убираем: у каждой страницы свои
  html = html
    .replace(/<meta\b[^>]*\b(?:name|property)="(?:description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/g, '')
    .replace(/<link\b[^>]*\brel="canonical"[^>]*>\s*/g, '')
  if (preload.length) {
    const links = preload.map((href) => `<link rel="modulepreload" crossorigin href="${attr(href)}">`).join('\n    ')
    html = html.replace('</head>', `    ${links}\n  </head>`)
  }
  return /<title>[\s\S]*?<\/title>/.test(html) ? html.replace(/<title>[\s\S]*?<\/title>/, tags) : html.replace('</head>', `    ${tags}\n  </head>`)
}

/** Карта сайта: только публичные страницы, адреса от SITE_URL */
export function sitemapXml(base: string): string {
  const root = trimBase(base)
  const urls = sitemapPaths.map((p) => `  <url><loc>${text(root + (p === '/' ? '/' : p))}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** Тот же запрет, что в public/robots.txt, — если файла нет ни в сборке, ни в public */
const defaultRobots = 'User-agent: *\nDisallow: /hr\nDisallow: /api/\nDisallow: /bots/\n'

const acceptsBrotli = (header: string | undefined) =>
  !!header && header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';')
    if (name.trim().toLowerCase() !== 'br') return false
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })

export async function createApp({ storage, engine, bots, hrToken, env = process.env, rateRules, yandexDiskSync, distDir }: AppDeps) {
  const app = new Hono()
  const isHttps = [env.PUBLIC_URL, env.SITE_URL].some((u) => u?.startsWith('https://'))
  // Счётчики Метрики и VK — только при заданных ID: метатег в странице и их домены в CSP
  const analytics = analyticsFromEnv(env)

  app.use('*', requestLog())
  app.use('*', securityHeaders({ analytics, hsts: env.NODE_ENV === 'production' && isHttps }))
  app.use('*', sameOrigin({ allowedOrigins: originsFromEnv(env) }))
  // gzip для JSON API и страниц; статика из сборки и brotli-страницы уже сжаты и сюда не попадают
  app.use('*', compress())
  app.use('*', rateLimit(rateRules))

  app.onError((err, c) => {
    log('error', 'unhandled', { rid: c.get('requestId'), path: c.req.path, error: err.message })
    return c.json({ error: 'internal', requestId: c.get('requestId') }, 500)
  })

  // ── Проверки здоровья ─────────────────────────────────────────────────
  // live — процесс жив (для перезапуска контейнера). ready — можно слать трафик: база отвечает,
  // движок диалогов загружен и ни один включённый бот не упал при запуске.
  const appVersion = await version()

  app.get('/api/health/live', (c) => c.json({ status: 'ok' }))

  app.get('/api/health/ready', async (c) => {
    const db = await checkDb(storage)
    const botsFailed = bots.failed()
    const ok = db.ok && Boolean(engine) && !botsFailed.length
    return c.json({ status: ok ? 'ready' : 'not_ready', db, engine: Boolean(engine), botsFailed }, ok ? 200 : 503, { 'cache-control': 'no-store' })
  })

  // Эксплуатация для людей и раздела «Состояние»: очередь, Диск, срок хранения, боты, выгрузки — только время и числа.
  // Запросы к базе — не чаще раза в 30 секунд: /api/health открыт всем и не ограничен лимитами
  let ops: { at: number; data: OpsState | null } | null = null
  const opsCached = async () => {
    if (!ops || Date.now() - ops.at > 30_000) ops = { at: Date.now(), data: await opsState(storage.sql).catch(() => null) }
    return ops.data
  }

  app.get('/api/health', async (c) => {
    const db = await checkDb(storage)
    return c.json(
      {
        status: db.ok ? 'ok' : 'degraded',
        version: appVersion,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        db,
        engine: Boolean(engine),
        bots: bots.active(),
        botsFailed: bots.failed(),
        assistant: env.GIGACHAT_AUTH_KEY ? 'gigachat' : 'offline',
        ops: db.ok ? await opsCached() : null,
      },
      db.ok ? 200 : 503,
      { 'cache-control': 'no-store' },
    )
  })

  // Страница /privacy называет обработчиков данных, только когда они действительно подключены
  const diskSync = yandexDiskSync ?? (() => Boolean(env.YANDEX_DISK_TOKEN || env.YANDEX_DISK_REFRESH_TOKEN))
  app.get('/api/privacy', async (c) => {
    const yandex360 = await Promise.resolve(diskSync()).catch(() => false)
    const sms = smsFromEnv(env)
    return c.json({ yandex360, sms: sms ? providerName(sms.provider) : null }, 200, { 'cache-control': 'public, max-age=300' })
  })

  app.route('/', createApi({ storage, engine, bots, hrToken, env }))

  // ── Адрес сайта, карта сайта и robots.txt ─────────────────────────────
  // В рабочей версии SITE_URL обязателен (siteUrlProblem); в разработке без него — адрес, по которому пришёл запрос
  const siteBase = (c: Context) => trimBase(env.SITE_URL?.trim() || new URL(c.req.url).origin)
  const dist = distDir ? `${distDir.replace(/\/+$/, '')}/` : fileURLToPath(new URL('../dist/', import.meta.url))
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url))

  app.get('/sitemap.xml', (c) => c.body(sitemapXml(siteBase(c)), 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }))

  const robotsFile = [`${dist}robots.txt`, `${publicDir}robots.txt`].find((f) => existsSync(f))
  const robots = robotsFile ? readFileSync(robotsFile, 'utf8').trimEnd() + '\n' : defaultRobots
  app.get('/robots.txt', (c) => c.text(`${robots}\nSitemap: ${siteBase(c)}/sitemap.xml\n`, 200, { 'Cache-Control': 'public, max-age=3600' }))

  // ── Собранный сайт ────────────────────────────────────────────────────
  // Файлы из assets/ с хешем в имени кэшируем навсегда, index.html — никогда.
  if (existsSync(`${dist}index.html`)) {
    const template = await readFile(`${dist}index.html`, 'utf8')
    // Манифест сборки: чанки страниц для modulepreload. Нет манифеста (старая сборка) — без предзагрузки чанков
    let preloads: Record<string, string[]> = {}
    try {
      preloads = pagePreloads(JSON.parse(await readFile(`${dist}.vite/manifest.json`, 'utf8')) as Record<string, ManifestChunk>)
    } catch {
      preloads = {}
    }
    // Хеш картинки превью в адресе: перегенерировали картинку — мессенджер возьмёт новую
    const imageVersion: Record<string, string> = {}
    for (const name of ['home', 'vacancies', 'game']) {
      const file = `${dist}og/${name}.png`
      if (existsSync(file)) imageVersion[name] = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)
    }
    // Страница собирается один раз на адрес сайта и вид страницы, brotli — заранее, на максимальном уровне
    const cache = new Map<string, { html: string; br: Uint8Array<ArrayBuffer> }>()
    const page = (base: string, path: string) => {
      const normal = normalPath(path)
      const kind = pageMetas()[normal] || preloads[normal] ? normal : normal === '/hr' || normal.startsWith('/hr/') ? '/hr' : '*'
      // Версия правок вакансий в ключе: HR поменял сумму — превью собирается заново
      const key = `${base}|${kind}|${vacanciesVersion()}`
      let hit = cache.get(key)
      if (!hit) {
        const html = renderPage(template, kind === '*' ? '/__page' : kind, base, imageVersion, analytics, preloads[kind] ?? [])
        const br = brotliCompressSync(Buffer.from(html), { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: html.length } })
        // Адрес без SITE_URL берётся из запроса — не даём чужим Host раздуть кэш
        if (cache.size > 64) cache.clear()
        hit = { html, br: new Uint8Array(br) }
        cache.set(key, hit)
      }
      return hit
    }
    const sendPage = (c: Context) => {
      const { html, br } = page(siteBase(c), c.req.path)
      if (acceptsBrotli(c.req.header('accept-encoding')))
        return c.body(br, 200, { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Encoding': 'br', Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' })
      // Без brotli — gzip на лету через compress()
      return c.html(html, 200, { 'Cache-Control': 'no-cache' })
    }
    app.get('/', sendPage)
    app.get('/index.html', sendPage)

    // Ролики «Смена изнутри» и постеры: Range с 206 для Safari, долгий кэш, без сжатия (server/middleware/video.ts)
    app.get('/video/*', videoFiles({ root: `${dist}video` }))

    // Служебное из сборки и скрытые файлы наружу не отдаём: /.vite/manifest.json, .DS_Store и т. п.
    app.use('/*', async (c, next) => (/(^|\/)\./.test(c.req.path) ? c.text('Not found', 404) : next()))

    // Рядом с файлами лежат .br и .gz из сборки (vite.config.ts) — отдаём их без сжатия на лету.
    // Vary: Accept-Encoding ставят serveStatic (сжатый ответ) и compress() (несжатый).
    const statics = serveStatic({ root: dist, precompressed: true })
    app.use('/*', async (c, next) => {
      let passed = false
      const res = await statics(c, async () => {
        passed = true
        await next()
      })
      if (passed || !res) return
      // Заголовки ставим на готовый ответ: onFound у serveStatic вызывается, когда ответ уже собран
      const html = res.headers.get('content-type')?.startsWith('text/html')
      // Материалы кейса (/materials/…) правятся без смены имён файлов: браузер каждый раз сверяется с сервером
      // по Last-Modified и получает 304, если файл не менялся
      const revalidate = html || c.req.path.startsWith('/materials/')
      res.headers.set('Cache-Control', revalidate ? 'no-cache' : c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=604800')
      return res
    })
    app.get('*', (c) => {
      const path = c.req.path
      if (path.startsWith('/api/') || path.startsWith('/bots/')) return c.json({ error: 'not_found' }, 404)
      // Нет файла сборки или картинки — честный 404, а не страница: иначе браузер закэширует HTML вместо скрипта
      if (path.startsWith('/assets/') || /\.[a-z0-9]{2,5}$/i.test(path)) return c.text('Not found', 404)
      return sendPage(c)
    })
  }

  app.notFound((c) => (c.req.path.startsWith('/api/') || c.req.path.startsWith('/bots/') ? c.json({ error: 'not_found' }, 404) : c.text('Not found', 404)))

  return app
}
