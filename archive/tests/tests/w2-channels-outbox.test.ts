// «Исходящие» во вкладке «Боты» (w2-cn-4): приглашение на собеседование и напоминание накануне так, как их увидит
// кандидат в Telegram и MAX. Текст и кнопки совпадают с тем, что отправляет очередь уведомлений (server/notify):
// сверяем с сообщением, которое deliverNotification и deliverReminder передают адаптеру бота.
// Запуск: pnpm test w2-channels-outbox (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHrFields, type HrApplication } from '../../shared/applications'
import { renderTemplate } from '../../shared/notifyText'
import { checkinMessage } from '../../server/adaptation'
import { outboxSample, type OutboxEntry } from '../../server/api/hr-bots'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import { renderOutgoing } from '../../server/channels/preview'
import type { Adapter, Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import type { Job, JobsRepo } from '../../server/db/jobs'
import type { WorkflowRepo } from '../../server/db/workflow'
import { createEngine } from '../../server/dialog/engine'
import type { OutMessage } from '../../server/dialog/types'
import { deliverNotification, deliverReminder, type NotifyDeps } from '../../server/notify'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

test('«Исходящие»: приглашение и напоминание в виде Telegram и MAX — то же сообщение, что уходит из очереди уведомлений', async () => {
  await withTestDb('w2-channels-outbox', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    await repo.createUser({ email: 'olga@outbox.test', name: 'Ольга', role: 'hr', passwordHash: await hashPassword(password) })
    const app = await createApp({ storage, engine: createEngine(storage, { siteUrl: 'https://season.example.ru' }), bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'olga@outbox.test', password }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

    // Что очередь уведомлений передаёт боту: фейковый адаптер записывает сообщения
    const sent: OutMessage[][] = []
    const adapter: Adapter = { channel: 'telegram', startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async (_id, messages) => void sent.push(messages) }
    const bots: Registry = { get: (c) => (c === 'telegram' ? { adapter, secret: undefined } : undefined), active: () => ['telegram'], failed: () => [], start: () => {} }
    const { app: sample, interview } = outboxSample()
    const candidate: HrApplication = {
      ...emptyHrFields(),
      ...sample,
      createdAt: new Date().toISOString(),
      phone: '',
      contact: '',
      school: '',
      course: '',
      department: '',
      format: '',
      months: [],
      comment: '',
      channel: 'telegram',
      channelUserId: '5',
      status: 'interview',
      interview: { id: 1, ...interview },
    } as unknown as HrApplication
    const workflow = { get: async () => candidate, setNotify: async () => {}, comment: async () => 1 } as unknown as WorkflowRepo
    const deps: NotifyDeps = { repo, workflow, jobs: {} as JobsRepo, bots, sms: null }

    // Приглашение: очередь ставит текст шаблона interview, отправка — deliverNotification
    const invite = renderTemplate((await repo.template('interview'))!.text, candidate, candidate.interview)
    await deliverNotification(deps, { id: 1, kind: 'notify', runAt: new Date(), attempts: 0, payload: { applicationId: candidate.id, historyId: 1, text: invite } } as Job)
    // Напоминание накануне — deliverReminder с шаблоном reminder
    await deliverReminder(deps, { id: 2, kind: 'reminder', runAt: new Date(), attempts: 0, payload: { applicationId: candidate.id, interviewId: 1 } } as Job)
    assert.equal(sent.length, 2, 'очередь отправила приглашение и напоминание')

    for (const channel of ['telegram', 'max'] as const) {
      const res = await app.request(`/api/hr/bots/outbox?channel=${channel}`, { headers: { cookie } })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { entries: OutboxEntry[] }
      assert.deepEqual(
        body.entries.map((e) => e.key),
        ['interview', 'reminder', 'checkin'],
      )
      body.entries.slice(0, 2).forEach((e, i) => {
        assert.deepEqual(e.items, renderOutgoing(channel, sent[i]), `${e.title} в ${channel}: текст и кнопки как в очереди`)
        assert.ok(e.items.some((item) => item.kind === 'bot' && item.buttons.flat().some((b) => b.text === 'Меню')))
      })
      // «Как дела на смене» — то же сообщение, что уходит из очереди, с тремя кнопками ответа
      const checkin = body.entries[2]
      assert.deepEqual(checkin.items, renderOutgoing(channel, [checkinMessage('shift1')]))
      assert.deepEqual(
        checkin.items.flatMap((item) => (item.kind === 'bot' ? item.buttons.flat().map((b) => b.text) : [])),
        ['Всё нормально', 'Есть вопрос', 'Тяжело'],
      )
      // В тексте — имя, номер заявки и адрес из примера, без незаполненных подстановок
      const text = JSON.stringify(body.entries.map((e) => e.items))
      assert.ok(!/\{(name|id|date|time|address|bring|vacancy|ref|request)\}/.test(text), 'подстановки заполнены')
      assert.match(text, /Аня/)
    }
    assert.equal((await app.request('/api/hr/bots/outbox')).status, 401)
  })
})
