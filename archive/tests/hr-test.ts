// Проверки HR-части: вход и роли, статусы с историей и отменой, собеседования и напоминания,
// очередь задач, недозвоны, фильтры, массовые действия, дубли, анкета, выгрузки, Яндекс Диск.
// Нужна база: TEST_DATABASE_URL или DATABASE_URL (по умолчанию ochakovo_test). Запуск: pnpm test:hr

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CONSENT_VERSION, type HrApplication } from '@shared/applications'
import { applyFilter, builtInViews, filterToParams, paramsToFilter, sortApps, stageCounts } from '@shared/hrFilter'
import { mapRow } from '@shared/hrImport'
import { candidateStatus, deadlineWords, RESPONSE_WORDS, RESPONSE_WORKDAYS, responseDeadline, workdaysBetween } from '@shared/candidateStatus'
import { memoryStorage } from '../server/dialog/storage'
import { deptName, oneCText, safeCell } from '@shared/hr'
import { seasonOf } from '@shared/hrPlan'
import { readFileSync } from 'node:fs'
import { slotWarning, workdayAfter, defaultWorkSettings, dayKind, dayOffLabel, hourKey, hrReminderTime, isWorkDay, mskAt, mskParts, nextWorkTime, spreadSlots, workSettingsProblem } from '@shared/workdays'
import { vacancyById } from '@shared/content/vacancies'
import { contacts } from '@shared/content/content'
import { toHhVacancy } from '@shared/hhVacancy'
import { createApp } from '../server/app'
import { encodeCp1251 } from '../server/export/cp1251'
import { unzip, writeXlsx, zipFiles, ZipLimitError } from '../server/export/xlsxWriter'
import { changeStatus } from '../server/hr/actions'
import { maskPhone, sendSms, smsPhone, SmsError, type SmsConfig } from '../server/sms'
import { HhClient, HhError } from '../server/integrations/hh'
import { retentionCutoff, retentionIfDue, runRetention } from '../server/retention'
import { hashPassword } from '../server/auth/password'
import type { Adapter, Registry } from '../server/channels/registry'
import { connect, migrate, normalizeApplication, PostgresStorage } from '../server/db'
import { HrRepo } from '../server/db/hr'
import { JobsRepo } from '../server/db/jobs'
import type { OutMessage } from '../server/dialog/types'
import { pruneSnapshots, syncNow } from '../server/integrations/sync'
import { DiskError, splitDiskPath, YandexDisk } from '../server/integrations/yandexDisk'
import { hrDeps, runDueJobs } from '../server/jobs/scheduler'
import type { RateRule } from '../server/middleware/rate-limit'
import { reminderTime } from '../server/notify'

// Сообщения уходят сразу, без 20 секунд на отмену: очередь всё равно разбираем вручную
process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://localhost:5432/ochakovo_test'

let passed = 0
let failed = 0
let skipped = 0
/** Проверка не выполнялась — причина видна в выводе и в итоге */
function skip(name: string, why: string) {
  skipped++
  console.log(`  − ${name} — пропущено: ${why}`)
}
function check(name: string, ok: boolean, details?: unknown) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`, details ?? '')
  }
}

// ── Даты проверок ───────────────────────────────────────────────────────
// Дат в коде нет: всё считается от текущего момента. Проверкам календаря нужны дни недели рядом с праздниками,
// поэтому берётся ближайший будущий невисокосный год, который начинается со вторника. В таком году
// День Победы — четверг, День России — среда, День народного единства — понедельник
const calYear = (() => {
  const leap = (y: number) => new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29
  let y = new Date().getUTCFullYear() + 1
  while (new Date(Date.UTC(y, 0, 1)).getUTCDay() !== 2 || leap(y)) y++
  return y
})()
/** День календарного года проверок по «ММ-ДД»; shift — соседний год (−1 — предыдущий) */
const cal = (monthDay: string, shift = 0) => `${calYear + shift}-${monthDay}`
/** День по Москве за n суток до текущего момента, «ГГГГ-ММ-ДД» */
const daysAgo = (n: number) => mskParts(Date.now() - n * 864e5).day
/** «ГГГГ-ММ-ДД» → «ДД.ММ.ГГГГ», как в выгрузках hh.ru и заголовках отчётов */
const ruDay = (day: string) => day.split('-').reverse().join('.')

const sql = connect(url)
try {
  await migrate(sql)
} catch (e) {
  console.error(`Нет доступа к базе ${url.replace(/\/\/[^@]*@/, '//***@')}: ${(e as Error).message}`)
  console.error('Создайте тестовую базу: createdb ochakovo_test (или задайте TEST_DATABASE_URL)')
  process.exit(1)
}
const storage = new PostgresStorage(sql)
const repo = new HrRepo(sql)
const jobs = new JobsRepo(sql)

// Бот-заглушка: запоминает исходящие сообщения вместо отправки в Telegram
const sent: { userId: string; messages: OutMessage[] }[] = []
const fakeTelegram = {
  startPolling: async () => {},
  handleWebhook: async () => {},
  sendTo: async (userId: string, messages: OutMessage[]) => {
    if (userId === 'blocked') throw new Error('403: bot was blocked by the user')
    await new Promise((r) => setTimeout(r, 5))
    sent.push({ userId, messages })
  },
} as unknown as Adapter
const bots: Registry = {
  get: (channel) => (channel === 'telegram' ? { adapter: fakeTelegram, secret: undefined } : undefined),
  active: () => ['telegram'],
  failed: () => [],
  start: () => {},
}
const deps = hrDeps(sql, bots)
const runJobs = () => runDueJobs(deps, 100)

const rules: RateRule[] = [{ name: 'api', burst: 1000, perMinute: 1000, match: (_m, p) => p.startsWith('/api/') }]
const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { ...process.env, NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })

const tag = randomBytes(4).toString('hex')
const password = 'проверка-пароля-1'
const admin = await repo.createUser({ email: `admin-${tag}@test.local`, name: 'Админ Тест', role: 'admin', passwordHash: await hashPassword(password) })
const hr = await repo.createUser({ email: `hr-${tag}@test.local`, name: 'Ирина HR', role: 'hr', passwordHash: await hashPassword(password) })

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
})

async function login(email: string) {
  const res = await app.request('/api/hr/login', json({ email, password }))
  const cookie = res.headers.get('set-cookie') ?? ''
  return { res, cookie: cookie.split(';')[0], raw: cookie }
}

let adminCookie = ''
let hrCookie = ''

type Details = {
  application: HrApplication
  history: { id: number; kind: string; fromStatus: string | null; toStatus: string; userName: string; comment: string; notify: string | null; undoneAt: string | null }[]
  historyId: number | null
  notify: { notify: string; detail: string; text?: string } | null
}
const call = (method: string, path: string, body?: unknown, cookie = hrCookie) =>
  app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
const patch = async (id: string, body: unknown, cookie = hrCookie) => {
  const res = await call('PATCH', `/api/hr/applications/${id}`, body, cookie)
  return { status: res.status, body: (await res.json()) as Details }
}
const inDays = (days: number, hourMsk = 11) => {
  const wall = new Date(Date.now() + 3 * 3600e3 + days * 864e5)
  wall.setUTCHours(hourMsk, 0, 0, 0)
  return new Date(wall.getTime() - 3 * 3600e3)
}
/** n-й рабочий день вперёд в 11:00 по Москве: собеседование в выходной сервер без подтверждения не примет */
const workDays = (n: number, hour = 11) => workdayAfter(n, hour, Date.now(), defaultWorkSettings)
const slot = (days = 3) => ({ startsAt: workDays(days).toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт и ИНН' })
/** Согласие кандидата: без него заявка с сайта и из бота не сохраняется */
const agreed = { consent: true, consentVersion: CONSENT_VERSION } as const
/** Обязательные поля кейса для заявки с сайта: фамилия, дата рождения (20 лет назад от текущего момента), учёба, когда может выйти */
const caseFields = { lastName: 'Проверкина', birthDate: new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10), school: 'МГУПП', startReady: 'now' } as const
const save = (raw: Record<string, unknown>) => storage.saveApplication(normalizeApplication({ phone: `+7999${Math.floor(1e6 + Math.random() * 8e6)}`, ...agreed, ...raw, name: `${raw.name} ${tag}` }))
const myApps = async (cookie = hrCookie) =>
  ((await (await app.request('/api/hr/applications', { headers: { cookie } })).json()) as HrApplication[]).filter((a) => a.name.endsWith(tag))

console.log('Вход')
{
  const bad = await app.request('/api/hr/login', json({ email: admin.email, password: 'не тот пароль' }))
  check('неверный пароль — 401', bad.status === 401)
  const nobody = await app.request('/api/hr/login', json({ email: `nobody-${tag}@test.local`, password }))
  check('нет такого сотрудника — тот же 401', nobody.status === 401)

  const ok = await login(admin.email.toUpperCase())
  adminCookie = ok.cookie
  check('вход по почте без учёта регистра — 200', ok.res.status === 200)
  check('cookie: HttpOnly, SameSite=Lax, путь /api', /HttpOnly/i.test(ok.raw) && /SameSite=Lax/i.test(ok.raw) && /Path=\/api/i.test(ok.raw), ok.raw)
  const stored = await sql`select 1 from hr_sessions where id = ${ok.cookie.split('=')[1]}`
  check('в базе хранится не сам токен, а его отпечаток', stored.length === 0)
  const me = await app.request('/api/hr/me', { headers: { cookie: adminCookie } })
  check('/me возвращает сотрудника', me.status === 200)
  check('без входа /me — 401', (await app.request('/api/hr/me')).status === 401)
  hrCookie = (await login(hr.email)).cookie
}

console.log('Права')
{
  check('HR видит заявки', (await app.request('/api/hr/applications', { headers: { cookie: hrCookie } })).status === 200)
  check('HR не видит сотрудников — 403', (await app.request('/api/hr/users', { headers: { cookie: hrCookie } })).status === 403)
  check('HR не может заливать демо — 403', (await call('POST', '/api/hr/applications/seed', { count: 1 })).status === 403)
  check('HR не видит интеграции — 403', (await app.request('/api/hr/integrations', { headers: { cookie: hrCookie } })).status === 403)
  check('старый токен demo больше не пускает', (await app.request('/api/applications', { headers: { 'x-hr-token': 'demo' } })).status === 401)
  const staff = (await (await app.request('/api/hr/staff', { headers: { cookie: hrCookie } })).json()) as { id: number; name: string; email?: string }[]
  check('список сотрудников для назначения — без почт', staff.some((s) => s.id === hr.id) && staff.every((s) => !('email' in s)))
}

console.log('Статусы, история, ответственный')
{
  const web = await save({ name: 'Веб', channel: 'web', source: 'fair-mgupp', months: [6, 7] })
  check('новая заявка — статус «Новая»', web.status === 'new')
  const noHeader = await app.request(`/api/hr/applications/${web.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }), headers: { cookie: hrCookie, 'content-type': 'application/json' } })
  check('изменение без x-hr-request — 403', noHeader.status === 403)
  check('неизвестный статус — 400', (await patch(web.id, { status: 'fired' })).status === 400)
  check('собеседование без даты и без отметки — 422', (await patch(web.id, { status: 'interview' })).status === 422)

  const r = await patch(web.id, { status: 'contacted', comment: 'Позвонили', notes: 'Хочет в варочный' })
  check('статус сменился, заметка сохранилась', r.body.application.status === 'contacted' && r.body.application.notes === 'Хочет в варочный')
  const last = r.body.history.at(-1)!
  check('история: кто, откуда, куда, комментарий', last.fromStatus === 'new' && last.toStatus === 'contacted' && last.userName === 'Ирина HR' && last.comment === 'Позвонили', last)
  check('первый взявший заявку становится ответственным', r.body.application.assigneeId === hr.id && r.body.application.assigneeName === 'Ирина HR')

  const toCall = await patch(web.id, { status: 'interview', slot: slot() })
  check('заявка с сайта: бот не напишет, панель отдаёт текст для звонка', toCall.body.notify?.notify === 'call' && Boolean(toCall.body.notify.text?.includes('Рябиновая')), toCall.body.notify)
  check('кандидату с сайта — задача «перезвонить» накануне собеседования', toCall.body.application.callbackNote === 'Напомнить о собеседовании' && Boolean(toCall.body.application.callbackAt))

  const reassign = await patch(web.id, { assigneeId: admin.id })
  check('ответственного можно сменить', reassign.body.application.assigneeName === 'Админ Тест' && reassign.body.history.at(-1)!.kind === 'assign')
  check('несуществующий сотрудник — 422', (await patch(web.id, { assigneeId: 999999 })).status === 422)
}

