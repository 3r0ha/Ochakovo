import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { candidateStatus, type CandidateStatus } from '@shared/candidateStatus'
import type { Sql } from '../db'

// Статус заявки для самого кандидата: страница «Моя заявка», чат на сайте, боты.
// При создании заявки выдаём случайный токен (24 байта), в базе храним только его SHA-256 —
// утечка базы не открывает статусы. Сравнение — за постоянное время.

export function newStatusToken() {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: tokenHash(token) }
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

const idRe = /^[A-Z0-9]{4,16}$/
const tokenRe = /^[\w-]{20,64}$/

/**
 * Статус по номеру заявки и токену. null — нет такой заявки, токен не подходит, токена нет (старые заявки)
 * или личные данные уже удалены. Наружу — только CandidateStatus: без ответственного, заметок и причин отказа.
 */
export async function statusForToken(sql: Sql, id: string, token: string, now = new Date()): Promise<CandidateStatus | null> {
  if (!(await tokenMatches(sql, id, token))) return null
  const [{ WorkflowRepo }, { HrRepo }] = await Promise.all([import('../db/workflow'), import('../db/hr')])
  const app = await new WorkflowRepo(sql).get(id)
  if (!app || app.anonymizedAt) return null
  return candidateStatus(app, now, await new HrRepo(sql).workSettings())
}

/**
 * Ключ из браузера кандидата подходит к заявке: номер и токен верны, личные данные ещё не удалены.
 * Неизвестный номер, чужой токен, старая заявка без токена и обезличенная — одинаково false
 */
export async function tokenMatches(sql: Sql, id: string, token: string): Promise<boolean> {
  if (!idRe.test(id) || !tokenRe.test(token)) return false
  const [row] = await sql<{ status_token_hash: string | null; anonymized_at: Date | null }[]>`
    select status_token_hash, anonymized_at from applications where id = ${id}`
  if (!row?.status_token_hash || row.anonymized_at) return false
  const expected = Buffer.from(row.status_token_hash, 'hex')
  const given = Buffer.from(tokenHash(token), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
