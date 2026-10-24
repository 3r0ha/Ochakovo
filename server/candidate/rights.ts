import type { BotLinks, BotNames } from '../dialog/storage'
import type { PostgresStorage } from '../db'
import { eraseByCandidate } from '../retention'
import { tokenMatches } from './status'

// Права кандидата на его заявку — по ключу из браузера (x-status-token), как статус на «Моей заявке».
// Неизвестный номер, чужой или старый ключ, удалённая заявка — одинаково null: маршрут отвечает 404 и ничего не раскрывает.

/** Причина в журнале удаления, когда кандидат отозвал согласие на сайте */
export const WITHDRAW_REASON = 'кандидат отозвал согласие на обработку данных на сайте'

/**
 * «Отозвать согласие и удалить заявку»: личные данные заявки стираются сразу (server/retention), задачи HR по ней
 * снимаются, ключ и ссылка на бота перестают работать. true — удалено сейчас
 */
export async function withdrawApplication(storage: Pick<PostgresStorage, 'sql'>, id: string, token: string): Promise<boolean> {
  if (!(await tokenMatches(storage.sql, id, token))) return false
  return (await eraseByCandidate(storage.sql, id, WITHDRAW_REASON)) > 0
}

/**
 * Ссылки «Получать ответ HR в Telegram или MAX» для заявки с сайта: start=app_<токен>, токен одноразовый
 * и живёт сутки (PostgresStorage.createBotLink). names — только поднявшиеся боты с заданным именем; нет ни одного — null
 */
export async function botLinkFor(
  storage: Pick<PostgresStorage, 'sql' | 'createBotLink'>,
  id: string,
  token: string,
  names: BotNames,
): Promise<BotLinks | null> {
  if (!names.telegram && !names.max) return null
  if (!(await tokenMatches(storage.sql, id, token))) return null
  const links = await storage.createBotLink(id, names)
  // Наружу — только диплинки
  return links && (links.telegram || links.max) ? { ...(links.telegram ? { telegram: links.telegram } : {}), ...(links.max ? { max: links.max } : {}) } : null
}