console.log('Уведомления в бот, очередь и отмена')
{
  const bot = await save({ name: 'Аня Бот', channel: 'telegram', channelUserId: '777', vacancyId: 'bottling-operator', months: [7] })
  const before = sent.length
  const inv = await patch(bot.id, { status: 'interview', slot: slot(3) })
  check('приглашение встало в очередь, а не ушло сразу', inv.body.notify?.notify === 'queued' && sent.length === before, inv.body.notify)
  check('слот собеседования сохранён', inv.body.application.interview?.address === 'Москва, ул. Рябиновая, 44')
  await runJobs()
  const msg = sent.at(-1)
  check('после очереди сообщение ушло тому самому пользователю', sent.length === before + 1 && msg?.userId === '777')
  const text = msg?.messages[0].text ?? ''
  check('в приглашении имя, номер, вакансия, дата, время, адрес и что взять', text.startsWith('Аня,') && text.includes(bot.id) && text.includes('«') && text.includes('11:00') && text.includes('Рябиновая') && text.includes('паспорт и ИНН') && !/[{}]/.test(text), text)
  const hist = (await patch(bot.id, {})).body.history.find((h) => h.id === inv.body.historyId)
  check('в истории отметка «доставлено»', hist?.notify === 'sent', hist)

  const reminder = await jobs.status(`reminder:${inv.body.application.interview!.id}`)
  const expected = reminderTime(new Date(inv.body.application.interview!.startsAt))!
  check('напоминание поставлено на 12:00 накануне по Москве', reminder?.status === 'pending' && reminder.run_at.getTime() === expected.getTime() && new Date(expected.getTime() + 3 * 3600e3).getUTCHours() === 12, reminder)

  const hired = await patch(bot.id, { status: 'hired' })
  check('«К оформлению» — сообщение в очереди', hired.body.notify?.notify === 'queued')
  const undo = await call('POST', '/api/hr/undo', { historyIds: [hired.body.historyId] })
  const undoBody = (await undo.json()) as { results: { ok: boolean; application?: HrApplication }[] }
  check('отмена вернула статус', undoBody.results[0].ok && undoBody.results[0].application?.status === 'interview', undoBody)
  const sentBeforeRun = sent.length
  await runJobs()
  check('отменённое сообщение не ушло', sent.length === sentBeforeRun)
  const afterUndo = (await patch(bot.id, {})).body.history.find((h) => h.id === hired.body.historyId)
  check('в истории действие помечено отменённым, сообщение — отменённым', Boolean(afterUndo?.undoneAt) && afterUndo?.notify === 'cancelled', afterUndo)
  const reminderAgain = await jobs.status(`reminder:${inv.body.application.interview!.id}`)
  check('после отмены напоминание о собеседовании снова в силе', reminderAgain?.status === 'pending', reminderAgain)

  const byAdmin = await patch(bot.id, { status: 'contacted' }, adminCookie)
  const foreign = (await (await call('POST', '/api/hr/undo', { historyIds: [byAdmin.body.historyId] })).json()) as { results: { ok: boolean; error?: string }[] }
  check('чужое действие HR отменить не может', !foreign.results[0].ok && Boolean(foreign.results[0].error))
  const oldOne = (await (await call('POST', '/api/hr/undo', { historyIds: [inv.body.historyId] }, adminCookie)).json()) as { results: { ok: boolean }[] }
  check('отменить можно только последнее действие', !oldOne.results[0].ok)

  const blocked = await save({ name: 'Блок', channel: 'telegram', channelUserId: 'blocked' })
  const b = await patch(blocked.id, { status: 'hired' })
  await runJobs()
  const bh = (await patch(blocked.id, {})).body
  check('бот заблокирован: статус сменился, в истории «не доставлено»', bh.application.status === 'hired' && bh.history.find((h) => h.id === b.body.historyId)?.notify === 'failed')

  const maxApp = await save({ name: 'Макс', channel: 'max', channelUserId: '555' })
  const m = await patch(maxApp.id, { status: 'interview', withoutSlot: true })
  check('бот MAX не подключён — текст для звонка, без ошибки', m.body.notify?.notify === 'call' && Boolean(m.body.notify.text?.includes('позвонят')), m.body.notify)

  const off = await call('PUT', '/api/hr/templates/declined', { enabled: false }, adminCookie)
  check('админ выключает уведомление об отказе', off.status === 200)
  const d = await patch(bot.id, { status: 'declined', declineReason: 'schedule' })
  check('выключенное уведомление не уходит, причина отказа сохранена', d.body.notify?.notify === 'skipped' && d.body.application.declineReason === 'schedule')
  await call('PUT', '/api/hr/templates/declined', { enabled: true }, adminCookie)
  const badTemplate = await call('PUT', '/api/hr/templates/hired', { text: 'Привет, {имя}! Ты принят, ждём тебя.' }, adminCookie)
  check('шаблон с неизвестной подстановкой — 422', badTemplate.status === 422)
  const okTemplate = (await (await call('PUT', '/api/hr/templates/reminder', { text: '{name}, завтра в {time} ждём на собеседование: {address}. С собой: {bring}.' }, adminCookie)).json()) as { preview: string }
  check('шаблон напоминания сохраняется, предпросмотр без подстановок', !/[{}]/.test(okTemplate.preview), okTemplate)

  const spoof = await app.request('/api/applications', json({ ...caseFields, name: `Подделка ${tag}`, phone: '+79990009900', channel: 'telegram', channelUserId: '777', ...agreed }))
  const spoofBody = (await spoof.json()) as { id: string }
  const spoofRow = await deps.workflow.get(spoofBody.id)
  check('с сайта нельзя выдать себя за пользователя бота', spoofRow?.channel === 'web' && !spoofRow.channelUserId)
  check('кандидату не отдаются поля HR', !('status' in spoofBody) && !('notes' in spoofBody))
}

console.log('Напоминания и идемпотентность очереди')
{
  const a = await save({ name: 'Напомнить', channel: 'telegram', channelUserId: '888' })
  const r = await patch(a.id, { status: 'interview', slot: slot(2) })
  await runJobs()
  const key = `reminder:${r.body.application.interview!.id}`
  check('повторная постановка того же напоминания не создаёт дубль', (await jobs.enqueue('reminder', new Date(), { applicationId: a.id, interviewId: r.body.application.interview!.id }, key)) === null)
  await sql`update jobs set run_at = now() - interval '1 second' where dedupe_key = ${key}`
  const before = sent.length
  await Promise.all([runJobs(), runJobs(), runJobs()])
  check('три планировщика разом — напоминание ушло ровно один раз', sent.length === before + 1 && sent.at(-1)?.messages[0].text.includes('завтра'), sent.length - before)
  check('задача отмечена выполненной', (await jobs.status(key))?.status === 'done')

  const moved = await patch(a.id, { slot: slot(5) })
  check('перенос: новое приглашение в очереди', moved.body.notify?.notify === 'queued' && moved.body.history.at(-1)!.kind === 'interview')
  const newKey = `reminder:${moved.body.application.interview!.id}`
  check('перенос: новое напоминание', (await jobs.status(newKey))?.status === 'pending')
  await patch(a.id, { status: 'declined', declineReason: 'candidate_refused' })
  await sql`update jobs set run_at = now() - interval '1 second' where dedupe_key = ${newKey}`
  const before2 = sent.length
  await runJobs()
  check('кандидат отказался — напоминание не уходит', !sent.slice(before2).some((s) => s.messages[0].text.includes('завтра')) && (await jobs.status(newKey))?.status !== 'done')

  const now = mskAt(cal('06-10'), 12).getTime()
  check('напоминание: собеседование через неделю — накануне в 12:00', reminderTime(mskAt(cal('06-17'), 11), now)!.toISOString() === mskAt(cal('06-16'), 12).toISOString())
  check('напоминание: завтра утром — прямо сейчас', reminderTime(mskAt(cal('06-11'), 10), now + 3600e3)!.getTime() === now + 3600e3)
  check('напоминание: меньше 6 часов — не нужно', reminderTime(new Date(now + 4 * 3600e3), now) === null)
}

console.log('Недозвоны и «перезвонить»')
{
  const a = await save({ name: 'Недозвон', channel: 'web' })
  await patch(a.id, { missedCall: true })
  const r = await patch(a.id, { missedCall: true, callbackAt: inDays(0, 18).toISOString(), callbackNote: 'вечером' })
  check('два недозвона — счётчик 2, статус «Не отвечает»', r.body.application.noAnswerCount === 2 && r.body.application.status === 'no_answer')
  check('повторный недозвон в истории отдельной записью', r.body.history.filter((h) => h.kind === 'missed').length === 1)
  const list = await myApps()
  check('фильтр «перезвонить сегодня» находит заявку', applyFilter(list, { callbackDue: true }).some((x) => x.id === a.id))
  const undo = (await (await call('POST', '/api/hr/undo', { historyIds: [r.body.historyId] })).json()) as { results: { application?: HrApplication }[] }
  check('отмена недозвона возвращает счётчик', undo.results[0].application?.noAnswerCount === 1)
}

console.log('Фильтры и счётчики')
{
  const src = `test-${tag}`
  const july = await save({ name: 'Июль', channel: 'web', source: src, months: [7, 8], vacancyId: 'bottling-operator' })
  const june = await save({ name: 'Июнь', channel: 'web', source: src, months: [6] })
  await sql`update applications set created_at = now() - interval '30 hours' where id = ${june.id}`
  await patch(july.id, { status: 'hired' })
  await patch(july.id, { status: 'started' })
  const list = await myApps()
  const by = (f: Parameters<typeof applyFilter>[1]) => applyFilter(list, f, { meId: hr.id }).map((a) => a.id)
  check('месяц «июль» — только кто готов в июле', by({ months: [7], source: src }).join() === july.id)
  check('вакансия', by({ vacancy: 'bottling-operator', source: src }).join() === july.id)
  check('ждут ответа дольше 24 часов', by({ waitingHours: 24, source: src }).join() === june.id)
  check('мои заявки', by({ assignee: 'me', source: src }).join() === july.id)
  check('поиск по последним цифрам телефона', by({ q: june.phone.slice(-4) }).includes(june.id))
  check('фильтр переживает адресную строку', filterToParams({ months: [7], waitingHours: 24, assignee: 'me' }).toString() === 'months=7&waiting=24&assignee=me')

  // Один человек: зашёл на страницу по метке и открыл чат на сайте — в «Пришли» он один
  await sql`insert into funnel_events (visitor, channel, type, source) values (${'v-' + tag}, 'web', 'visit', ${src})`
  await sql`insert into bot_users (channel, user_id, source) values ('web', ${'w-' + tag}, ${src})`
  const funnel = (await (await app.request('/api/hr/funnel', { headers: { cookie: hrCookie } })).json()) as {
    rows: { source: string; visitors: number; applications: number; hired: number; started: number }[]
  }
  const row = funnel.rows.find((r) => r.source === src)
  check('чат на сайте не удваивает посетителей', row?.visitors === 1, row)
  const tiles = stageCounts(applyFilter(list, { source: src }))
  check('плитки и воронка считают одинаково', row?.applications === tiles.applications && row.hired === tiles.hired && row.started === tiles.started && tiles.started === 1, { row, tiles })

  const views = await call('POST', '/api/hr/views', { name: 'Июль', query: 'months=7&status=new' })
  const view = (await views.json()) as { id: number; filter: { months: number[] } }
  check('сохранённый вид создаётся с фильтром', views.status === 201 && view.filter.months[0] === 7)
  check('пустой вид — 422', (await call('POST', '/api/hr/views', { name: 'Пусто', query: '' })).status === 422)
  const mine = (await (await app.request('/api/hr/views', { headers: { cookie: hrCookie } })).json()) as { id: number }[]
  const others = (await (await app.request('/api/hr/views', { headers: { cookie: adminCookie } })).json()) as { id: number }[]
  check('виды у каждого свои', mine.some((v) => v.id === view.id) && !others.some((v) => v.id === view.id))
  check('вид удаляется', (await call('DELETE', `/api/hr/views/${view.id}`)).status === 200)
}

console.log('Массовые действия')
{
  const a1 = await save({ name: 'Масса1', channel: 'telegram', channelUserId: '901' })
  const a2 = await save({ name: 'Масса2', channel: 'telegram', channelUserId: '902' })
  const a3 = await save({ name: 'Масса3', channel: 'web' })
  const ids = [a1.id, a2.id, a3.id]
  const r = (await (await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'contacted' })).json()) as { done: { historyId: number }[]; applications: HrApplication[] }
  check('статус сменился у всех трёх', r.done.length === 3 && r.applications.every((a) => a.status === 'contacted'))
  const undo = (await (await call('POST', '/api/hr/undo', { historyIds: r.done.map((d) => d.historyId) })).json()) as { results: { ok: boolean }[] }
  check('отмена массового действия разом', undo.results.every((x) => x.ok))

  check('групповое собеседование без даты — 422', (await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'interview' })).status === 422)
  const before = sent.length
  const inv = (await (await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'interview', slot: slot(4) })).json()) as { done: { notify: { notify: string } }[]; calls: { id: string; text: string }[] }
  await runJobs()
  check('групповое собеседование: двоим в бот, третьему — звонок с текстом', sent.length === before + 2 && inv.calls.length === 1 && inv.calls[0].id === a3.id && inv.calls[0].text.includes('Рябиновая'))
  const msg = (await (await call('POST', '/api/hr/bulk', { ids, action: 'message', text: 'Смена переносится на 9:00' })).json()) as { calls: unknown[] }
  await runJobs()
  check('массовое сообщение: двоим в бот, одному — позвонить', sent.slice(-2).every((s) => s.messages[0].text === 'Смена переносится на 9:00') && msg.calls.length === 1)
  const asg = (await (await call('POST', '/api/hr/bulk', { ids, action: 'assign', assigneeId: admin.id })).json()) as { applications: HrApplication[] }
  check('назначить ответственного всем', asg.applications.every((a) => a.assigneeId === admin.id))
}

console.log('Дубли по телефону')
{
  // Номер свой на каждый прогон: тестовая база между запусками не очищается, а дубли считаются по всей базе
  const r = String(Math.floor(1e6 + Math.random() * 8e6))
  const p = await save({ name: 'Дубль', channel: 'web', phone: `+7 (916) ${r.slice(0, 3)}-${r.slice(3, 5)}-${r.slice(5)}`, contact: '' })
  const d = await save({ name: 'Дубль', channel: 'telegram', channelUserId: '903', phone: `8916${r}`, contact: '@dubl', school: 'МГУПП' })
  const list = await myApps()
  check('разные записи одного номера — дубли', list.find((a) => a.id === p.id)?.duplicates === 1 && list.find((a) => a.id === d.id)?.duplicates === 1)
  const groups = (await (await app.request('/api/hr/duplicates', { headers: { cookie: hrCookie } })).json()) as { phone: string; applications: { id: string }[] }[]
  check('группа дублей в отдельном разделе', groups.some((g) => g.phone === `7916${r}` && g.applications.length === 2))
  const m = await call('POST', `/api/hr/applications/${d.id}/merge`, { into: p.id })
  const merged = ((await m.json()) as { application: HrApplication }).application
  check('склейка: пустые поля основной заполнены, бот перенесён', merged.contact === '@dubl' && merged.school === 'МГУПП' && merged.channel === 'telegram' && merged.channelUserId === '903')
  const after = await myApps()
  check('дубль скрыт из списка, но не удалён', applyFilter(after, {}).every((a) => a.id !== d.id) && after.find((a) => a.id === d.id)?.duplicateOf === p.id)
  check('с собой склеить нельзя', (await call('POST', `/api/hr/applications/${p.id}/merge`, { into: p.id })).status === 422)
  check('дубль можно отделить', (await call('POST', `/api/hr/applications/${d.id}/unmerge`)).status === 200)
}

console.log('Анкета и портфолио')
{
  const res = await app.request(
    '/api/applications',
    json({ ...caseFields, name: `Анкета ${tag}`, phone: '+79990004455', lastName: 'Смирнова', adult: true, citizenship: 'ru', medBook: 'will_get', shifts: 'night', portfolio: 'behance.net/smirnova', ...agreed }),
  )
  const id = ((await res.json()) as { id: string }).id
  const a = await deps.workflow.get(id)
  check('анкета сохранилась из формы', a?.lastName === 'Смирнова' && a.adult === true && a.citizenship === 'ru' && a.medBook === 'will_get' && a.shifts === 'night')
  check('портфолио без протокола дополнено https://', a?.portfolio === 'https://behance.net/smirnova', a?.portfolio)
  const bad = await app.request('/api/applications', json({ ...caseFields, name: `Анкета2 ${tag}`, phone: '+79990004456', portfolio: 'не ссылка', ...agreed }))
  check('портфолио не ссылкой — 422 с ошибкой поля', bad.status === 422 && Boolean(((await bad.json()) as { errors: Record<string, string> }).errors.portfolio))
  const junk = await app.request('/api/applications', json({ ...caseFields, name: `Анкета3 ${tag}`, phone: '+79990004457', citizenship: 'марс', medBook: 42, ...agreed }))
  const junkApp = await deps.workflow.get(((await junk.json()) as { id: string }).id)
  check('неизвестные значения анкеты отбрасываются', junkApp?.citizenship === '' && junkApp.medBook === '')
  // 18+ при дате рождения выводится из неё: HR поправил дату — кандидату по анкете нет 18
  const p = await patch(id, { profile: { medBook: 'yes', birthDate: new Date(Date.now() - 17 * 365.25 * 864e5).toISOString().slice(0, 10) } })
  check('HR дополняет анкету', p.body.application.medBook === 'yes' && p.body.application.adult === false && p.body.history.at(-1)!.kind === 'profile')
}

