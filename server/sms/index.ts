// SMS кандидатам без бота: приглашение на собеседование и напоминание накануне.
// Провайдеры — SMS.ru и SMSC.ru по их HTTP API. Выключено по умолчанию: включается, когда задан SMS_PROVIDER.
// Полные номера в журнал не пишем — только маску.
//
// SMS.ru: POST https://sms.ru/sms/send — api_id, to, msg, json=1, from (имя отправителя, согласованное с SMS.ru).
//   Ответ: {"status":"OK","status_code":100,"sms":{"7…":{"status":"OK","status_code":100,"sms_id":"…"}},"balance":…}
//   или {"status":"ERROR","status_code":200,"status_text":"…"}; у номера может быть своя ошибка в sms[номер].
// SMSC.ru: POST https://smsc.ru/sys/send.php — login+psw или apikey, phones, mes, sender, charset=utf-8, fmt=3.
//   Ответ: {"id":…,"cnt":…} или {"error":"…","error_code":N}.

export type SmsProvider = 'smsru' | 'smsc'

export type SmsConfig = {
  provider: SmsProvider
  apiKey?: string
  login?: string
  password?: string
  sender?: string
  /** Адрес API — для проверок с подставным сервером */
  baseUrl?: string
  fetch?: typeof fetch
}

export type SmsResult = { id: string; parts: number }

export class SmsError extends Error {
  constructor(
    message: string,
    /** Номер нельзя обслужить (неверный, запрещён) — повторять бессмысленно */
    public permanent = false,
  ) {
    super(message)
  }
}

/** +7 916 ***-**-67 — для журналов и сообщений об ошибках */
export function maskPhone(phone: string) {
  const d = phone.replace(/\D/g, '')
  if (d.length < 6) return '***'
  return `+${d.slice(0, 1)} ${d.slice(1, 4)} ***-**-${d.slice(-2)}`
}

/** Номер для отправки: только российские мобильные 79XXXXXXXXX; иначе null */
export function smsPhone(phone: string) {
  let d = phone.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  return /^79\d{9}$/.test(d) ? d : null
}

/** Сколько SMS займёт текст: кириллица — 70 знаков, длиннее — по 67 */
export function smsParts(text: string) {
  const unicode = /[^\x00-\x7F]/.test(text)
  const single = unicode ? 70 : 160
  const multi = unicode ? 67 : 153
  return text.length <= single ? 1 : Math.ceil(text.length / multi)
}

export function smsFromEnv(env: NodeJS.ProcessEnv): SmsConfig | null {
  const provider = env.SMS_PROVIDER?.trim().toLowerCase()
  if (provider !== 'smsru' && provider !== 'smsc') return null
  const cfg: SmsConfig = {
    provider,
    apiKey: env.SMS_API_KEY?.trim() || undefined,
    login: env.SMS_LOGIN?.trim() || undefined,
    password: env.SMS_PASSWORD?.trim() || undefined,
    sender: env.SMS_SENDER?.trim() || undefined,
    baseUrl: env.SMS_API_URL?.trim() || undefined,
  }
  if (provider === 'smsru' && !cfg.apiKey) return null
  if (provider === 'smsc' && !cfg.apiKey && !(cfg.login && cfg.password)) return null
  return cfg
}

export const providerName = (p: SmsProvider) => (p === 'smsru' ? 'SMS.ru' : 'SMSC.ru')

export async function sendSms(cfg: SmsConfig, phone: string, text: string): Promise<SmsResult> {
  const to = smsPhone(phone)
  if (!to) throw new SmsError(`Номер ${maskPhone(phone)} не похож на российский мобильный`, true)
  const http = cfg.fetch ?? fetch
  const post = async (url: string, body: Record<string, string>) => {
    let res: Response
    try {
      res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new SmsError(`${providerName(cfg.provider)} не ответил`)
    }
    if (res.status >= 500) throw new SmsError(`${providerName(cfg.provider)} временно недоступен (HTTP ${res.status})`)
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!data) throw new SmsError(`${providerName(cfg.provider)} ответил не JSON (HTTP ${res.status})`)
    return data
  }

  if (cfg.provider === 'smsru') {
    const body: Record<string, string> = { api_id: cfg.apiKey!, to, msg: text, json: '1' }
    if (cfg.sender) body.from = cfg.sender
    const data = await post(`${(cfg.baseUrl ?? 'https://sms.ru').replace(/\/$/, '')}/sms/send`, body)
    if (data.status !== 'OK') throw new SmsError(`SMS.ru: ${String(data.status_text ?? `код ${data.status_code ?? "без кода"}`)}`)
    const one = (data.sms as Record<string, { status: string; status_code: number; status_text?: string; sms_id?: string }> | undefined)?.[to]
    if (!one || one.status !== 'OK') throw new SmsError(`SMS.ru: ${one?.status_text ?? 'сообщение не принято'} (${maskPhone(to)})`, true)
    return { id: String(one.sms_id ?? ''), parts: smsParts(text) }
  }

  const body: Record<string, string> = { phones: `+${to}`, mes: text, charset: 'utf-8', fmt: '3' }
  if (cfg.apiKey) body.apikey = cfg.apiKey
  else Object.assign(body, { login: cfg.login!, psw: cfg.password! })
  if (cfg.sender) body.sender = cfg.sender
  const data = await post(`${(cfg.baseUrl ?? 'https://smsc.ru').replace(/\/$/, '')}/sys/send.php`, body)
  if (data.error) {
    const code = Number(data.error_code)
    // 6 — запрещено, 7 — неверный номер, 8 — не доставить: повторять бессмысленно
    throw new SmsError(`SMSC.ru: ${String(data.error)} (код ${code})`, [6, 7, 8].includes(code))
  }
  return { id: String(data.id ?? ''), parts: Number(data.cnt) || smsParts(text) }
}
