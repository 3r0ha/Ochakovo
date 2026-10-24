// Клиент REST API Яндекс Диска: загрузка файла с перезаписью, создание папок, обновление токена.
// Публичные ссылки не создаём никогда: в выгрузках персональные данные кандидатов.
// Документация: https://yandex.ru/dev/disk-api/doc/ru/

export const DISK_API = 'https://cloud-api.yandex.net/v1/disk'
export const OAUTH_URL = 'https://oauth.yandex.ru/token'

export type DiskTokens = { accessToken: string; refreshToken?: string; expiresAt?: string }

export type DiskConfig = {
  token?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  apiBase?: string
  oauthUrl?: string
  fetch?: typeof fetch
  /** Новые токены после обновления — сохранить, чтобы пережить перезапуск */
  onTokens?: (t: DiskTokens) => Promise<void>
}

export class DiskError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** Можно повторить позже: блокировка, лимит, временная недоступность */
    public retryable = false,
  ) {
    super(message)
  }
}

/** Понятное сообщение по коду ответа Диска */
function diskError(status: number, where: string): DiskError {
  const known: Record<number, [string, boolean]> = {
    401: ['Токен Яндекс Диска не подходит или истёк. Выдайте новый и обновите YANDEX_DISK_TOKEN', false],
    403: ['Нет доступа к папке на Диске. Проверьте права приложения и путь YANDEX_DISK_ROOT', false],
    404: ['Папка на Диске не найдена', false],
    413: ['Файл слишком большой для загрузки на Диск', false],
    423: ['Диск временно не принимает запись: идёт обслуживание или файл занят. Повторим позже', true],
    429: ['Слишком много запросов к Диску. Повторим позже', true],
    507: ['На Диске закончилось место', false],
  }
  const [message, retryable] = known[status] ?? [
    status >= 500 ? 'Яндекс Диск сейчас недоступен. Повторим позже' : `Диск ответил ошибкой ${status} (${where})`,
    status >= 500,
  ]
  return new DiskError(message, status, retryable)
}

/**
 * Путь на Диске → корень и папки. Поддерживаются «disk:/…», «app:/…», просто «/…»
 * и общий диск организации в Яндекс 360 — «vd:<id>:disk:/…».
 */
export function splitDiskPath(path: string): { root: string; parts: string[] } {
  const m = /^((?:vd:[^:/]+:)?(?:disk|app):)?(.*)$/.exec(path.trim())!
  const root = m[1] ?? 'disk:'
  const parts = m[2].split('/').filter(Boolean)
  return { root, parts }
}

export const joinDiskPath = (root: string, ...names: string[]) => {
  const { root: r, parts } = splitDiskPath(root)
  return `${r}/${[...parts, ...names].join('/')}`
}

export class YandexDisk {
  private token: string | undefined
  private refreshToken: string | undefined
  private readonly api: string
  private readonly oauth: string
  private readonly http: typeof fetch

  constructor(private cfg: DiskConfig) {
    this.token = cfg.token
    this.refreshToken = cfg.refreshToken
    this.api = (cfg.apiBase ?? DISK_API).replace(/\/$/, '')
    this.oauth = cfg.oauthUrl ?? OAUTH_URL
    this.http = cfg.fetch ?? fetch
  }

  get canRefresh() {
    return Boolean(this.refreshToken && this.cfg.clientId && this.cfg.clientSecret)
  }

  /** Обновить токен по refresh_token: POST oauth.yandex.ru/token, grant_type=refresh_token */
  async refresh() {
    if (!this.canRefresh) throw new DiskError('Токен истёк, а обновить его нечем: задайте YANDEX_DISK_REFRESH_TOKEN, YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET')
    const res = await this.http(this.oauth, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken!,
        client_id: this.cfg.clientId!,
        client_secret: this.cfg.clientSecret!,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!res.ok || !data.access_token) throw new DiskError(`Не удалось обновить токен Яндекса: ${data.error_description ?? res.status}`, res.status)
    this.token = data.access_token
    if (data.refresh_token) this.refreshToken = data.refresh_token
    const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined
    await this.cfg.onTokens?.({ accessToken: this.token, refreshToken: this.refreshToken, expiresAt })
  }

