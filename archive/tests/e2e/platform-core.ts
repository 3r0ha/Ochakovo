// Приём заявок на настоящем сервере прогона: согласие, повтор, ловушка, настройки сайта, слоты API второй волны.
// Плагин проверяет и сам механизм плагинов: запросы идут на сервер h.baseUrl, а результат виден в той же базе h.sql.
// Только он: E2E_ONLY=platform-core pnpm test:e2e

import { CONSENT_VERSION } from '../../shared/applications'
import type { E2eHarness } from './_harness'

export default async (h: E2eHarness) => {
  const s = new h.Scenario('platform-core: приём заявок на сервере', true)
  const { context, page } = await h.open(s, h.DESKTOP)
  const api = page.request
  // Уникальный телефон прогона: +7 901 XXX-XX-XX
  const digits = `7901${String(1_000_000 + Math.floor(Math.random() * 8_999_999))}`
  const phone = `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
  const name = `Ника Проверочная${digits.slice(-4)}`
  // Обязательные поля кейса для заявки с сайта; дата рождения — 20 лет назад от текущего момента
  const caseFields = { lastName: 'Проверочная', birthDate: new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10), school: 'МГУПП', startReady: 'now' }
  let id = ''

  await s.step('без согласия — 422 с ошибкой в поле consent, в базе пусто', async () => {
    const res = await api.post('/api/applications', { data: { name, phone } })
    h.expect(res.status()).toBe(422)
    const body = (await res.json()) as { error: string; errors: Record<string, string> }
    h.expect(body.error).toBe('validation')
    h.expect(body.errors.consent).toBeTruthy()
    h.expect((await h.sql`select id from applications where name = ${name}`).length).toBe(0)
  })

  await s.step('с согласием — 201, в базе этого же прогона время, версия и источник', async () => {
    const res = await api.post('/api/applications', { data: { name, phone, ...caseFields, consent: true, consentVersion: CONSENT_VERSION, refCode: 'kvas29' } })
    h.expect(res.status()).toBe(201)
    const body = (await res.json()) as { id: string; statusToken: string; refCode?: string }
    id = body.id
    h.expect(body.statusToken).toMatch(/^[\w-]{20,}$/)
    h.expect(body.refCode).toBe('kvas29')
    const [row] = await h.sql<{ phone: string; consent_at: Date | null; consent_version: string; consent_source: string; ref_code: string | null }[]>`
      select phone, consent_at, consent_version, consent_source, ref_code from applications where id = ${id}`
    h.expect(row, 'заявки нет в базе прогона').toBeTruthy()
    h.expect(row.phone).toBe(`+${digits}`)
    h.expect(row.consent_at).toBeTruthy()
    h.expect(row.consent_version).toBe(CONSENT_VERSION)
    h.expect(row.consent_source).toBe('site_form')
    h.expect(row.ref_code).toBe('kvas29')
  })

  await s.step('повтор того же номера другой записью — 409 без номера заявки и токена', async () => {
    const res = await api.post('/api/applications', { data: { name, phone: `8${digits.slice(1)}`, ...caseFields, consent: true, consentVersion: CONSENT_VERSION } })
    h.expect(res.status()).toBe(409)
    const text = await res.text()
    h.expect(JSON.parse(text)).toEqual({ error: 'already_applied' })
    h.expect(text.includes(id)).toBe(false)
  })

  await s.step('ловушка website — 201 как обычно, в базе пометка «похоже на спам»', async () => {
    const trap = `+7 902 ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    const res = await api.post('/api/applications', { data: { name: `${name} бот`, phone: trap, ...caseFields, consent: true, consentVersion: CONSENT_VERSION, website: 'https://spam.example' } })
    h.expect(res.status()).toBe(201)
    const { id: trapId } = (await res.json()) as { id: string }
    const [row] = await h.sql<{ suspected_spam: boolean }[]>`select suspected_spam from applications where id = ${trapId}`
    h.expect(row.suspected_spam).toBe(true)
  })

  await s.step('GET /api/config: ботов в прогоне нет — имён нет, секретов нет', async () => {
    const res = await api.get('/api/config')
    h.expect(res.status()).toBe(200)
    const text = await res.text()
    h.expect(JSON.parse(text)).toEqual({ bots: { telegram: null, max: null }, assistant: 'offline' })
    h.expect(text).not.toMatch(/token|secret|password|key/i)
  })

  await s.step('слоты второй волны подключены: неизвестный путь под /api/hr — JSON 404', async () => {
    const res = await api.get('/api/hr/no-such-section')
    h.expect(res.status()).toBe(404)
    h.expect(await res.json()).toEqual({ error: 'not_found' })
  })

  await context.close()
  return [s]
}