console.log('Выгрузки')
{
  const src = `exp-${tag}`
  const x = await save({ name: 'Выгрузка', channel: 'web', source: src, months: [7], game: { quizResult: 'production', conveyorBest: 140, activities: 3 } })
  await save({ name: 'Выгрузка2', channel: 'web', source: `${src}-other` })
  const exp = (format: string, query: string, extra: string[] = []) => call('POST', '/api/hr/export', { format, query, extra })

  const csvBytes = new Uint8Array(await (await exp('csv', `source=${src}`)).arrayBuffer())
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes)
  const rows = csv.replace(/^\uFEFF/, '').split('\r\n')
  check('CSV: BOM, «;», только отфильтрованные', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && rows[0].includes('";"') && rows.length === 2 && rows[1].includes(x.id), rows.length)
  check('CSV: без счёта в игре по умолчанию', !rows[0].includes('Поймай брак') && !rows[0].includes('по тесту'))
  const withExtra = await (await exp('csv', `source=${src}`, ['game', 'quiz'])).text()
  check('CSV: счёт в игре — по запросу', withExtra.includes('Поймай брак') && withExtra.includes('"140"'))
  const jsonRows = (await (await exp('json', `ids=${x.id}`)).json()) as Record<string, unknown>[]
  check('JSON: выбранные строки, даты в ISO', jsonRows.length === 1 && jsonRows[0].id === x.id && /^\d{4}-\d\d-\d\dT/.test(String(jsonRows[0].createdAt)))
  check('HR не может скачать без входа', (await app.request('/api/hr/export', json({ format: 'csv' }))).status === 401)

  const xlsx = await exp('xlsx', `source=${src}`)
  const book = unzip(Buffer.from(await xlsx.arrayBuffer()))
  const text = (name: string) => book.get(name)?.toString('utf8') ?? ''
  const workbook = text('xl/workbook.xml')
  const sheet = text('xl/worksheets/sheet1.xml')
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1])
  const styles = text('xl/styles.xml')
  const xfs = [...styles.matchAll(/<xf [^>]*?(?:\/>|>.*?<\/xf>)/g)].map((m) => m[0]).slice(1) // первый xf — из cellStyleXfs
  const cellAt = (ref: string) => sheet.match(new RegExp(`<c r="${ref}"(?: s="(\\d+)")?(?: t="(\\w+)")?>(?:<v>([^<]*)</v>)?`))
  const header = [...sheet.matchAll(/<c r="([A-Z]+)1"[^>]*t="s"><v>(\d+)<\/v>/g)].map((m) => ({ col: m[1], label: strings[Number(m[2])] }))
  const col = (label: string) => header.find((h) => h.label === label)?.col ?? '?'
  check('Excel: отдаётся .xlsx, листы «Заявки» и «Воронка»', xlsx.status === 200 && workbook.includes('name="Заявки"') && workbook.includes('name="Воронка"'), xlsx.status)
  check('Excel: шапка закреплена, автофильтр включён', sheet.includes('state="frozen"') && sheet.includes('ySplit="1"') && /<autoFilter ref="A1:[A-Z]+2"\/>/.test(sheet))
  const date = cellAt(`${col('Дата заявки')}2`)
  const fmtId = xfs[Number(date?.[1] ?? 0)]?.match(/numFmtId="(\d+)"/)?.[1]
  check(
    'Excel: дата — настоящая дата с форматом',
    Boolean(date?.[3]) && !date?.[2] && Number(date?.[3]) > 45000 && styles.includes(`numFmtId="${fmtId}" formatCode="dd.mm.yyyy hh:mm"`),
    date?.[0],
  )
  const status = cellAt(`${col('Статус')}2`)
  check('Excel: статус подсвечен', strings[Number(status?.[3])] === 'Новая' && /fillId="[1-9]\d*"/.test(xfs[Number(status?.[1] ?? 0)] ?? ''), status?.[0])
  const vacancyCol = header.findIndex((h) => h.label === 'Вакансия') + 1
  const width = Number(sheet.match(new RegExp(`<col min="${vacancyCol}" max="${vacancyCol}" width="([\\d.]+)"`))?.[1] ?? 0)
  check('Excel: ширина колонок задана', width >= 20, width)
  check('Excel: одна строка данных', !sheet.includes('<row r="3"') && sheet.includes('<row r="2"'))
}

