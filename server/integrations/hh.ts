import type { HhVacancyPayload } from '@shared/hhVacancy'
import { mapRow, type ImportRow } from '@shared/hrImport'

// Клиент API работодателя hh.ru (https://api.hh.ru, спецификация — api.hh.ru/openapi).
// Код готов и проверен на подставном сервере; живого токена нет — публикация включится, когда компания
// зарегистрирует приложение на dev.hh.ru и выдаст токен менеджера.
//
// Правила API, которые здесь соблюдены:
// — каждый запрос с заголовком HH-User-Agent «Приложение/версия (почта)», иначе 400;
// — авторизация Bearer access_token; истёк — POST /token с grant_type=refresh_token. refresh_token одноразовый,
//   новую пару сохраняем (onTokens);
// — публикация POST /vacancies списывает услуги, поэтому только по явной кнопке; черновик POST /vacancies/drafts бесплатный;
// — правка PUT /vacancies/{id}, архив PUT /employers/{employer_id}/vacancies/archived/{id};
// — 429 и captcha_required — понятная ошибка «повтори позже»; лимиты hh.ru явно не публикует.

export const HH_API = 'https://api.hh.ru'

export type HhTokens = { accessToken: string; refreshToken?: string; expiresAt?: string }

export type HhConfig = {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  employerId?: string
  userAgent: string
  apiBase?: string
  fetch?: typeof fetch
  onTokens?: (t: HhTokens) => Promise<void>
}

export class HhError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Ошибки полей из ответа hh.ru: [{type, value, reason}] */
    public details: { type?: string; value?: string; reason?: string }[] = [],
  ) {
    super(message)
  }
}

/** Понятные тексты на частые ошибки hh.ru */
function hhError(status: number, body: { errors?: { type?: string; value?: string }[]; bad_argument?: string; description?: string }) {
  const errors = body.errors ?? []
  const values = errors.map((e) => e.value ?? e.type ?? '')
  if (status === 401) return new HhError('Токен hh.ru не подходит или истёк — выдай новый', status, errors)
  if (values.includes('captcha_required')) return new HhError('hh.ru просит пройти капчу: опубликуй эту вакансию вручную на hh.ru', status, errors)
  if (values.some((v) => /not_enough/.test(v))) return new HhError('На hh.ru не хватает услуг для публикации — проверь пакет компании', status, errors)
  if (status === 429) return new HhError('hh.ru ограничил частоту запросов — повтори через несколько минут', status, errors)
  if (status === 403) return new HhError('Нет прав на это действие: токен должен быть у менеджера компании с правом публикации', status, errors)
  if (status === 400) return new HhError(`hh.ru не принял данные: ${body.bad_argument ?? body.description ?? values.join(', ') ?? 'ошибка в полях'}`, status, errors)
  return new HhError(status >= 500 ? 'hh.ru сейчас недоступен — повтори позже' : `hh.ru ответил ошибкой ${status}`, status, errors)
}

export class HhClient {
  private token: string | undefined
  private refreshToken: string | undefined
  private readonly base: string
  private readonly http: typeof fetch

  constructor(private cfg: HhConfig) {
    this.token = cfg.accessToken
    this.refreshToken = cfg.refreshToken
    this.base = (cfg.apiBase ?? HH_API).replace(/\/$/, '')
    this.http = cfg.fetch ?? fetch
  }

  get connected() {
    return Boolean(this.token || this.refreshToken)
  }

