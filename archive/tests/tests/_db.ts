// Одноразовая база для проверок в scripts/tests: создать, применить миграции, отдать проверке, удалить.
//
//   import { withTestDb } from './_db'
//   await withTestDb('core-input', async (sql) => { … })
//
// Имя базы — ochakovo_t_<name>_<случайное>, так проверки не мешают друг другу и общим базам.
// Служебная база для create/drop database: TEST_PG_URL, иначе адрес из TEST_DATABASE_URL или DATABASE_URL
// с базой postgres, иначе postgres://localhost:5432/postgres.

import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { connect, migrate, type Sql } from '../../server/db'

/** Адрес служебной базы, через которую создаются и удаляются временные */
export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEST_PG_URL) return env.TEST_PG_URL
  const base = env.TEST_DATABASE_URL || env.DATABASE_URL
  if (base) {
    const u = new URL(base)
    u.pathname = '/postgres'
    return u.toString()
  }
  return 'postgres://localhost:5432/postgres'
}

type Options = {
  /** false — пустая база без миграций; число — миграции до этого номера включительно (проверка переноса старых строк) */
  migrate?: boolean | number
}

/**
 * Создаёт базу ochakovo_t_<name>_<случайное>, применяет миграции, вызывает fn и удаляет базу — даже если fn упала.
 * fn получает подключение (connect из server/db) и адрес базы — например, чтобы поднять на ней сервер
 */
export async function withTestDb<T>(name: string, fn: (sql: Sql, url: string) => Promise<T>, opts: Options = {}): Promise<T> {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'test'
  const dbName = `ochakovo_t_${safe}_${randomBytes(4).toString('hex')}`
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database "${dbName}"`)
  } catch (e) {
    await admin.end({ timeout: 5 })
    throw new Error(`Не удалось создать базу ${dbName}: ${(e as Error).message}. Служебная база: задайте TEST_PG_URL`)
  }
  const u = new URL(adminUrl())
  u.pathname = `/${dbName}`
  const url = u.toString()
  const sql = connect(url)
  try {
    if (opts.migrate !== false) await migrate(sql, { quiet: true, until: typeof opts.migrate === 'number' ? opts.migrate : undefined })
    return await fn(sql, url)
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`).catch((e) => console.error(`Базу ${dbName} удалить не вышло: ${(e as Error).message}`))
    await admin.end({ timeout: 5 })
  }
}

/**
 * Дождаться, пока сервер на этой базе закончит фоновый старт: createApp создаёт первого администратора HR
 * без ожидания. Без этого база может удалиться посреди записи — в журнале будет CONNECTION_ENDED
 */
export async function serverSettled(sql: Sql, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from hr_users`
    if (row.n > 0) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