console.log('Яндекс Диск')
{
  const log: { method: string; path: string; auth?: string; body?: number }[] = []
  let token = 'old-token'
  let folderExists = false
  let mode: 'ok' | 'full' | 'locked' = 'ok'
  const server = createServer(async (req: IncomingMessage, res) => {
    const u = new URL(req.url!, 'http://x')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    log.push({ method: req.method!, path: u.pathname + u.search, auth: req.headers.authorization, body: body.length })
    const send = (code: number, data?: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(data ? JSON.stringify(data) : '')
    }
    if (u.pathname === '/token') {
      const form = new URLSearchParams(body.toString())
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1' && form.get('client_id') === 'cid') {
        token = 'new-token'
        return send(200, { access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 31536000 })
      }
      return send(400, { error_description: 'bad refresh' })
    }
    if (u.pathname === '/upload-target') return send(mode === 'full' ? 507 : mode === 'locked' ? 423 : 201)
    if (req.headers.authorization !== `OAuth ${token}`) return send(401, { error: 'UnauthorizedError' })
    if (u.pathname === '/v1/disk/resources' && req.method === 'PUT') {
      const created = !folderExists
      folderExists = true
      return send(created ? 201 : 409)
    }
    if (u.pathname === '/v1/disk/resources/upload') {
      if (!folderExists) return send(409, { error: 'DiskPathDoesntExistsError' })
      return send(200, { href: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload-target`, method: 'PUT' })
    }
    if (u.pathname === '/v1/disk') return send(200, { total_space: 1000, used_space: 250, user: { display_name: 'HR Очаково' } })
    if (u.pathname === '/v1/disk/resources' && req.method === 'GET' && u.searchParams.get('path')?.endsWith('/Архив')) {
      const root = u.searchParams.get('path')!
      const today = new Date().toISOString().slice(0, 10)
      const old = daysAgo(800)
      return send(200, {
        _embedded: {
          items: [
            { name: `Заявки ${old}.xlsx`, path: `${root}/Заявки ${old}.xlsx`, type: 'file' },
            { name: `Заявки ${today}.xlsx`, path: `${root}/Заявки ${today}.xlsx`, type: 'file' },
            { name: 'Заметки.docx', path: `${root}/Заметки.docx`, type: 'file' },
          ],
        },
      })
    }
    if (u.pathname === '/v1/disk/resources' && req.method === 'DELETE') return send(204)
    send(404)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let saved: unknown = null
  const disk = new YandexDisk({
    token: 'expired',
    refreshToken: 'refresh-1',
    clientId: 'cid',
    clientSecret: 'secret',
    apiBase: `${base}/v1/disk`,
    oauthUrl: `${base}/token`,
    onTokens: async (t) => void (saved = t),
  })

  check('путь общего диска разбирается по уровням', JSON.stringify(splitDiskPath('vd:abc123:disk:/Очаково HR/Сезон')) === JSON.stringify({ root: 'vd:abc123:disk:', parts: ['Очаково HR', 'Сезон'] }))
  await disk.upload('vd:abc123:disk:/Очаково HR/Заявки.xlsx', new Uint8Array([1, 2, 3]), 'application/octet-stream')
  check('просроченный токен обновлён по refresh_token и сохранён', token === 'new-token' && (saved as { refreshToken?: string })?.refreshToken === 'refresh-2')
  const folderCalls = log.filter((l) => l.method === 'PUT' && l.path.startsWith('/v1/disk/resources?'))
  const folderPath = new URLSearchParams(folderCalls[0]?.path.split('?')[1]).get('path')
  check('нет папки — создана по уровням, затем загрузка', folderPath === 'vd:abc123:disk:/Очаково HR', folderPath)
  const put = log.find((l) => l.path === '/upload-target')
  check('байты ушли по ссылке загрузки без токена', put?.method === 'PUT' && put.body === 3 && !put.auth)
  check('перезапись включена', log.some((l) => l.path.startsWith('/v1/disk/resources/upload') && l.path.includes('overwrite=true')))
  check('публичные ссылки не создаются никогда', !log.some((l) => l.path.includes('publish')))

  mode = 'full'
  const full = await disk.upload('disk:/Очаково HR/Заявки.xlsx', new Uint8Array([1]), 'x').catch((e) => e)
  check('507 — понятная ошибка про место', full instanceof DiskError && full.message.includes('место'))
  mode = 'locked'
  const locked = await disk.upload('disk:/Очаково HR/Заявки.xlsx', new Uint8Array([1]), 'x').catch((e) => e)
  check('423 — можно повторить позже', locked instanceof DiskError && locked.retryable)
  mode = 'ok'

  const env = { ...process.env, YANDEX_DISK_TOKEN: 'new-token', YANDEX_DISK_ROOT: 'disk:/Тест HR' }
  await repo.patchIntegration('yandex_disk', { snapshots: false, accessToken: '', refreshToken: '', lastError: '' })
  const r = await syncNow({ sql, repo, workflow: deps.workflow, env, disk: { apiBase: `${base}/v1/disk`, oauthUrl: `${base}/token` } })
  const state = await repo.integration<{ lastOkAt?: string; lastRows?: number; lastPath?: string; lastError?: string }>('yandex_disk')
  check('выгрузка на Диск: файл загружен, состояние записано', r.ok && Boolean(state.lastOkAt) && state.lastPath === 'disk:/Тест HR/Заявки.xlsx', r)

  check('при выгрузке старые архивные копии тоже чистятся', log.some((l) => l.method === 'DELETE'))
  const mark = log.length
  const pruned = await pruneSnapshots(new YandexDisk({ token: 'new-token', apiBase: `${base}/v1/disk` }), 'disk:/Тест HR', retentionCutoff(new Date(), 12))
  const deletes = log.slice(mark).filter((l) => l.method === 'DELETE')
  const deleted = deletes.map((l) => new URLSearchParams(l.path.split('?')[1]))
  check(
    'архивные копии старше срока удаляются насовсем, свежие и чужие файлы — нет',
    pruned === 1 && deletes.length === 1 && deleted[0].get('permanently') === 'true' && Boolean(deleted[0].get('path')?.endsWith(`Заявки ${daysAgo(800)}.xlsx`)),
    deletes,
  )

  const lock = await sql.reserve()
  await lock`select pg_advisory_lock(hashtext('ochakovo:yandex-disk-sync'))`
  const busy = await syncNow({ sql, repo, workflow: deps.workflow, env, disk: { apiBase: `${base}/v1/disk` } })
  await lock`select pg_advisory_unlock(hashtext('ochakovo:yandex-disk-sync'))`
  lock.release()
  check('вторая выгрузка одновременно не запускается', !busy.ok && 'busy' in busy && busy.busy === true)
  await repo.patchIntegration('yandex_disk', { lastOkAt: '', lastPath: '', lastRows: null, lastAttemptAt: '' })
  server.close()
}

console.log('Поиск, анкета, сортировка')
{
  const a = await save({ name: 'Телефон', channel: 'web', phone: '+7 967 481-26-54', citizenship: 'ru', medBook: 'yes', shifts: 'night', adult: true })
  const b = await save({ name: 'Анкета пустая', channel: 'web', phone: '+7 925 000-00-01' })
  const list = await myApps()
  const ids = (f: Parameters<typeof applyFilter>[1]) => applyFilter(list, f).map((x) => x.id)
  check('поиск «89674812654» находит «+7 967 481-26-54»', ids({ q: '89674812654' }).includes(a.id))
  check('поиск «+7 (967) 481 26 54» и «9674812654» — тоже', ids({ q: '+7 (967) 481 26 54' }).includes(a.id) && ids({ q: '9674812654' }).includes(a.id))
  check('поиск по началу «8967» — как «7967»', ids({ q: '8967' }).includes(a.id) && !ids({ q: '8967' }).includes(b.id))
  check('фильтр анкеты: гражданство, медкнижка, смены, 18+', ids({ citizenship: 'ru', medBook: 'yes', shifts: 'night', adult: true }).join() === a.id)
  check('фильтр «медкнижка не указана»', ids({ medBook: 'none' }).includes(b.id) && !ids({ medBook: 'none' }).includes(a.id))
  const params = filterToParams({ citizenship: 'eaeu', medBook: 'none', adult: false, sort: { key: 'waiting', dir: 'desc' } }).toString()
  check('анкета и сортировка живут в адресной строке', params === 'citizenship=eaeu&medbook=none&adult=0&sort=waiting%3Adesc' && JSON.stringify(paramsToFilter(new URLSearchParams(params)).sort) === '{"key":"waiting","dir":"desc"}', params)
  const view = (await (await call('POST', '/api/hr/views', { name: 'Ночные с медкнижкой', query: 'medbook=yes&shifts=night&sort=interview%3Aasc' })).json()) as { filter: { medBook?: string; sort?: { key: string } } }
  check('анкета и сортировка сохраняются в виде', view.filter.medBook === 'yes' && view.filter.sort?.key === 'interview')

  const i1 = await save({ name: 'Позже', channel: 'web' })
  const i2 = await save({ name: 'Раньше', channel: 'web' })
  await patch(i1.id, { status: 'interview', slot: slot(5) })
  await patch(i2.id, { status: 'interview', slot: slot(2) })
  const sorted = sortApps(applyFilter(await myApps(), { statuses: ['interview'] }), { key: 'interview', dir: 'asc' }).map((x) => x.id)
  check('«Собеседования» по времени: ближайшее первым', sorted.indexOf(i2.id) < sorted.indexOf(i1.id))
  check('готовый вид «Собеседования» сортирует по времени', builtInViews.find((v) => v.id === 'interview')?.filter.sort?.key === 'interview')
  const waiting = sortApps(list, { key: 'waiting', dir: 'desc' })
  check('сортировка «ждёт»: новые заявки первыми, остальные в конце', waiting.findIndex((x) => x.status !== 'new') > waiting.findLastIndex((x) => x.status === 'new'))
}

console.log('Рабочее время: задачи HR на рабочие дни')
{
  const s = defaultWorkSettings
  // Собеседование в понедельник 11:00 → задача в пятницу 12:00 по Москве
  const monday = mskAt(cal('06-17'), 11)
  const weekBefore = mskAt(cal('06-10'), 12).getTime()
  const friday = hrReminderTime(monday, weekBefore, s)!
  check('собеседование в понедельник — напомнить в пятницу в 12:00', mskParts(friday).dow === 5 && mskParts(friday).hour === 12 && mskParts(friday).day === cal('06-14'), friday)
  const tue = hrReminderTime(mskAt(cal('06-18'), 15), weekBefore, s)!
  check('собеседование во вторник — в понедельник', mskParts(tue).day === cal('06-17'))
  const late = hrReminderTime(mskAt(cal('06-17'), 15), mskAt(cal('06-15'), 20).getTime(), s)!
  check('поздно для пятницы — ближайшее рабочее утро до встречи', mskParts(late).day === cal('06-17') && mskParts(late).hour === s.start, late)
  check('ночь пятницы → понедельник, начало дня', mskParts(nextWorkTime(mskAt(cal('06-14'), 22).getTime(), s)).dow === 1)
  const custom = { ...s, days: [1, 2, 3, 4, 5, 6], start: 10, end: 16 }
  check('свои рабочие дни и часы: суббота рабочая, задача в 12:00', mskParts(hrReminderTime(monday, weekBefore, custom)!).dow === 6)
  check('плохие настройки отклоняются', workSettingsProblem({ ...s, days: [] }) !== null && workSettingsProblem({ ...s, start: 17, end: 18 }) !== null)
  const bad = await call('PUT', '/api/hr/settings', { start: 20, end: 21 }, adminCookie)
  check('настройки: сервер отвечает понятной ошибкой', bad.status === 422 && Boolean(((await bad.json()) as { message?: string }).message?.includes('2 часа')))
  check('настройки сохраняет только администратор', (await call('PUT', '/api/hr/settings', { slotCapacity: 8 })).status === 403)
  const ok = (await (await call('PUT', '/api/hr/settings', { slotCapacity: 8 }, adminCookie)).json()) as { slotCapacity: number; start: number }
  check('админ меняет норму собеседований', ok.slotCapacity === 8 && ok.start === s.start)
  await call('PUT', '/api/hr/settings', { slotCapacity: s.slotCapacity }, adminCookie)

  // Через API: кандидат с сайта, собеседование в понедельник → задача «напомнить» в рабочий день
  const web = await save({ name: 'Понедельник', channel: 'web' })
  const nextMonday = (() => {
    let d = Date.now() + 7 * 864e5
    while (mskParts(d).dow !== 1) d += 864e5
    return mskAt(mskParts(d).day, 11)
  })()
  const r = await patch(web.id, { status: 'interview', allowOffHours: true, slot: { startsAt: nextMonday.toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  const at = new Date(r.body.application.callbackAt!)
  check('задача HR для понедельничного собеседования — в пятницу, в рабочее время', mskParts(at).dow === 5 && mskParts(at).hour >= s.start && mskParts(at).hour < s.end, r.body.application.callbackAt)
}

console.log('Массовые действия: звонки и ошибки')
{
  const w1 = await save({ name: 'Звонок Один', channel: 'web', vacancyId: 'bottling-operator' })
  const w2 = await save({ name: 'Звонок Два', channel: 'web' })
  const res = (await (await call('POST', '/api/hr/bulk', { ids: [w1.id, w2.id], action: 'status', status: 'interview', slot: slot(3) })).json()) as { calls: { id: string; name: string; phone: string; text: string }[] }
  const c1 = res.calls.find((c) => c.id === w1.id)
  const c2 = res.calls.find((c) => c.id === w2.id)
  check('список звонков: у каждого своё имя, телефон и номер заявки в тексте', Boolean(c1 && c2) && c1!.text.includes(w1.id) && c2!.text.includes(w2.id) && c1!.text.startsWith('Звонок,') && c1!.phone !== c2!.phone)
  const past = await call('POST', '/api/hr/bulk', { ids: [w1.id], action: 'status', status: 'interview', slot: { ...slot(), startsAt: new Date(Date.now() - 2 * 864e5).toISOString() } })
  const pastBody = (await past.json()) as { message?: string }
  check('прошедшая дата — 422 с понятным текстом', past.status === 422 && pastBody.message === 'Дата собеседования уже прошла', pastBody)
  const noAddress = await call('POST', '/api/hr/bulk', { ids: [w1.id], action: 'status', status: 'interview', slot: { ...slot(), address: '' } })
  check('пустой адрес — 422 «Укажи адрес собеседования»', noAddress.status === 422 && ((await noAddress.json()) as { message?: string }).message === 'Укажи адрес собеседования')
}

console.log('Кандидат вручную и импорт')
{
  const phone = `+7 916 ${String(Math.floor(100 + Math.random() * 800))}-${tag.slice(0, 2).replace(/\D/g, '1').padEnd(2, '1')}-77`
  const add = await call('POST', '/api/hr/applications', { name: `Звонок ${tag}`, lastName: 'Петрова', phone, source: 'phone', vacancyId: 'bottling-operator', months: [7] })
  const added = ((await add.json()) as { application: HrApplication }).application
  check('добавлен вручную: канал HR, источник «звонок», ответственный — кто добавил', add.status === 201 && added.channel === 'hr' && added.source === 'phone' && added.assigneeId === hr.id)
  const hist = (await patch(added.id, {})).body.history
  check('в истории — кто и откуда добавил и есть ли согласие', hist[0].userName === 'Ирина HR' && hist[0].comment === 'Добавлено вручную: Звонок в отдел персонала. Согласия нет', hist[0].comment)
  const again = await call('POST', '/api/hr/applications', { name: `Повтор ${tag}`, phone: phone.replace('+7', '8'), source: 'walk_in' })
  const againBody = (await again.json()) as { existing?: { id: string } }
  check('тот же телефон в другом виде — 409 с найденной заявкой', again.status === 409 && againBody.existing?.id === added.id)
  const forced = await call('POST', '/api/hr/applications', { name: `Повтор ${tag}`, phone, source: 'walk_in', force: true })
  check('«всё равно добавить» — создаётся и помечается дублем', forced.status === 201 && ((await forced.json()) as { application: HrApplication }).application.duplicates === 1)
  check('без источника — 422', (await call('POST', '/api/hr/applications', { name: `Нет ${tag}`, phone: '+79990001234', source: '' })).status === 422)
  check('кандидату, добавленному вручную, бот не напишет — текст для звонка', (await patch(added.id, { status: 'hired' })).body.notify?.notify === 'call')

  // CSV из hh.ru в Windows-1251 с «;». Даты откликов — около полугода назад
  const applied = [daysAgo(200), daysAgo(199), daysAgo(198)]
  const csvText = `Отчёт по откликам\r\nФИО;Телефон;Электронная почта;Вакансия;Дата отклика;Город\r\nСидорова Анна Петровна ${tag};+7 (926) 111-22-${tag.slice(0, 2).replace(/\D/g, '3').padEnd(2, '3')};anna.${tag}@mail.ru;Оператор линии розлива (практика);${ruDay(applied[0])} 14:05;Москва\r\nБез Телефона ${tag};;;Грузчик;${ruDay(applied[1])};Москва\r\nПовтор ${tag};${phone};;Водитель погрузчика;${ruDay(applied[2])};Москва\r\n`
  const csv = encodeCp1251(csvText)
  const parsed = await app.request('/api/hr/import/parse', { method: 'POST', body: csv, headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': encodeURIComponent('hh.csv') } })
  const table = (await parsed.json()) as { headers: string[]; rows: string[][]; mapping: Record<string, number> }
  check('CSV в Windows-1251: шапка найдена под заголовком отчёта', parsed.status === 200 && table.headers[0] === 'ФИО' && table.rows.length === 3, table.headers)
  check('колонки hh.ru узнаны: ФИО, телефон, почта, вакансия, дата', table.mapping.fullName === 0 && table.mapping.phone === 1 && table.mapping.email === 2 && table.mapping.vacancy === 3 && table.mapping.date === 4, table.mapping)
  const rows = table.rows.map((r, i) => mapRow(r, table.mapping, (table as unknown as { lines: number[] }).lines[i]))
  check('ФИО разобрано: фамилия, имя, отчество', rows[0].lastName === 'Сидорова' && rows[0].name === 'Анна' && rows[0].middleName.startsWith('Петровна'))
  check('вакансия сопоставлена с нашей, дата — московская', rows[0].vacancyId === 'bottling-operator' && rows[0].appliedAt === mskAt(applied[0], 14, 5).toISOString(), rows[0])
  check('строка без телефона и почты помечена', rows[1].problems.includes('нет телефона или почты'))
  check('вакансии нет у нас — уходит в комментарий', rows[2].vacancyId === '' && rows[2].comment.includes('Водитель погрузчика'))
  const commit = await call('POST', '/api/hr/import/commit', { rows: rows.filter((r) => !r.problems.length), source: 'hh', skipDuplicates: true })
  const report = (await commit.json()) as { created: { id: string }[]; duplicates: { existingId: string }[]; invalid: unknown[] }
  check('импорт: новый добавлен, дубль по телефону пропущен', report.created.length === 1 && report.duplicates.length === 1 && report.duplicates[0].existingId === added.id, report)
  const imported = await deps.workflow.get(report.created[0]?.id ?? '')
  check('импортированный: источник hh.ru, дата отклика из файла', imported?.source === 'hh' && imported.createdAt === mskAt(applied[0], 14, 5).toISOString() && imported.channel === 'hr', imported?.createdAt)
  const big = await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array(5 * 1024 * 1024 + 2048), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'big.csv' } })
  check('файл больше 5 МБ — отказ с понятным текстом', big.status === 413 && Boolean(((await big.json()) as { message?: string }).message?.includes('5 МБ')))

  // .xlsx — пишем своим писателем и читаем импортом
  const xlsxDay = daysAgo(197)
  const xlsxFile = writeXlsx([
    {
      name: 'Отклики',
      widths: [20, 20, 20],
      rows: [{ cells: ['Фамилия', 'Имя', 'Мобильный телефон', 'Должность', 'Дата'] }, { cells: [`Кузнецов${tag}`, 'Илья', '89031234567', 'Оператор конвейерной линии', new Date(`${xlsxDay}T09:00:00Z`)] }],
    },
  ])
  const xp = await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array(xlsxFile), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'hh.xlsx' } })
  const xt = (await xp.json()) as { headers: string[]; rows: string[][]; mapping: Record<string, number> }
  const xrow = mapRow(xt.rows[0], xt.mapping)
  check('Excel: колонки и строки прочитаны', xp.status === 200 && xt.headers.join('|') === 'Фамилия|Имя|Мобильный телефон|Должность|Дата' && xrow.lastName === `Кузнецов${tag}`, xt)
  check('Excel: телефон 8… → +7…, дата из числа Excel', xrow.phone === '+79031234567' && Boolean(xrow.appliedAt?.startsWith(xlsxDay)), xrow)
  const xls = await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'old.xls' } })
  check('старый .xls — просьба сохранить как .xlsx', xls.status === 422 && Boolean(((await xls.json()) as { message?: string }).message?.includes('.xlsx')))

  // «Zip-бомба»: 70 МБ нулей сжимаются в десятки килобайт — сервер не должен распаковывать их целиком
  const bomb = zipFiles([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(70 * 1024 * 1024) },
  ])
  const heapBefore = process.memoryUsage().rss
  const bombed = await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array(bomb), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'bomb.xlsx' } })
  const bombBody = (await bombed.json()) as { message?: string }
  check('zip-бомба: 422 с понятным текстом, файл меньше 1 МБ', bomb.length < 1024 * 1024 && bombed.status === 422 && Boolean(bombBody.message?.includes('слишком большой после распаковки')), { size: bomb.length, status: bombed.status, bombBody })
  check('zip-бомба: память сервера не выросла на десятки мегабайт', process.memoryUsage().rss - heapBefore < 80 * 1024 * 1024)
  let many: unknown = null
  try {
    unzip(zipFiles(Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))))
  } catch (e) {
    many = e
  }
  check('архив из тысячи файлов не разбирается', many instanceof ZipLimitError)
}

console.log('Выгрузка: воронка по тому же отбору, 1С')
{
  const src = `fun-${tag}`
  const f1 = await save({ name: 'Воронка', channel: 'web', source: src })
  await patch(f1.id, { status: 'hired' })
  await save({ name: 'Воронка2', channel: 'web', source: src })
  const book = (query: string) => call('POST', '/api/hr/export', { format: 'xlsx', query }).then(async (r) => unzip(Buffer.from(await r.arrayBuffer())))
  const sheet2Strings = (b: Map<string, Buffer>) => {
    const strings = [...(b.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1])
    const sheet = b.get('xl/worksheets/sheet2.xml')?.toString('utf8') ?? ''
    return [...sheet.matchAll(/<c r="[A-Z]+\d+"[^>]*t="s"><v>(\d+)<\/v>/g)].map((m) => strings[Number(m[1])])
  }
  const filtered = sheet2Strings(await book(`source=${src}`))
  check('отфильтрованная выгрузка: «Воронка по выгруженным заявкам», без посещений сайта', filtered.some((t) => t === 'Воронка по выгруженным заявкам: 2') && !filtered.includes('Пришли'), filtered.slice(0, 4))
  const [periodFrom, periodTo] = [daysAgo(430), daysAgo(400)]
  const period = sheet2Strings(await book(`from=${periodFrom}&to=${periodTo}`))
  check('только период: полная воронка за этот период с датами в заголовке', period.includes(`Воронка за период с ${ruDay(periodFrom)} по ${ruDay(periodTo)}`) && period.includes('Пришли'), period.slice(0, 3))
  check('без фильтра — за всё время', sheet2Strings(await book('')).includes('Воронка за всё время'))

  const oneC = await call('POST', '/api/hr/export', { format: 'csv1c', query: `source=${src}` })
  const bytes = Buffer.from(await oneC.arrayBuffer())
  const decoded = new TextDecoder('windows-1251').decode(bytes)
  check('1С: Windows-1251, без BOM, «;», русская шапка', oneC.headers.get('content-type')?.includes('windows-1251') === true && bytes[0] !== 0xef && decoded.startsWith('Фамилия;Имя;Отчество;Телефон;'), decoded.slice(0, 60))
  check('1С: строка на кандидата, телефон +7…, дата дд.мм.гггг', decoded.trim().split('\r\n').length === 3 && /;79\d{9};/.test(decoded) && /;\d\d\.\d\d\.\d{4};/.test(decoded))
  check('1С: Ё, «ёлочки» и тире кодируются, неизвестное — «?»', encodeCp1251('Ёлка «№1» — ✓').equals(Buffer.from([0xa8, 0xeb, 0xea, 0xe0, 0x20, 0xab, 0xb9, 0x31, 0xbb, 0x20, 0x97, 0x20, 0x3f])))
}

console.log('SMS')
{
  const hits: { path: string; body: URLSearchParams }[] = []
  let mode: 'ok' | 'fail' | 'down' = 'ok'
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = new URLSearchParams(Buffer.concat(chunks).toString())
    hits.push({ path: new URL(req.url!, 'http://x').pathname, body })
    const send = (code: number, data: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(data)))
    if (mode === 'down') return send(502, {})
    if (req.url!.startsWith('/sms/send')) {
      const to = body.get('to')!
      if (mode === 'fail') return send(200, { status: 'OK', status_code: 100, sms: { [to]: { status: 'ERROR', status_code: 207, status_text: 'На этот номер нельзя отправлять сообщения' } } })
      return send(200, { status: 'OK', status_code: 100, sms: { [to]: { status: 'OK', status_code: 100, sms_id: '000-1' } }, balance: 100 })
    }
    if (req.url!.startsWith('/sys/send.php')) {
      if (mode === 'fail') return send(200, { error: 'Неверный формат номера телефона', error_code: 7 })
      return send(200, { id: 42, cnt: 2 })
    }
    send(404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ru: SmsConfig = { provider: 'smsru', apiKey: 'key-1', sender: 'OCHAKOVO', baseUrl: base }
  const sc: SmsConfig = { provider: 'smsc', login: 'hr', password: 'secret', baseUrl: base }

  check('маска номера: видно начало и две последние цифры', maskPhone('+7 916 123-45-67') === '+7 916 ***-**-67')
  check('только российские мобильные', smsPhone('8 (916) 123-45-67') === '79161234567' && smsPhone('+7 495 785-39-30') === null)
  const r1 = await sendSms(ru, '+7 916 123-45-67', 'Очаково: проверка')
  const h1 = hits.at(-1)!
  check('SMS.ru: api_id, to, msg, json=1, from', h1.path === '/sms/send' && h1.body.get('api_id') === 'key-1' && h1.body.get('to') === '79161234567' && h1.body.get('json') === '1' && h1.body.get('from') === 'OCHAKOVO' && r1.id === '000-1')
  const r2 = await sendSms(sc, '89161234567', 'Очаково: проверка')
  const h2 = hits.at(-1)!
  check('SMSC.ru: login/psw, phones с «+», utf-8, fmt=3', h2.path === '/sys/send.php' && h2.body.get('login') === 'hr' && h2.body.get('psw') === 'secret' && h2.body.get('phones') === '+79161234567' && h2.body.get('charset') === 'utf-8' && h2.body.get('fmt') === '3' && r2.parts === 2)
  mode = 'fail'
  const e1 = await sendSms(ru, '+79161234567', 'x').catch((e) => e)
  check('SMS.ru: ошибка номера — постоянная, без полного номера в тексте', e1 instanceof SmsError && e1.permanent && !e1.message.includes('9161234567') && e1.message.includes('***'))
  const e2 = await sendSms(sc, '+79161234567', 'x').catch((e) => e)
  check('SMSC.ru: код 7 — постоянная ошибка', e2 instanceof SmsError && e2.permanent)
  mode = 'down'
  const e3 = await sendSms(ru, '+79161234567', 'x').catch((e) => e)
  check('провайдер лежит — временная ошибка, очередь повторит', e3 instanceof SmsError && !e3.permanent)
  mode = 'ok'

  // Через очередь: кандидат с сайта, собеседование → приглашение SMS, напоминание SMS, без задачи HR
  const smsDeps = { ...deps, sms: ru }
  const web = await save({ name: 'Смс Кандидат', channel: 'web', phone: '+7 916 555-44-33' })
  const user = { id: hr.id, email: '', name: 'Ирина HR', role: 'hr' as const, disabled: false, createdAt: '', lastLoginAt: null }
  const before = hits.length
  const inv = await changeStatus(smsDeps, web.id, 'interview', user, { slot: { startsAt: workDays(4), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  check('без бота и с SMS — приглашение в очереди как SMS', inv?.notify?.notify === 'queued' && inv.notify.detail.includes('SMS') && inv.notify.detail.includes('***'), inv?.notify)
  check('при SMS задача HR «напомнить» не ставится', !inv?.application.callbackAt)
  await runDueJobs(smsDeps, 100)
  const sms = hits.slice(before).find((h) => h.body.get('to') === '79165554433')
  check('ушло короткое SMS с адресом, без {подстановок}', Boolean(sms) && sms!.body.get('msg')!.startsWith('Очаково: Смс,') && sms!.body.get('msg')!.includes('Рябиновая') && !/[{}]/.test(sms!.body.get('msg')!), sms?.body.get('msg'))
  const job = await jobs.status(`reminder:${inv!.application.interview!.id}`)
  check('напоминание накануне тоже SMS', job?.status === 'pending')
  const viaSms = await sql<{ payload: { via?: string } }[]>`select payload from jobs where dedupe_key = ${`reminder:${inv!.application.interview!.id}`}`
  check('в задаче напоминания отмечен канал SMS', viaSms[0]?.payload.via === 'sms')
  const hired = await changeStatus(smsDeps, web.id, 'hired', user)
  check('«К оформлению» SMS не шлём — звонок', hired?.notify?.notify === 'call')
  mode = 'down'
  const web2 = await save({ name: 'Смс Повтор', channel: 'web', phone: '+7 916 555-44-34' })
  const inv2 = await changeStatus(smsDeps, web2.id, 'interview', user, { slot: { startsAt: workDays(4), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  await runDueJobs(smsDeps, 100)
  const retry = await sql<{ status: string; attempts: number }[]>`select status, attempts from jobs where dedupe_key = ${`notify:${inv2!.historyId}`}`
  check('провайдер недоступен — задача вернулась в очередь на повтор', retry[0]?.status === 'pending' && retry[0].attempts === 1, retry[0])
  mode = 'ok'
  server.close()
}

console.log('Праздники и переносы')
{
  const s = defaultWorkSettings
  check('праздники по ст. 112 ТК РФ — нерабочие', dayKind(cal('05-09'), s) === 'holiday' && dayKind(cal('01-07'), s) === 'holiday' && dayKind(cal('11-04'), s) === 'holiday' && !isWorkDay(cal('06-12'), s))
  check('обычный будний день — рабочий, суббота — выходной', isWorkDay(cal('06-14'), s) && dayKind(cal('06-15'), s) === 'weekend')
  // Последний день прошлого года здесь — понедельник, первый рабочий после каникул — среда
  const afterNewYear = hrReminderTime(mskAt(cal('01-09'), 11), mskAt(cal('12-20', -1), 12).getTime(), s)!
  check('собеседование сразу после новогодних каникул — напомнить в последний рабочий день года', mskParts(afterNewYear).day === cal('12-31', -1), mskParts(afterNewYear).day)
  const monthBefore = mskAt(cal('06-01'), 12).getTime()
  const withTransfer = { ...s, extraOff: [cal('06-14')] }
  check('дополнительный выходной (перенос) — задача на день раньше', mskParts(hrReminderTime(mskAt(cal('06-17'), 11), monthBefore, withTransfer)!).day === cal('06-13'))
  const workSaturday = { ...s, extraWork: [cal('06-15')] }
  check('рабочая суббота по переносу — задача в субботу', mskParts(hrReminderTime(mskAt(cal('06-17'), 11), monthBefore, workSaturday)!).day === cal('06-15'))
  check('подписи дней: праздник, перенос', dayOffLabel(cal('05-09'), s) === 'День Победы' && dayOffLabel(cal('06-14'), withTransfer) === 'выходной по переносу')
  check('переносы на конкретный год не зашиты в код', dayKind(cal('05-10'), s) === 'work' && dayKind(cal('01-10'), s) === 'work')
  const bad = await call('PUT', '/api/hr/settings', { extraOff: [ruDay(cal('06-14'))] }, adminCookie)
  check('переносы: неверная дата — 422', bad.status === 422)
  const both = await call('PUT', '/api/hr/settings', { extraOff: [cal('06-15')], extraWork: [cal('06-15')] }, adminCookie)
  check('один день и выходной, и рабочий — 422', both.status === 422)
  const ok = (await (await call('PUT', '/api/hr/settings', { extraOff: [cal('06-14'), cal('06-14')], extraWork: [cal('06-15')] }, adminCookie)).json()) as { extraOff: string[]; extraWork: string[] }
  check('админ сохраняет переносы, повторы убираются', JSON.stringify(ok.extraOff) === JSON.stringify([cal('06-14')]) && ok.extraWork[0] === cal('06-15'))
  await call('PUT', '/api/hr/settings', { extraOff: [], extraWork: [] }, adminCookie)
}

console.log('Срок хранения')
{
  const now = new Date()
  const monthsAgo = (m: number) => {
    const d = new Date(now)
    d.setUTCMonth(d.getUTCMonth() - m)
    return d
  }
  const old = await save({ name: 'Старая Заявка', lastName: 'Давняя', channel: 'web', contact: '@old', comment: 'звонить вечером', friend: 'Петя', months: [7], vacancyId: 'bottling-operator', source: `ret-${tag}` })
  await patch(old.id, { status: 'interview', slot: slot(3), comment: 'Позвонили, телефон 8 999 000 00 00', notes: 'Живёт рядом' })
  const fresh = await save({ name: 'Свежая Заявка', channel: 'web', source: `ret-${tag}` })
  const almost = await save({ name: 'Почти Старая', channel: 'web', source: `ret-${tag}` })
  await sql`update applications set status_updated_at = ${monthsAgo(13)} where id = ${old.id}`
  await sql`update applications set status_updated_at = ${monthsAgo(11)} where id = ${almost.id}`
  const botId = `ret-${tag}`
  await sql`insert into bot_users (channel, user_id, first_name, username, last_seen_at) values ('telegram', ${botId}, 'Вася', 'vasya', ${monthsAgo(14)})`
  await sql`insert into sessions (channel, user_id, data, updated_at) values ('telegram', ${botId}, ${sql.json({ flow: null, data: {}, progress: {}, source: null })}, ${monthsAgo(14)})`
  const erasedBots = async () => (await sql<{ n: number }[]>`select count(*)::int as n from bot_users where erased and channel = 'telegram'`)[0].n
  const erasedBefore = await erasedBots()
  const bySource = async () => (await deps.workflow.list()).filter((a) => a.source === `ret-${tag}`)
  const before = stageCounts(await bySource())

  const r = await runRetention({ sql, env: { RETENTION_MONTHS: '12' }, now })
  const after = await deps.workflow.get(old.id)
  check('старше 12 месяцев: имя, фамилия, телефон, контакты, комментарий, друг, заметки стёрты', Boolean(after?.anonymizedAt) && after!.name === '' && after!.lastName === '' && after!.phone === '' && after!.contact === '' && after!.comment === '' && after!.friend === '' && after!.notes === '')
  check('для воронки осталось: вакансия, месяцы, источник, статус, даты', after?.vacancyId === 'bottling-operator' && after.months[0] === 7 && after.source === `ret-${tag}` && after.status === 'interview' && after.createdAt === old.createdAt)
  const hist = await deps.workflow.history(old.id)
  check('комментарии HR в истории стёрты, статусы остались', hist.every((h) => h.comment === '' || h.kind === 'assign' || h.kind === 'merge') && hist.some((h) => h.toStatus === 'interview'))
  check('адрес и «что взять» у собеседования стёрты, время осталось', after?.interview?.address === '' && after.interview.bring === '' && Boolean(after.interview.startsAt))
  check('заявки моложе срока не тронуты', !(await deps.workflow.get(fresh.id))?.anonymizedAt && !(await deps.workflow.get(almost.id))?.anonymizedAt)
  const after2 = stageCounts(await bySource())
  check('воронка не изменилась', JSON.stringify(before) === JSON.stringify(after2), { before, after2 })
  // Строку человека удаляем целиком, на её месте — обезличенная строка-счётчик erased (миграция 020)
  const [bu] = await sql`select 1 from bot_users where user_id = ${botId}`
  check('бот: строки давно не заходившего нет, на её месте счётчик для воронки', !bu && (await erasedBots()) === erasedBefore + 1)
  check('старый диалог с ботом удалён', (await sql`select 1 from sessions where user_id = ${botId}`).length === 0)
  check('результат прогона посчитан', !('busy' in r) && r.applications >= 1 && r.botUsers >= 1 && r.sessions >= 1)

  const again = await runRetention({ sql, env: { RETENTION_MONTHS: '12' }, now })
  check('повторный прогон ничего не трогает повторно', !('busy' in again) && again.applications === 0)
  const later = new Date(now.getTime() + 62 * 864e5)
  await runRetention({ sql, env: { RETENTION_MONTHS: '12' }, now: later })
  check('через два месяца — дошла очередь «почти старой»', Boolean((await deps.workflow.get(almost.id))?.anonymizedAt))

  const lock = await sql.reserve()
  await lock`select pg_advisory_lock(hashtext('ochakovo:retention'))`
  const busy = await runRetention({ sql, env: {}, now })
  await lock`select pg_advisory_unlock(hashtext('ochakovo:retention'))`
  lock.release()
  check('два прогона одновременно не идут', 'busy' in busy)

  const csv = await (await call('POST', '/api/hr/export', { format: 'csv', query: `ids=${old.id}` })).text()
  check('выгрузка: вместо личных данных «удалено по сроку хранения»', csv.includes('удалено по сроку хранения') && !csv.includes('Давняя') && !csv.includes('@old'))
  const oneC = new TextDecoder('windows-1251').decode(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'csv1c', query: `ids=${old.id}` })).arrayBuffer()))
  check('выгрузка для 1С без телефона и имени', oneC.includes('удалено по сроку хранения') && !/\+79\d{9}/.test(oneC.split('\r\n')[1] ?? ''))
  check('обезличенную заявку нельзя менять', (await patch(old.id, { status: 'hired' })).status === 409)

  // По запросу кандидата
  const req = await save({ name: 'Запрос Удаления', lastName: 'Секретова', channel: 'web', phone: '+7 916 222-33-44' })
  const dup = await save({ name: 'Запрос Удаления', channel: 'telegram', channelUserId: '9911', phone: '89162223344' })
  await call('POST', `/api/hr/applications/${dup.id}/merge`, { into: req.id })
  check('без причины — 422', (await call('POST', `/api/hr/applications/${req.id}/erase`, { reason: '' })).status === 422)
  const er = await call('POST', `/api/hr/applications/${req.id}/erase`, { reason: 'Письмо кандидата на rabota@ochakovo.ru' })
  check('удалено по запросу: заявка и склеенный дубль', er.status === 200 && ((await er.json()) as { erased: number }).erased === 2)
  const erased = await deps.workflow.get(req.id)
  check('пометка «по запросу кандидата», бот отвязан', erased?.anonymizedReason === 'request' && !(await deps.workflow.get(dup.id))?.channelUserId)
  const logRes = await app.request('/api/hr/retention', { headers: { cookie: adminCookie } })
  const journal = (await logRes.json()) as { months: number; log: { kind: string; userName: string; reason: string; applicationId: string | null; scope: string }[] }
  const entry = journal.log.find((e) => e.applicationId === req.id)
  check('журнал: кто, почему, сколько — без личных данных', entry?.kind === 'request' && entry.userName === 'Ирина HR' && entry.reason.startsWith('Письмо') && !JSON.stringify(journal).includes('Секретова') && !JSON.stringify(journal).includes('2223344'))
  check('журнал: автоматические удаления записаны', journal.log.some((e) => e.kind === 'auto' && e.scope === 'applications' && e.userName === 'автоматически') && journal.months === 12)
  check('журнал видит только админ', (await app.request('/api/hr/retention', { headers: { cookie: hrCookie } })).status === 403)

  await repo.patchIntegration('retention', { lastRunAt: new Date().toISOString() })
  check('из планировщика — не чаще раза в сутки', (await retentionIfDue({ sql, repo, env: {} })) === null)
  await sql`delete from bot_users where user_id = ${botId}`
  await sql`delete from applications where id = any(${[old.id, fresh.id, almost.id, req.id, dup.id]})`
}

console.log('hh.ru')
{
  // Ожидания — из данных вакансий (shared/content/vacancies.ts): суммы и задачи меняются вместе с ними
  const operator = vacancyById('bottling-operator')!
  const op = toHhVacancy(operator, { addressId: '777' })
  const p = op.payload as Record<string, any>
  check('вакансия → обязательные поля hh.ru', p.name === operator.title && p.area.id === '1' && p.professional_roles[0].id === '85' && p.type.id === 'open' && p.billing_type.id === 'standard' && p.vacancy_properties.properties[0].property_type === 'HH_STANDARD' && p.code === 'bottling-operator')
  check('описание — HTML с задачами и адресом', p.description.startsWith('<p>') && p.description.includes(`<li>${operator.tasks[0]}</li>`) && p.description.includes('Рябиновая') && p.description.replace(/<[^>]+>/g, '').length >= 200)
  check(`зарплата: от ${operator.pay!.from} ₽ до вычета, за месяц, выплаты дважды в месяц`, p.salary_range.from === operator.pay!.from && p.salary_range.currency === 'RUR' && p.salary_range.gross === true && p.salary_range.mode.id === 'MONTH' && p.salary_range.frequency.id === 'TWICE_PER_MONTH')
  check('смены по 12 часов на заводе → справочники hh.ru, публиковать можно', p.working_hours[0].id === 'HOURS_12' && p.work_format[0].id === 'ON_SITE' && !op.problems.length, op.problems)
  check('ориентир по зарплате не публикуем без согласования', toHhVacancy({ ...vacancyById('lab-chemist')!, pay: { from: 60000, estimate: true } }).problems.some((x) => x.includes('ориентир')))
  check('без профессиональной роли — нельзя публиковать', toHhVacancy({ ...vacancyById('store-worker')!, id: 'synthetic-no-role' }).problems.some((x) => x.includes('роли')))
  check('бесплатную практику на hh.ru не публикуем', toHhVacancy(vacancyById('automation-intern')!).problems.length > 0)

  const log: { method: string; path: string; ua?: string; auth?: string; body: string }[] = []
  let token = 'issued-by-hh'
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString()
    log.push({ method: req.method!, path: req.url!, ua: req.headers['hh-user-agent'] as string, auth: req.headers.authorization, body })
    const send = (code: number, data: unknown, headers: Record<string, string> = {}) => (res.writeHead(code, { 'content-type': 'application/json', ...headers }), res.end(JSON.stringify(data)))
    if (!req.headers['hh-user-agent'] && !req.headers['user-agent']) return send(400, { errors: [{ type: 'bad_user_agent' }] })
    if (req.url === '/token') {
      const f = new URLSearchParams(body)
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'r1') {
        token = 'fresh'
        return send(200, { access_token: 'fresh', refresh_token: 'r2', expires_in: 1209600, token_type: 'bearer' })
      }
      return send(400, { error: 'invalid_grant' })
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(403, { errors: [{ type: 'oauth', value: 'token_expired' }] })
    if (req.url === '/me') return send(200, { first_name: 'Ирина', last_name: 'Соколова', is_employer: true, employer: { id: '871', name: 'Очаково' } })
    if (req.url === '/vacancies/drafts' && req.method === 'POST') return send(201, { id: 555 })
    if (req.url === '/vacancies' && req.method === 'POST') {
      if (JSON.parse(body).code === 'quota') return send(403, { errors: [{ type: 'vacancies', value: 'not_enough_quotas' }] })
      return send(201, { id: '91001' }, { location: '/vacancies/91001' })
    }
    if (req.url === '/vacancies/91001' && req.method === 'PUT') return send(204, {})
    if (req.url === '/employers/871/vacancies/archived/91001' && req.method === 'PUT') return send(204, {})
    if (req.url!.startsWith('/negotiations/response')) {
      const page = Number(new URL(req.url!, 'http://x').searchParams.get('page'))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const items = page === 0 ? [{ created_at: `${daysAgo(22)}T10:00:00+0300`, resume: { url: `${base}/resumes/a1?vacancy_id=91001`, first_name: 'Ольга', last_name: `Отклик${tag}`, middle_name: 'Ивановна' } }] : [{ created_at: `${daysAgo(21)}T10:00:00+0300`, resume: { url: `${base}/resumes/a2`, first_name: 'Без', last_name: 'Контактов' } }]
      return send(200, { items, pages: 2, page, found: 2 })
    }
    if (req.url!.startsWith('/resumes/a1')) return send(200, { contact: [{ type: { id: 'cell' }, value: { formatted: '+7 (926) 555-66-77' } }, { type: { id: 'email' }, value: 'olga@mail.ru' }] })
    if (req.url!.startsWith('/resumes/a2')) return send(200, { contact: [] })
    send(404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let saved: unknown = null
  const client = new HhClient({ accessToken: 'expired', refreshToken: 'r1', employerId: '871', userAgent: 'OchakovoHR/1.0 (rabota@ochakovo.ru)', apiBase: base, onTokens: async (t) => void (saved = t) })
  const me = await client.me()
  check('истёкший токен (403 token_expired) → refresh_token → повтор', me.employer?.id === '871' && token === 'fresh' && (saved as { refreshToken?: string })?.refreshToken === 'r2')
  check('каждый запрос с HH-User-Agent', log.every((l) => l.ua === 'OchakovoHR/1.0 (rabota@ochakovo.ru)'))
  check('черновик — POST /vacancies/drafts', (await client.createDraft(op.payload)) === '555')
  check('публикация — POST /vacancies, номер из ответа', (await client.publish(op.payload)) === '91001')
  await client.update('91001', op.payload)
  const put = log.find((l) => l.method === 'PUT' && l.path === '/vacancies/91001')
  check('правка без billing_type и vacancy_properties (их меняют отдельно)', Boolean(put) && !put!.body.includes('billing_type') && put!.body.includes('salary_range'))
  await client.archive('91001')
  check('архив — PUT /employers/871/vacancies/archived/91001', log.some((l) => l.method === 'PUT' && l.path === '/employers/871/vacancies/archived/91001'))
  const quota = await client.publish({ ...op.payload, code: 'quota' }).catch((e) => e)
  check('нет услуг на hh.ru — понятная ошибка', quota instanceof HhError && quota.message.includes('услуг'))
  const responses = await client.responses('91001')
  check('отклики: две страницы, контакты из полного резюме', responses.length === 2 && responses[0].lastName === `Отклик${tag}` && responses[0].name === 'Ольга Ивановна' && responses[0].phone === '+79265556677' && responses[0].email === 'olga@mail.ru' && responses[0].appliedAt?.startsWith(daysAgo(22)))
  check('отклик без контактов помечен, его не импортируем', responses[1].problems.includes('нет телефона или почты'))

  // Через API панели: по умолчанию пробный режим, без подключения — ничего не отправить
  const sentBefore = log.length
  const dry = await call('POST', '/api/hr/hh/vacancies/bottling-operator', { action: 'publish' }, adminCookie)
  const dryBody = (await dry.json()) as { dryRun: boolean; payload: { name: string } }
  check('кнопка без явного «отправить» — только проверка, запросов к hh.ru нет', dry.status === 200 && dryBody.dryRun && dryBody.payload.name === vacancyById('bottling-operator')!.title && log.length === sentBefore)
  const offline = await call('POST', '/api/hr/hh/vacancies/bottling-operator', { action: 'publish', dryRun: false }, adminCookie)
  check('не подключено — отправить нельзя', offline.status === 422)
  check('публиковать может только админ', (await call('POST', '/api/hr/hh/vacancies/bottling-operator', { action: 'publish' })).status === 403)
  // Подключённый hh.ru: настройки окружения сервер читает при запуске — поднимаем приложение с ними
  const hhEnv = { ...process.env, NODE_ENV: 'test', SITE_URL: 'https://season.example.ru', HH_ACCESS_TOKEN: 'fresh', HH_REFRESH_TOKEN: 'r2', HH_EMPLOYER_ID: '871', HH_API_URL: base, HH_USER_AGENT: 'OchakovoHR/1.0 (rabota@ochakovo.ru)' }
  const hhApp = await createApp({ storage, engine: null, bots, hrToken: '', env: hhEnv, rateRules: rules })
  const hhCall = (method: string, path: string, body?: unknown) =>
    hhApp.request(path, { method, headers: { cookie: adminCookie, 'x-hr-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  await repo.patchIntegration('hh', { accessToken: '', refreshToken: '', published: {} })
  const blocked = await hhCall('POST', '/api/hr/hh/vacancies/automation-intern', { action: 'publish', dryRun: false })
  check('бесплатную практику без суммы не опубликовать', blocked.status === 422)
  const live = await hhCall('POST', '/api/hr/hh/vacancies/bottling-operator', { action: 'publish', dryRun: false })
  check('явная публикация уходит на hh.ru и запоминается', live.status === 200 && ((await live.json()) as { entry: { hhId: string } }).entry.hhId === '91001')
  const status = (await (await hhApp.request('/api/hr/hh', { headers: { cookie: adminCookie } })).json()) as { connected: boolean; published: Record<string, { hhId: string }> }
  check('статус: подключено, вакансия опубликована', status.connected && status.published['bottling-operator']?.hhId === '91001')
  const pulled = (await (await hhCall('POST', '/api/hr/hh/vacancies/bottling-operator/responses')).json()) as { rows: { lastName: string }[] }
  check('отклики с hh.ru приходят строками для импорта', pulled.rows?.length === 2 && pulled.rows[0].lastName === `Отклик${tag}`)
  await repo.patchIntegration('hh', { accessToken: '', refreshToken: '', published: {} })
  server.close()
}

console.log('Раунд 3: выгрузки без формул')
{
  const evil = await save({ name: '=HYPERLINK("http://x")', channel: 'web', phone: '+7 916 123-45-67', comment: '=1+2', source: `inj-${tag}` })
  await patch(evil.id, { notes: '@SUM(A1)' })
  const csv = new TextDecoder('utf-8').decode(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'csv', query: `source=inj-${tag}` })).arrayBuffer()))
  check('CSV: «=1+2» и «@SUM» уходят текстом с апострофом', csv.includes(`"'=1+2"`) && csv.includes(`"'@SUM(A1)"`) && csv.includes(`"'=HYPERLINK(""http://x"")`))
  check('CSV: телефон без «+» в начале и похож на телефон', csv.includes('"7 916 123-45-67"') && !csv.includes('"+7 916'))
  const oneC = new TextDecoder('windows-1251').decode(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'csv1c', query: `source=inj-${tag}` })).arrayBuffer()))
  const line = oneC.split('\r\n')[1]
  check('1С: формулы обезврежены без апострофа, телефон цифрами без «+»', line.includes('"— HYPERLINK(""http://x"")') && line.includes(';79161234567;') && line.includes(';— 1+2 / @SUM(A1);') && !/;"?[=+@'-]/.test(line), line)
  // Ирина: «'@student119» и «'-ночью» 1С загрузит как есть — для 1С переписываем начало по смыслу
  const nick = await save({ name: 'Ник', channel: 'web', contact: '@student119', comment: '-ночью могу, +днём нет', source: `inj1c-${tag}` })
  const nickLine = new TextDecoder('windows-1251')
    .decode(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'csv1c', query: `ids=${nick.id}` })).arrayBuffer()))
    .split('\r\n')[1]
    .split(';')
  check('1С: ник — в колонке «Мессенджер» ссылкой t.me, почта пустая', nickLine[4] === '' && nickLine[5] === 't.me/student119', nickLine.slice(3, 6))
  check('1С: «-ночью» → «— ночью», без апострофа', nickLine.includes('— ночью могу, +днём нет') && !nickLine.join(';').includes("'"), nickLine)
  check('1С: правила по смыслу', oneCText('+7 916 000-00-00') === '7 916 000-00-00' && oneCText('@nick_1') === 't.me/nick_1' && oneCText('=1+2') === '— 1+2' && oneCText('\t-x') === '— x' && oneCText('Иван') === 'Иван')
  check('CSV для Excel по-прежнему с апострофом', safeCell('-ночью') === "'-ночью")
  check('safeCell: «-», табуляция и возврат каретки тоже', safeCell('-5') === "'-5" && safeCell('\t1') === "'\t1" && safeCell('\r=1') === "'\r=1" && safeCell('Иван') === 'Иван')
}