  /** Запрос к API Диска. На 401 один раз обновляем токен и повторяем */
  private async call(method: string, path: string, query: Record<string, string>, retried = false): Promise<Response> {
    if (!this.token) {
      if (!this.canRefresh) throw new DiskError('Не задан YANDEX_DISK_TOKEN')
      await this.refresh()
    }
    const url = `${this.api}${path}?${new URLSearchParams(query)}`
    const res = await this.http(url, { method, headers: { authorization: `OAuth ${this.token}`, accept: 'application/json' } })
    if (res.status === 401 && !retried && this.canRefresh) {
      await this.refresh()
      return this.call(method, path, query, true)
    }
    return res
  }

  /** Сведения о Диске — для проверки подключения */
  async info() {
    const res = await this.call('GET', '', {})
    if (!res.ok) throw diskError(res.status, 'проверка подключения')
    const d = (await res.json()) as { total_space?: number; used_space?: number; user?: { display_name?: string; login?: string } }
    return { total: d.total_space ?? 0, used: d.used_space ?? 0, user: d.user?.display_name ?? d.user?.login ?? '' }
  }

  /** Создать папку со всеми родителями: по уровню за запрос, 409 — уже есть */
  async ensureFolder(path: string) {
    const { root, parts } = splitDiskPath(path)
    for (let i = 1; i <= parts.length; i++) {
      const res = await this.call('PUT', '/resources', { path: `${root}/${parts.slice(0, i).join('/')}` })
      if (res.status !== 201 && res.status !== 409) throw diskError(res.status, 'создание папки')
    }
  }

  /** Файлы в папке (имя и путь); папки нет — пустой список */
  async list(path: string): Promise<{ name: string; path: string }[]> {
    const res = await this.call('GET', '/resources', { path, limit: '1000', fields: '_embedded.items.name,_embedded.items.path,_embedded.items.type' })
    if (res.status === 404) return []
    if (!res.ok) throw diskError(res.status, 'список файлов')
    const d = (await res.json()) as { _embedded?: { items?: { name: string; path: string; type?: string }[] } }
    return (d._embedded?.items ?? []).filter((i) => i.type !== 'dir').map((i) => ({ name: i.name, path: i.path }))
  }

  /** Удалить насовсем, минуя корзину: в корзине персональные данные лежали бы дальше */
  async remove(path: string) {
    const res = await this.call('DELETE', '/resources', { path, permanently: 'true' })
    if (res.status !== 204 && res.status !== 202 && res.status !== 404) throw diskError(res.status, 'удаление файла')
  }

  /**
   * Загрузить файл с перезаписью: GET /resources/upload → ссылка, PUT байтов по ссылке (без токена).
   * Нет родительской папки (409) — создаём и пробуем ещё раз.
   */
  async upload(path: string, body: Uint8Array, contentType = 'application/octet-stream') {
    let link = await this.call('GET', '/resources/upload', { path, overwrite: 'true' })
    if (link.status === 409) {
      const { root, parts } = splitDiskPath(path)
      if (parts.length > 1) await this.ensureFolder(`${root}/${parts.slice(0, -1).join('/')}`)
      link = await this.call('GET', '/resources/upload', { path, overwrite: 'true' })
    }
    if (!link.ok) throw diskError(link.status, 'ссылка для загрузки')
    const { href, method } = (await link.json()) as { href: string; method?: string }
    // Только уточнение типа для fetch с библиотекой DOM (проверка scripts): байты те же
    const put = await this.http(href, { method: method ?? 'PUT', headers: { 'content-type': contentType }, body: body as Uint8Array<ArrayBuffer> })
    // 201 — файл принят, 202 — принят и ещё обрабатывается
    if (put.status !== 201 && put.status !== 202) throw diskError(put.status, 'загрузка файла')
    return { status: put.status }
  }
}
