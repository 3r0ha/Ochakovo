import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { log } from './logging'

// IP клиента для лимитов запросов. За прокси (nginx, балансировщик) адрес берётся из X-Forwarded-For,
// но только если это явно разрешено: TRUST_PROXY=N — число доверенных прокси перед сервером (обычно 1).
// Каждый прокси дописывает адрес справа, поэтому клиент — N-й адрес с конца. Всё левее мог подставить
// сам клиент: при TRUST_PROXY=1 строка «X-Forwarded-For: 1.2.3.4» от клиента ключ лимита не меняет.
// TRUST_PROXY=true и yes понимаются как один прокси. Без настройки заголовок игнорируется.

let warned = ''

/** Сколько прокси перед сервером: 0 — заголовку не верим */
export function trustedHops(raw = process.env.TRUST_PROXY ?? ''): number {
  const v = raw.trim().toLowerCase()
  const hops = v === 'true' || v === 'yes' ? 1 : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0
  // Один раз на значение: журнал объясняет, откуда берётся адрес, и предупреждает о подмене без прокси
  if (hops && warned !== v) {
    warned = v
    log('warn', 'trust_proxy', {
      value: v,
      hops,
      note: `Адрес клиента — ${hops === 1 ? 'правый' : `${hops}-й с конца`} в X-Forwarded-For. Если перед сервером нет прокси, адрес подставит кто угодно — тогда TRUST_PROXY не задавайте`,
    })
  }
  return hops
}

export function clientIp(c: Context): string {
  const hops = trustedHops()
  if (hops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // Адресов меньше, чем прокси, — берём самый левый из тех, что дописали наши прокси
    if (chain.length) return chain[Math.max(0, chain.length - hops)]
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // Запрос без сокета (тесты через app.request)
    return 'unknown'
  }
}