console.log('Раунд 3: импорт настоящих выгрузок hh.ru')
{
  const file = readFileSync(new URL('./fixtures/hr/hh-otkliki.xlsx', import.meta.url))
  const parsed = await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array(file), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'hh-otkliki.xlsx' } })
  const t = (await parsed.json()) as { headers: string[]; rows: string[][]; lines: number[]; skipped: { line: number; reason: string }[]; mapping: Record<string, number> }
  check('вакансия — из колонки «Вакансия» отклика, а не «Желаемая должность»', t.headers[t.mapping.vacancy] === 'Вакансия', t.headers[t.mapping.vacancy])
  check('итоговая строка «Всего откликов» — служебная, с номером строки файла', t.skipped.length === 1 && t.skipped[0].line === 52)
  check('номера строк — как в Excel: шапка на 4-й строке, первая запись — 5-я', t.lines[0] === 5 && t.headers[0] === 'ФИО')
  // Подменяем фамилии, чтобы не пересекаться с другими прогонами
  const vacancyMap = { 'оператор линии розлива (сезонная работа)': 'bottling-operator', 'укладчик-упаковщик': 'warehouse-operator', 'грузчик-комплектовщик на склад (лето)': 'none' }
  // Фамилии и почты — с меткой прогона, чтобы не пересекаться с другими проверками
  const emailCol = t.mapping.email
  const rows = t.rows.map((r, i) => {
    const cells = [...r]
    if (cells[0]) cells[0] = cells[0].replace(/^Пробн(ая|ый)/, (m) => `${m}${tag}`)
    if (cells[emailCol]) cells[emailCol] = cells[emailCol].replace('@', `.${tag}@`)
    return mapRow(cells, t.mapping, t.lines[i], vacancyMap)
  })
  const first = rows[0]
  check('ФИО → фамилия, имя, отчество; гражданство Беларусь → ЕАЭС; «18 лет» → 18+; ссылка на резюме', first.name === 'Анна' && first.middleName === 'Андреевна' && first.citizenship === 'eaeu' && first.adult === true && first.resumeUrl.startsWith('https://hh.ru/resume/'))
  const belarus = rows.find((r) => r.phone.startsWith('+375'))
  check('белорусский номер принят (+375), а не потерян', Boolean(belarus) && belarus!.phone.length === 13)
  const bad = rows.filter((r) => r.problems.length)
  check('ошибки видны до импорта: кривой номер, нет имени, нет контактов', bad.length === 3 && bad.some((r) => r.problems.some((p) => p.startsWith('телефон не распознан'))))
  check('сопоставление вакансии из словаря HR', rows.find((r) => r.vacancyTitle === 'Укладчик-упаковщик')?.vacancyId === 'warehouse-operator')

  const commit = (await (await call('POST', '/api/hr/import/commit', { rows, source: 'hh', skipDuplicates: true, vacancyMap, skipped: t.skipped })).json()) as {
    created: { line: number; id: string }[]
    invalid: { line: number; problems: string[] }[]
    duplicates: { line: number; by: string }[]
    skipped: { line: number }[]
    warnings: { line: number; warnings: string[] }[]
  }
  check('«С ошибками» в отчёте = в предпросмотре, номера строк совпадают с файлом', commit.invalid.length === bad.length && commit.invalid.every((i) => bad.some((b) => b.line === i.line)), commit.invalid)
  check('служебная строка и замечания — в отчёте', commit.skipped[0]?.line === 52 && commit.warnings.some((w) => w.warnings.some((x) => x.includes('почта не распознана'))))
  check('все годные строки загружены или отмечены дублями', commit.created.length + commit.duplicates.length === rows.length - bad.length)
  const map = (await (await app.request('/api/hr/import/vacancy-map', { headers: { cookie: hrCookie } })).json()) as Record<string, string>
  check('сопоставления вакансий запомнены для следующего импорта', map['оператор линии розлива (сезонная работа)'] === 'bottling-operator' && map['грузчик-комплектовщик на склад (лето)'] === 'none')
  const imported = await deps.workflow.get(commit.created.find((c) => c.line === first.line)?.id ?? '')
  check('у импортированного — отчество, гражданство, 18+, резюме, вакансия отклика', imported?.middleName === 'Андреевна' && imported.citizenship === 'eaeu' && imported.adult === true && Boolean(imported.resumeUrl) && imported.vacancyId === 'bottling-operator', imported && { m: imported.middleName, c: imported.citizenship, a: imported.adult, r: imported.resumeUrl, v: imported.vacancyId, line: commit.created[0] })

  const again = (await (await call('POST', '/api/hr/import/commit', { rows, source: 'hh', skipDuplicates: true })).json()) as { created: unknown[]; duplicates: { by: string }[] }
  check('повторный импорт того же файла ничего не добавляет — и людей только с почтой тоже', again.created.length === 0 && again.duplicates.length === commit.created.length + commit.duplicates.length)
  const emailOnly = rows.find((r) => !r.phone && r.email && !r.problems.length)
  if (emailOnly) check('дубль по почте распознан', again.duplicates.some((d) => d.by === 'почта' || d.by === 'резюме'))

  // CSV в Windows-1251
  const csvFile = readFileSync(new URL('./fixtures/hr/hh-otkliki.csv', import.meta.url))
  const pc = (await (await app.request('/api/hr/import/parse', { method: 'POST', body: new Uint8Array(csvFile), headers: { cookie: hrCookie, 'x-hr-request': '1', 'x-file-name': 'hh.csv' } })).json()) as { rows: string[][]; lines: number[]; mapping: Record<string, number> }
  const crow = pc.rows.map((r, i) => mapRow(r, pc.mapping, pc.lines[i]))
  check('CSV: отчество из отдельной колонки, номер строки 2 у первой записи', crow[0].middleName === 'Сергеевна' && crow[0].line === 2)
  const abcLine = new TextDecoder('windows-1251').decode(csvFile).split(/\r?\n/).findIndex((l) => l.includes('abc')) + 1
  check('CSV: строка «+7 900 abc-de-fg» — ошибка с номером строки, а не тихая потеря', crow.some((r) => r.line === abcLine && r.problems.some((p) => p.includes('abc'))), { abcLine, lines: crow.filter((r) => r.problems.length).map((r) => r.line) })

  // 1С: структура ФИО и подразделение
  const site = await save({ name: 'Роман Дмитриев', channel: 'web', vacancyId: 'lab-chemist', source: `fio-${tag}` })
  const oneC = new TextDecoder('windows-1251').decode(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'csv1c', query: `ids=${site.id},${commit.created[0].id}` })).arrayBuffer()))
  const lines1c = oneC.trim().split('\r\n').slice(1).map((l) => l.split(';'))
  const siteRow = lines1c.find((c) => c.includes(site.id))!
  const hhRow = lines1c.find((c) => c.includes(commit.created[0].id))!
  check('1С: заявка с сайта «Роман Дмитриев» — без угаданных фамилии и отчества', siteRow[0] === '' && siteRow[1] === `Роман Дмитриев ${tag}` && siteRow[2] === '', siteRow.slice(0, 3))
  check('1С: из hh.ru — Фамилия, Имя, Отчество по местам', hhRow[0].startsWith(`Пробная${tag}`) && hhRow[1] === 'Анна' && hhRow[2] === 'Андреевна', hhRow.slice(0, 3))
  check('1С: подразделение — по вакансии', siteRow[7] === deptName('quality'), siteRow[7])
  await sql`delete from applications where source = 'hh' and last_name like ${'%' + tag + '%'}`
}

