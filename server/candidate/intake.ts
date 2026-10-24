import type { Application, ApplicationInput } from '@shared/applications'
import { phoneKey } from '@shared/phone'
import type { PostgresStorage } from '../db'

// Приём заявки с сайта: повторы и лимит считаются по человеку — телефону или нику, а не по IP.
// На ярмарке весь зал сидит за одним адресом Wi-Fi, поэтому лимит по IP в rate-limit.ts мягкий,
// а строгие правила — здесь:
// - тот же телефон или ник за последние REPEAT_MINUTES минут — «уже принята», без номера и токена той заявки;
// - больше PER_HOUR заявок с одного телефона или ника за час — подождать retryAfter секунд.

export const REPEAT_MINUTES = 10
export const PER_HOUR = 3

export type IntakeResult =
  | { ok: true; application: Application }
  | { ok: false; error: 'already_applied' }
  | { ok: false; error: 'phone_limit'; retryAfter: number }

/** По чему узнаём того же человека: цифры телефона (как phone_norm в базе) и ник в нижнем регистре */
export function personKey(input: Pick<ApplicationInput, 'phone' | 'contact'>) {
  const phone = phoneKey(input.phone ?? '')
  return { phone: phone.length >= 10 ? phone : '', contact: (input.contact ?? '').trim().toLowerCase() }
}

/**
 * Проверить повтор и лимит и сохранить заявку — в одной транзакции под блокировкой по телефону или нику:
 * два одновременных «Отправить» с одного номера дают одну заявку и один ответ already_applied
 */
export async function acceptApplication(storage: PostgresStorage, input: ApplicationInput): Promise<IntakeResult> {
  const key = personKey(input)
  const lock = key.phone || key.contact
  return storage.sql.begin(async (tx): Promise<IntakeResult> => {
    if (lock) await tx`select pg_advisory_xact_lock(hashtext(${`intake:${lock}`}))`
    const [seen] = await tx<{ hour: number; fresh: number; retry: number | null }[]>`
      select count(*)::int as hour,
             count(*) filter (where created_at > now() - make_interval(mins => ${REPEAT_MINUTES}))::int as fresh,
             ceil(extract(epoch from min(created_at) + interval '1 hour' - now()))::int as retry
      from applications
      where created_at > now() - interval '1 hour'
        and ((${key.phone} <> '' and phone_norm = ${key.phone}) or (${key.contact} <> '' and lower(contact) = ${key.contact}))`
    if (seen.fresh > 0) return { ok: false, error: 'already_applied' }
    if (seen.hour >= PER_HOUR) return { ok: false, error: 'phone_limit', retryAfter: Math.max(1, seen.retry ?? 1) }
    return { ok: true, application: await storage.saveApplication(input, tx) }
  })
}
