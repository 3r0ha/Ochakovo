import { Hono } from 'hono'
import { ensureAdmin } from '../auth/bootstrap'
import { loginGuard } from '../auth/throttle'
import type { Registry } from '../channels/registry'
import type { PostgresStorage } from '../db'
import { HrRepo } from '../db/hr'
import type { DialogEngine } from '../dialog/types'
import * as adaptation from './adaptation'
import * as booking from './booking'
import { dialogRoutes } from './dialog'
import * as focus from './focus'
import { hrRoutes } from './hr'
import * as hrAccount from './hr-account'
import * as hrBots from './hr-bots'
import * as hrBroadcast from './hr-broadcast'
import * as hrContent from './hr-content'
import * as hrKb from './hr-kb'
import * as hrSources from './hr-sources'
import { publicRoutes } from './public'

// API целиком: открытые маршруты сайта, единый диалоговый API и HR-панель.
// Проверки здоровья, лимиты и заголовки безопасности добавляет server/app.ts.

type Deps = {
  storage: PostgresStorage
  /** null — движок диалогов не загрузился: /api/dialog отвечает 503, боты не запускаются */
  engine: DialogEngine | null
  bots: Registry
  /** Устаревший общий токен панели. Теперь вход по учётным записям; см. docs/hr.md */
  hrToken?: string
  /** Переменные окружения; по умолчанию process.env */
  env?: NodeJS.ProcessEnv
}

/** Что получает каждый модуль маршрутов: export function routes(deps: ApiDeps): Hono */
export type ApiDeps = {
  storage: PostgresStorage
  repo: HrRepo
  /** null — движок диалогов не загрузился */
  engine: DialogEngine | null
  bots: Registry
  env: NodeJS.ProcessEnv
}

/** Модули второй волны: каждый файл уже подключён, маршруты добавляет пакет-владелец */
const slots = [hrSources, hrBots, hrBroadcast, hrKb, hrContent, hrAccount, booking, focus, adaptation]

export function createApi({ storage, engine, bots, env = process.env }: Deps) {
  const app = new Hono()
  const repo = new HrRepo(storage.sql)
  const deps: ApiDeps = { storage, repo, engine, bots, env }

  // Первый администратор — из переменных окружения или демо-вход в разработке
  ensureAdmin(repo, env).catch((e) => console.error('[hr] не удалось создать администратора:', e))

  app.route('/', publicRoutes(deps))
  app.route('/', dialogRoutes({ engine, bots }))
  // Задержка входа по паре «почта + IP» — до маршрутов панели, один экземпляр на API
  app.use('/api/hr/login', loginGuard())
  app.route('/', hrRoutes({ storage, repo, bots, env }))
  for (const slot of slots) app.route('/', slot.routes(deps))
  return app
}
