import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp, siteUrlProblem } from './app'
import { loadAdapters, type Registry } from './channels/registry'
import { connect, migrate, PostgresStorage } from './db'
import { createEngine } from './dialog/engine'
import type { DialogEngine } from './dialog/types'
import { startScheduler } from './jobs/scheduler'
import { log } from './middleware/logging'
import { retentionMonths } from './retention'
import { providerName, smsFromEnv } from './sms'

// Один процесс: API сайта и HR-панели, единый диалоговый API, боты Telegram и MAX и собранный сайт.
// Запуск: pnpm server (tsx watch), в проде — pnpm server:start или Docker. Настройки — .env (пример в .env.example).

// .env читается после импортов: модули сервера берут process.env только внутри функций, не при загрузке
try {
  process.loadEnvFile?.('.env')
} catch {
  // .env нет — берём переменные окружения как есть
}

const env = process.env

// Настройки, без которых рабочая версия врёт в ссылках и превью, проверяем до подключения к базе
const siteProblem = siteUrlProblem(env)
if (siteProblem) {
  console.error(`[server] ${siteProblem}`)
  process.exit(1)
}

const port = Number(env.PORT) || 8787
const siteUrl = env.SITE_URL?.trim() || 'http://localhost:5180'
/** Устаревший служебный токен: только чтение заявок скриптами, если задан и не короче 16 символов (docs/hr.md) */
const hrToken = env.HR_TOKEN ?? ''
if (hrToken && hrToken.length < 16) console.warn('[server] HR_TOKEN короче 16 символов и не принимается. Вход в панель — по учётным записям')

const dbUrl = env.DATABASE_URL || 'postgres://localhost:5432/ochakovo'
const sql = connect(dbUrl)
try {
  await migrate(sql)
} catch (e) {
  // Адрес базы — без логина и пароля
  const where = URL.canParse(dbUrl) ? (({ hostname, port, pathname }) => `${hostname}:${port || 5432}${pathname}`)(new URL(dbUrl)) : 'из DATABASE_URL'
  console.error(`[server] База ${where} не отвечает или миграция не прошла: ${(e as Error).message}`)
  console.error('[server] Проверьте DATABASE_URL. В Docker — APP_DATABASE_URL или запуск с --profile local-db (docs/deploy.md)')
  process.exit(1)
}
const storage = new PostgresStorage(sql)

// В проде панель без администратора бесполезна: нужен HR_ADMIN_EMAIL и HR_ADMIN_PASSWORD или уже заведённый админ
if (env.NODE_ENV === 'production' && !(env.HR_ADMIN_EMAIL && env.HR_ADMIN_PASSWORD)) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from hr_users where role = 'admin' and not disabled`
  if (!n) {
    console.error('[server] В проде нужен администратор HR-панели: задайте HR_ADMIN_EMAIL и HR_ADMIN_PASSWORD')
    process.exit(1)
  }
}

// Движок диалогов импортируется статически: сломанный модуль не даст серверу стартовать молча.
// Если он упал при создании, сайт и HR-панель работают, а /api/health/ready честно отвечает 503
let engine: DialogEngine | null = null
try {
  engine = createEngine(storage, { siteUrl })
} catch (e) {
  log('error', 'движок диалогов не запустился: /api/dialog отвечает 503, боты выключены', { error: (e as Error).message })
}

// Бот, который не поднялся, не роняет сервер: он попадает в registry.failed() и в 503 готовности
let bots: Registry
try {
  bots = await loadAdapters(engine ? env : {})
} catch (e) {
  log('error', 'боты не подключены', { error: (e as Error).message })
  bots = await loadAdapters({})
}

// DIST_DIR — другая папка сборки (например, своя сборка для проверки рядом с общей dist); по умолчанию dist/ в корне
const distDir = env.DIST_DIR?.trim() ? resolve(env.DIST_DIR.trim()) : undefined
const app = await createApp({ storage, engine, bots, hrToken, env, distDir })

const sms = smsFromEnv(env)
const site = existsSync(distDir ? resolve(distDir, 'index.html') : fileURLToPath(new URL('../dist/index.html', import.meta.url)))
const server = serve({ fetch: app.fetch, port }, (info) => {
  // Одна строка о том, что включено, — по ней видно, с какими настройками поднялся сервер. Секретов в ней нет
  log('info', 'startup', {
    url: `http://localhost:${info.port}`,
    mode: env.NODE_ENV || 'development',
    siteUrl,
    site,
    engine: Boolean(engine),
    bots: bots.active(),
    botsFailed: bots.failed(),
    botsVia: bots.active().length ? (env.PUBLIC_URL ? 'webhook' : 'polling') : null,
    assistant: env.GIGACHAT_AUTH_KEY ? 'gigachat' : 'offline',
    yandexDisk: Boolean(env.YANDEX_DISK_TOKEN || env.YANDEX_DISK_REFRESH_TOKEN),
    sms: sms ? providerName(sms.provider) : null,
    hh: Boolean(env.HH_ACCESS_TOKEN || env.HH_REFRESH_TOKEN),
    retentionMonths: retentionMonths(env),
    trustProxy: Number(env.TRUST_PROXY) || 0,
  })
})

const controller = new AbortController()
if (engine) bots.start(engine, { publicUrl: env.PUBLIC_URL || undefined, signal: controller.signal })
// Очередь HR: сообщения кандидатам с задержкой на отмену, напоминания о собеседованиях, срок хранения, выгрузка на Яндекс Диск
startScheduler({ sql, bots, signal: controller.signal })

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[server] ${signal}: останавливаемся`)
  controller.abort()
  // Новые соединения не принимаем, текущие запросы дожидаемся не дольше 10 секунд
  const forced = setTimeout(() => process.exit(1), 10_000)
  forced.unref()
  await new Promise<void>((done) => server.close(() => done()))
  await sql.end({ timeout: 5 })
  process.exit(0)
}

// Необработанные ошибки не должны молча ронять бота — пишем в журнал и живём дальше
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { error: String(reason) })
})
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