  async refresh() {
    if (!this.refreshToken) throw new HhError('Токен истёк, а refresh_token нет: выдай новый токен', 401)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken })
    if (this.cfg.clientId) body.set('client_id', this.cfg.clientId)
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)
    const res = await this.http(`${this.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'HH-User-Agent': this.cfg.userAgent },
      body,
    })
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!res.ok || !data.access_token) throw new HhError(`Не удалось обновить токен hh.ru: ${data.error_description ?? res.status}`, res.status)
    this.token = data.access_token
    this.refreshToken = data.refresh_token ?? this.refreshToken
    await this.cfg.onTokens?.({
      accessToken: this.token,
      refreshToken: this.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    })
  }

  /** Запрос к API. На истёкший токен — одно обновление и повтор */
  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<{ data: T; location: string | null }> {
    if (!this.token) await this.refresh()
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'HH-User-Agent': this.cfg.userAgent,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    const data = (raw ? JSON.parse(raw) : {}) as T & { errors?: { type?: string; value?: string }[] }
    if (res.status === 403 && !retried && data.errors?.some((e) => e.type === 'oauth' && e.value === 'token_expired') && this.refreshToken) {
      await this.refresh()
      return this.request(method, path, body, true)
    }
    if (res.status === 401 && !retried && this.refreshToken) {
      await this.refresh()
      return this.request(method, path, body, true)
    }
    if (!res.ok) throw hhError(res.status, data as never)
    return { data, location: res.headers.get('location') }
  }

  private employer() {
    if (!this.cfg.employerId) throw new HhError('Не задан HH_EMPLOYER_ID', 400)
    return this.cfg.employerId
  }

  /** Кто авторизован: имя менеджера и компания — для «Проверить подключение» */
  async me() {
    const { data } = await this.request<{ first_name?: string; last_name?: string; employer?: { id: string; name: string } | null; is_employer?: boolean }>('GET', '/me')
    return { name: [data.first_name, data.last_name].filter(Boolean).join(' '), employer: data.employer ?? null, isEmployer: Boolean(data.is_employer) }
  }

  /** Бесплатный черновик: проверить вакансию на hh.ru, не списывая услуги */
  async createDraft(payload: HhVacancyPayload) {
    const { data } = await this.request<{ id: string | number }>('POST', '/vacancies/drafts', payload)
    return String(data.id)
  }

  /** Публикация — списывает услугу пакета. Только по явной кнопке HR */
  async publish(payload: HhVacancyPayload) {
    const { data, location } = await this.request<{ id?: string | number }>('POST', '/vacancies', payload)
    const id = data.id ?? location?.split('/').pop()
    if (!id) throw new HhError('hh.ru не вернул номер вакансии', 500)
    return String(id)
  }

  /** Правка: составные поля (salary_range, professional_roles) передаются целиком; billing_type — отдельно, не здесь */
  async update(id: string, payload: HhVacancyPayload) {
    const { billing_type: _b, vacancy_properties: _p, ...rest } = payload
    await this.request('PUT', `/vacancies/${encodeURIComponent(id)}`, rest)
  }

  async archive(id: string) {
    await this.request('PUT', `/employers/${encodeURIComponent(this.employer())}/vacancies/archived/${encodeURIComponent(id)}`)
  }

  /**
   * Отклики по вакансии → строки для импорта. В коллекции response есть краткое резюме без контактов;
   * телефон и почта — в полном резюме по ссылке resume.url. Для откликнувшихся на вашу вакансию просмотр
   * контактов обычно не тратит платные услуги, но это зависит от тарифа компании — проверь до массовой загрузки.
   */
  async responses(vacancyId: string, max = 200): Promise<ImportRow[]> {
    const rows: ImportRow[] = []
    for (let page = 0; rows.length < max; page++) {
      const { data } = await this.request<{ items: { created_at?: string; resume?: { url?: string; first_name?: string; last_name?: string; middle_name?: string } | null }[]; pages: number }>(
        'GET',
        `/negotiations/response?vacancy_id=${encodeURIComponent(vacancyId)}&page=${page}&per_page=50`,
      )
      for (const item of data.items ?? []) {
        let phone = ''
        let email = ''
        if (item.resume?.url) {
          const path = new URL(item.resume.url, this.base).pathname + new URL(item.resume.url, this.base).search
          const full = await this.request<{ contact?: { type?: { id?: string }; value?: string | { formatted?: string } }[] }>('GET', path)
          for (const c of full.data.contact ?? []) {
            const v = typeof c.value === 'string' ? c.value : (c.value?.formatted ?? '')
            if (c.type?.id === 'cell' || c.type?.id === 'home' || c.type?.id === 'work') phone ||= v
            if (c.type?.id === 'email') email ||= v
          }
        }
        const r = item.resume
        // Дата отклика по Москве
        const date = item.created_at ? new Date(new Date(item.created_at).getTime() + 3 * 3600e3) : null
        const dmy = date ? `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}` : ''
        rows.push(mapRow([r?.last_name ?? '', [r?.first_name, r?.middle_name].filter(Boolean).join(' '), phone, email, dmy], { lastName: 0, firstName: 1, phone: 2, email: 3, date: 4 }))
      }
      if (page + 1 >= (data.pages ?? 1)) break
    }
    return rows.slice(0, max)
  }
}

export function hhFromEnv(env: NodeJS.ProcessEnv, state: Partial<HhTokens> = {}): HhConfig | null {
  const accessToken = state.accessToken || env.HH_ACCESS_TOKEN?.trim() || undefined
  const refreshToken = state.refreshToken || env.HH_REFRESH_TOKEN?.trim() || undefined
  if (!accessToken && !refreshToken) return null
  return {
    accessToken,
    refreshToken,
    clientId: env.HH_CLIENT_ID?.trim() || undefined,
    clientSecret: env.HH_CLIENT_SECRET?.trim() || undefined,
    employerId: env.HH_EMPLOYER_ID?.trim() || undefined,
    userAgent: env.HH_USER_AGENT?.trim() || 'OchakovoHR/1.0 (rabota@ochakovo.ru)',
    apiBase: env.HH_API_URL?.trim() || undefined,
  }
}