console.log('Раунд 3: собеседование вне рабочего времени')
{
  const a = await save({ name: 'Выходной', channel: 'web' })
  let sat = Date.now() + 864e5
  while (mskParts(sat).dow !== 6) sat += 864e5
  const saturday = mskAt(mskParts(sat).day, 11)
  const off = await patch(a.id, { status: 'interview', slot: { startsAt: saturday.toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  check('суббота без подтверждения — 422 с объяснением', off.status === 422 && String((off.body as unknown as { message: string }).message).includes('выходной'))
  const evening = await patch(a.id, { status: 'interview', slot: { startsAt: mskAt(mskParts(workDays(2)).day, 19, 30).toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  check('19:30 — вне рабочего дня, тоже нужно подтверждение', evening.status === 422 && String((evening.body as unknown as { message: string }).message).includes('вне рабочего дня'))
  const ok = await patch(a.id, { status: 'interview', allowOffHours: true, slot: { startsAt: saturday.toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
  check('с подтверждением — назначается', ok.status === 200 && ok.body.application.status === 'interview')
  check('праздник — предупреждение с названием', slotWarning(mskAt(cal('05-09'), 11), defaultWorkSettings)?.includes('День Победы') === true)
  check('рабочий день в рабочие часы — без предупреждения', slotWarning(mskAt(cal('06-17'), 11), defaultWorkSettings) === null)
  const bulkOff = await call('POST', '/api/hr/bulk', { ids: [a.id], action: 'status', status: 'interview', slot: { startsAt: saturday.toISOString(), address: 'Москва, ул. Рябиновая, 44', bring: '' } })
  check('массово — то же правило', bulkOff.status === 422)
}

console.log('Раунд 3: звонки по откликам hh.ru')
{
  const hhApp = await call('POST', '/api/hr/applications', { name: 'Никита', lastName: `Игоревич${tag}`, phone: '+7 916 765-43-21', source: 'hh', vacancyId: 'bottling-operator', consentBasis: 'job_board', force: true })
  const created = ((await hhApp.json()) as { application: HrApplication }).application
  const r = (await (await call('POST', '/api/hr/bulk', { ids: [created.id], action: 'status', status: 'interview', slot: slot(3) })).json()) as { calls: { name: string; text: string }[] }
  check('в списке звонков — фамилия и имя', r.calls[0]?.name === `Игоревич${tag} Никита`, r.calls[0]?.name)
  check('кандидату с hh.ru — «по твоему отклику на hh.ru на вакансию …», без номера заявки', Boolean(r.calls[0]?.text.includes(`по твоему отклику на hh.ru на вакансию «${vacancyById('bottling-operator')!.title}»`)) && !r.calls[0].text.includes(created.id), r.calls[0]?.text)
  const web = await save({ name: 'Сайт', channel: 'web' })
  const w = (await (await call('POST', '/api/hr/bulk', { ids: [web.id], action: 'status', status: 'interview', slot: slot(3) })).json()) as { calls: { text: string }[] }
  check('с сайта — по-прежнему «по заявке № …»', w.calls[0]?.text.includes(`по заявке № ${web.id}`))
}

console.log('Раунд 3: план найма и список на проходную')
{
  const season = seasonOf(Date.now())
  const before = (await (await app.request(`/api/hr/plan?season=${season}`, { headers: { cookie: hrCookie } })).json()) as { cells: unknown[] }
  const p = await call('PUT', '/api/hr/plan', { season, entries: [{ vacancyId: 'merchandiser', month: 7, target: 2 }, { vacancyId: 'merchandiser', month: 8, target: 1 }] })
  const plan = (await p.json()) as { cells: { vacancyId: string; month: number; target: number; hired: number }[] }
  check('план сохраняется по вакансии и месяцу', p.status === 200 && plan.cells.filter((c) => c.vacancyId === 'merchandiser').length === 2)
  const m1 = await save({ name: 'План Один', channel: 'web', vacancyId: 'merchandiser', months: [7, 8] })
  const m2 = await save({ name: 'План Два', channel: 'web', vacancyId: 'merchandiser', months: [7] })
  await patch(m1.id, { status: 'hired' })
  await patch(m1.id, { status: 'started' })
  await patch(m2.id, { status: 'contacted' })
  const prog = (await (await app.request(`/api/hr/plan?season=${season}`, { headers: { cookie: hrCookie } })).json()) as { cells: { vacancyId: string; month: number; target: number; hired: number; started: number }[] }
  const july = prog.cells.find((c) => c.vacancyId === 'merchandiser' && c.month === 7)
  const aug = prog.cells.find((c) => c.vacancyId === 'merchandiser' && c.month === 8)
  check('прогресс: вышедший на смену закрывает июль и август, «Связались» — нет', july?.hired === 1 && july.started === 1 && aug?.hired === 1)
  check('ошибка в плане — 422', (await call('PUT', '/api/hr/plan', { season, entries: [{ vacancyId: 'merchandiser', month: 7, target: -1 }] })).status === 422)
  const book = unzip(Buffer.from(await (await call('POST', '/api/hr/export', { format: 'xlsx', query: '' })).arrayBuffer()))
  check('Excel: лист «План найма»', (book.get('xl/workbook.xml')?.toString() ?? '').includes('name="План найма"'))
  await call('PUT', '/api/hr/plan', { season, entries: [{ vacancyId: 'merchandiser', month: 7, target: 0 }, { vacancyId: 'merchandiser', month: 8, target: 0 }] })
  check('план можно очистить', ((await (await app.request(`/api/hr/plan?season=${season}`, { headers: { cookie: hrCookie } })).json()) as { cells: unknown[] }).cells.length === before.cells.length)

  const day = workDays(5)
  const dayStr = mskParts(day).day
  const p1 = await save({ name: 'Проходная Вторая', lastName: `Охранова${tag}`, middleName: 'Петровна', channel: 'web', vacancyId: 'lab-chemist' })
  const p2 = await save({ name: 'Проходной Первый', channel: 'web' })
  await patch(p1.id, { status: 'interview', slot: { ...slot(5), startsAt: new Date(day.getTime() + 3 * 3600e3).toISOString() } })
  await patch(p2.id, { status: 'interview', slot: { ...slot(5), startsAt: day.toISOString() } })
  const pass = (await (await app.request(`/api/hr/pass?date=${dayStr}`, { headers: { cookie: hrCookie } })).json()) as { items: { id: string; time: string; fullName: string; vacancy: string }[] }
  const mine = pass.items.filter((i) => i.id === p1.id || i.id === p2.id)
  check('список на проходную: по времени, ФИО полностью, вакансия', mine.length === 2 && mine[0].id === p2.id && mine[1].fullName === `Охранова${tag} Проходная Вторая ${tag} Петровна` && mine[1].vacancy === vacancyById('lab-chemist')!.title, mine)
  const xlsx = await app.request(`/api/hr/pass.xlsx?date=${dayStr}`, { headers: { cookie: hrCookie } })
  const pb = unzip(Buffer.from(await xlsx.arrayBuffer()))
  const passText = [...pb.values()].map((b) => b.toString()).join('')
  check('список на проходную — в Excel, без телефонов кандидатов', xlsx.status === 200 && passText.includes('Список на проходную') && passText.includes(`Охранова${tag}`) && !passText.replace(contacts.phone, '').replace(contacts.mobile, '').match(/\+7 9\d\d/), passText.slice(0, 0))
  check('проходная без входа закрыта', (await app.request(`/api/hr/pass?date=${dayStr}`)).status === 401)
}

console.log('Статус заявки для кандидата')
{
  const res = await app.request('/api/applications', json({ ...caseFields, name: `Даня ${tag}`, phone: '+7 916 555-12-12', vacancyId: 'bottling-operator', ...agreed }))
  const created = (await res.json()) as { id: string; statusToken?: string; status?: unknown; notes?: unknown }
  check('в ответе на заявку — токен статуса (24 байта, base64url)', typeof created.statusToken === 'string' && /^[\w-]{32}$/.test(created.statusToken))
  const [row] = await sql<{ status_token_hash: string }[]>`select status_token_hash from applications where id = ${created.id}`
  check('в базе — только SHA-256 токена', row.status_token_hash === createHash('sha256').update(created.statusToken!).digest('hex') && row.status_token_hash !== created.statusToken)
  const get = (id: string, token?: string) => app.request(`/api/applications/${id}/status`, { headers: token ? { 'x-status-token': token } : {} })
  const ok = await get(created.id, created.statusToken)
  const st = (await ok.json()) as Record<string, unknown>
  check('статус по токену: только поля для кандидата, без кэша', ok.status === 200 && ok.headers.get('cache-control') === 'no-store' && JSON.stringify(Object.keys(st).sort()) === JSON.stringify(['firstShift', 'id', 'interview', 'overdue', 'prepare', 'stage', 'steps', 'text', 'title', 'vacancyTitle']), Object.keys(st))
  check('новая заявка: «у отдела персонала», вакансия по-русски', st.stage === 'received' && st.vacancyTitle === vacancyById('bottling-operator')!.title)
  check('чужой токен, без токена, неизвестный номер — 404', (await get(created.id, 'x'.repeat(32))).status === 404 && (await get(created.id)).status === 404 && (await get('ZZZZZZZZ', created.statusToken)).status === 404)

  await patch(created.id, { status: 'interview', slot: slot(3), notes: 'секретная заметка HR', assigneeId: admin.id })
  const st2 = (await (await get(created.id, created.statusToken)).json()) as { stage: string; interview: { address: string } | null }
  const raw = JSON.stringify(st2)
  check('после приглашения — собеседование с адресом', st2.stage === 'interview' && st2.interview?.address === 'Москва, ул. Рябиновая, 44')
  check('внутреннее HR не утекает: заметки, ответственный, телефон', !raw.includes('секретная') && !raw.includes('Админ Тест') && !raw.includes('555-12-12') && !raw.includes('9165551212'))
  await patch(created.id, { status: 'declined', declineReason: 'age' })
  const st3 = (await (await get(created.id, created.statusToken)).json()) as { stage: string; text: string }
  check('отказ — «заявка закрыта», без причины', st3.stage === 'closed' && !JSON.stringify(st3).includes('18'))
  await call('POST', `/api/hr/applications/${created.id}/erase`, { reason: 'Проверка: удаление по запросу' })
  check('после удаления данных — 404', (await get(created.id, created.statusToken)).status === 404)

  // Обещание «позвоним за 2 рабочих дня» — по календарю с праздниками
  const base = { id: 'TEST1234', status: 'new' as const, statusUpdatedAt: '', vacancyId: '', interview: null, reached: ['new' as const] }
  const createdAt = mskAt(cal('05-08'), 10).toISOString()
  check('День Победы не считается: в пятницу ещё в срок', !candidateStatus({ ...base, createdAt }, mskAt(cal('05-10'), 15), defaultWorkSettings).overdue)
  check('третий рабочий день (вторник после праздника) — просрочено, текст с контактами', (() => {
    const s2 = candidateStatus({ ...base, createdAt }, mskAt(cal('05-14'), 15), defaultWorkSettings)
    return s2.overdue && s2.text.includes('rabota@ochakovo.ru') && s2.text.includes('TEST1234')
  })())
  const tgOnly = candidateStatus({ ...base, createdAt, phone: '', contact: '@kvas_fan' }, mskAt(cal('05-10'), 15), defaultWorkSettings)
  check('только Telegram: «HR напишет», шаг «Связь с HR», без «держи телефон»', tgOnly.text.includes('напишет тебе в мессенджер') && !tgOnly.text.includes('телефон') && tgOnly.steps[1].label === 'Связь с HR', tgOnly)
  const byPhone = candidateStatus({ ...base, createdAt, phone: '+79161234567', contact: '' }, mskAt(cal('05-10'), 15), defaultWorkSettings)
  // Срок — днём недели по календарю отдела: заявка в среду, четверг — праздник, суббота и воскресенье — выходные, второй рабочий день — понедельник
  check('с телефоном: «позвонит до конца понедельника» — срок днём, праздник и выходные пропущены', /^[а-яё]+ рабоч/.test(RESPONSE_WORDS) && byPhone.text.startsWith('HR позвонит до конца понедельника. Держи телефон рядом.') && byPhone.steps[1].label === 'Звонок HR', byPhone.text)
  {
    // Последний день срока — понедельник, ровно второй рабочий день после заявки; накануне — «завтра», в сам день — «сегодня»
    const last = responseDeadline(new Date(createdAt), defaultWorkSettings)
    const eve = mskParts(mskAt(last, 12).getTime() - 864e5).day
    check(
      'срок ответа: второй рабочий день после заявки — понедельник; «завтра» накануне, «сегодня» в сам день',
      mskParts(mskAt(last, 12)).dow === 1 &&
        workdaysBetween(new Date(createdAt), mskAt(last, 12), defaultWorkSettings) === RESPONSE_WORKDAYS &&
        deadlineWords(last, mskAt(last, 9)) === 'сегодня до конца дня' &&
        deadlineWords(last, mskAt(eve, 9)) === 'завтра до конца дня',
      last,
    )
  }
  check('рабочих дней между: праздник и выходные пропущены', workdaysBetween(mskAt(cal('05-08'), 10), mskAt(cal('05-14'), 10), defaultWorkSettings) === 3)

  // Бот: последняя заявка пользователя
  const bot = await storage.saveApplication(normalizeApplication({ name: `Бот статус ${tag}`, phone: '+79160001111', channel: 'telegram', channelUserId: `st-${tag}`, ...agreed }))
  check('заявка из бота тоже получает токен', Boolean(bot.statusToken))
  const latest = await storage.latestApplicationFor('telegram', `st-${tag}`)
  check('боту: последняя заявка пользователя — с этапами для candidateStatus', latest?.id === bot.id && latest.reached.includes('new'))
  check('боту: статус по номеру и токену через хранилище', (await storage.statusForToken(bot.id, bot.statusToken!))?.id === bot.id)
  check('боту: настройки рабочего времени из базы', Array.isArray((await storage.workSettings()).days))
  const mem = memoryStorage()
  const m = await mem.saveApplication(normalizeApplication({ name: 'Память', phone: '+79160002222', channel: 'max', channelUserId: '42', ...agreed }))
  check('хранилище в памяти: то же API', (await mem.latestApplicationFor!('max', '42'))?.id === m.id && (await mem.statusForToken!(m.id, m.statusToken!))?.stage === 'received')

  // Чат на сайте: номер и токен заявки доходят до движка в meta
  let seen: unknown = null
  const fakeEngine = { handle: async (_u: unknown, _e: unknown, meta?: unknown) => ((seen = meta), { messages: [] }) }
  const app2 = await createApp({ storage, engine: fakeEngine as never, bots, hrToken: '', env: { ...process.env, NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await app2.request('/api/dialog', json({ user: { channel: 'web', id: `w-${tag}` }, event: { type: 'start' }, application: { id: bot.id, token: bot.statusToken } }))
  check('/api/dialog передаёт {application: {id, token}} в движок', JSON.stringify(seen) === JSON.stringify({ application: { id: bot.id, token: bot.statusToken } }), seen)
}

console.log('Демо-данные и очистка — не в рабочей версии')
{
  const prodEnv = { ...process.env, NODE_ENV: 'production', SITE_URL: 'https://season.example.ru', HR_DEMO_TOOLS: '' }
  const prod = await createApp({ storage, engine: null, bots, hrToken: '', env: prodEnv, rateRules: rules })
  const req = (path: string, method: string) => prod.request(path, { method, headers: { cookie: adminCookie, 'x-hr-request': '1', 'content-type': 'application/json' }, body: method === 'POST' ? '{"count":1}' : undefined })
  const seed = await req('/api/hr/applications/seed', 'POST')
  check('в рабочей версии администратор не может залить демо-данные — 403', seed.status === 403 && ((await seed.json()) as { error: string }).error === 'demo_disabled')
  check('в рабочей версии «Очистить базу» отключена — 403', (await req('/api/hr/applications', 'DELETE')).status === 403)
  check('старые адреса тоже закрыты', (await req('/api/applications/seed', 'POST')).status === 403 && (await req('/api/applications', 'DELETE')).status === 403)
  const me = (await (await prod.request('/api/hr/me', { headers: { cookie: adminCookie } })).json()) as { demoTools?: boolean }
  check('панель знает, что демо-инструментов нет', me.demoTools === false)
  const stand = await createApp({ storage, engine: null, bots, hrToken: '', env: { ...prodEnv, HR_DEMO_TOOLS: '1' }, rateRules: rules })
  const standMe = (await (await stand.request('/api/hr/me', { headers: { cookie: adminCookie } })).json()) as { demoTools?: boolean }
  check('демо-стенд с HR_DEMO_TOOLS=1 — инструменты есть', standMe.demoTools === true)
}

console.log('Разложить по норме')
{
  // Чистая раскладка: пятница, 10–13, норма 6, в 10:00 уже 4 человека
  const fri = cal('10-11')
  const [sat, sun, mon] = [cal('10-12'), cal('10-13'), cal('10-14')]
  const now = mskAt(fri, 9).getTime()
  const r = spreadSlots(20, { from: fri, fromHour: 10, toHour: 13, capacity: 6, booked: { [`${fri}T10`]: 4 }, now })
  const by = (list: { hour: string }[]) => list.reduce<Record<string, number>>((m, x) => ((m[x.hour] = (m[x.hour] ?? 0) + 1), m), {})
  check('час заполняется до нормы с учётом уже назначенных', JSON.stringify(by(r)) === JSON.stringify({ [`${fri}T10`]: 2, [`${fri}T11`]: 6, [`${fri}T12`]: 6, [`${mon}T10`]: 6 }), by(r))
  check('выходные пропускаются', !r.some((x) => x.hour.startsWith(sat) || x.hour.startsWith(sun)))
  const hol = spreadSlots(7, { from: cal('11-04'), fromHour: 10, toHour: 11, capacity: 6, booked: {}, now })
  check('праздник (День народного единства) пропускается', !hol.some((x) => x.hour.startsWith(cal('11-04'))) && hol[0].hour === `${cal('11-05')}T10`)
  const late = spreadSlots(3, { from: fri, fromHour: 10, toHour: 13, capacity: 6, booked: {}, now: mskAt(fri, 11, 30).getTime() })
  check('прошедшие часы сегодня не занимаются', late.every((x) => x.hour >= `${fri}T12`))
  const stag = spreadSlots(4, { from: fri, fromHour: 12, toHour: 13, capacity: 6, booked: { [`${fri}T12`]: 2 }, now, stagger: true })
  const minutes = stag.map((x) => mskParts(new Date(x.startsAt)).minute)
  check('внутри часа — каждому своё время: шаг 10 минут после уже назначенных', minutes.join() === '20,30,40,50', minutes)
  const lunch = spreadSlots(12, { from: fri, fromHour: 12, toHour: 15, capacity: 6, booked: {}, now, lunchHour: 13 })
  check('обеденный час пропускается', !lunch.some((x) => x.hour === `${fri}T13`) && lunch.filter((x) => x.hour === `${fri}T14`).length === 6)
  const limited = spreadSlots(20, { from: fri, fromHour: 10, toHour: 17, capacity: 6, booked: { [`${fri}T10`]: 3 }, now, dayLimit: 8 })
  check('дневной лимит вместе с уже назначенными: в пятницу 5 новых, остальные — в понедельник', limited.filter((x) => x.hour.startsWith(fri)).length === 5 && limited.filter((x) => x.hour.startsWith(mon)).length === 8)
  check('мест не хватило — вернули меньше: 5 рабочих дней по одному', spreadSlots(100, { from: fri, fromHour: 10, toHour: 11, capacity: 1, booked: {}, now, horizonDays: 7 }).length === 5)

  // Через API: у каждой заявки своё время, адрес общий
  const people = await Promise.all([1, 2, 3].map((i) => save({ name: `Норма${i}`, channel: 'web' })))
  const ids = people.map((p) => p.id)
  const day = mskParts(workDays(3)).day
  const at = (h: number) => mskAt(day, h).toISOString()
  const spread = { address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт', slots: [{ id: ids[0], startsAt: at(10) }, { id: ids[1], startsAt: at(10) }, { id: ids[2], startsAt: at(11) }] }
  const ok = await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'interview', spread })
  const res = (await ok.json()) as { applications: HrApplication[]; done: { historyId: number | null }[] }
  const times = res.applications.map((a) => (a.interview ? hourKey(new Date(a.interview.startsAt)) : ''))
  check('каждому своё время: двое в 10:00, один в 11:00', ok.status === 200 && times.filter((t) => t.endsWith('T10')).length === 2 && times.filter((t) => t.endsWith('T11')).length === 1, times)
  check('адрес общий у всех', res.applications.every((a) => a.interview?.address === 'Москва, ул. Рябиновая, 44'))
  const back = (await (await call('POST', '/api/hr/undo', { historyIds: res.done.flatMap((d) => (d.historyId ? [d.historyId] : [])) })).json()) as { results: { ok: boolean }[] }
  check('отмена раскладки — одним действием', back.results.length === 3 && back.results.every((x) => x.ok))
  const missing = await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'interview', spread: { ...spread, slots: spread.slots.slice(0, 2) } })
  check('не всем хватило времени — 422 и понятный текст', missing.status === 422 && ((await missing.json()) as { message: string }).message.includes('Не хватило времени для 1 из 3'))
  const sunday = (() => {
    let d = day
    for (let i = 0; i < 8 && mskParts(mskAt(d, 12)).dow !== 7; i++) d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)
    return d
  })()
  const off = await call('POST', '/api/hr/bulk', { ids, action: 'status', status: 'interview', spread: { ...spread, slots: ids.map((id) => ({ id, startsAt: mskAt(sunday, 11).toISOString() })) } })
  check('воскресенье в раскладке — нужно подтверждение', off.status === 422 && ((await off.json()) as { error: string }).error === 'off_hours')
}

console.log('Сотрудники')
{
  const weak = await call('POST', '/api/hr/users', { email: `new-${tag}@test.local`, name: 'Новый', password: '123' }, adminCookie)
  check('короткий пароль — 422', weak.status === 422)
  check('админ не может выключить себя', (await call('PATCH', `/api/hr/users/${admin.id}`, { disabled: true }, adminCookie)).status === 422)
  check('админ выключает сотрудника', (await call('PATCH', `/api/hr/users/${hr.id}`, { disabled: true }, adminCookie)).status === 200)
  check('сессии выключенного сотрудника сразу закрыты', (await app.request('/api/hr/me', { headers: { cookie: hrCookie } })).status === 401)
  check('выход — 200', (await call('POST', '/api/hr/logout', undefined, adminCookie)).status === 200)
  check('после выхода сессия не работает', (await app.request('/api/hr/me', { headers: { cookie: adminCookie } })).status === 401)
}

// Уборка: только то, что создал этот прогон
await sql`delete from jobs where payload ->> 'applicationId' in (select id from applications where name like ${'%' + tag})`
await sql`delete from applications where name like ${'%' + tag + '%'} or last_name like ${'%' + tag + '%'} or middle_name like ${'%' + tag + '%'}`
await sql`delete from hr_users where email like ${'%-' + tag + '@test.local'}`
await sql`update notify_templates set text = ${'{name}, напоминаем: завтра, {date}, в {time} — собеседование в «Очаково». Адрес: {address}. С собой: {bring}. Если планы изменились, позвони 8 800 100-77-77, доб. 1155, 3105, 2107.'} where status = 'reminder'`

await sql.end({ timeout: 5 })
console.log(`\nПройдено: ${passed}, провалено: ${failed}${skipped ? `, пропущено: ${skipped}` : ''}`)
process.exit(failed ? 1 : 0)
