import { interviewDefaults, templateKeys, type TemplateKey } from '@shared/applications'
import { paidPractice } from '@shared/content/vacancies'
import { renderTemplate } from '@shared/notifyText'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { checkinMessage } from '../adaptation'
import { requireHr } from '../auth/session'
import { createPreview, previewChannels, renderOutgoing, type PreviewChannel, type PreviewInput, type ViewItem } from '../channels/preview'
import { botNamesFromEnv } from '../dialog/storage'
import type { OutMessage } from '../dialog/types'
import type { ApiDeps } from './index'

// Вкладка «Боты»: состояние каналов из настоящего окружения и предпросмотр ленты бота.
//   GET    /api/hr/bots                              — сайт, Telegram, MAX, помощник: работает или что нужно для запуска
//   GET    /api/hr/bots/preview?sid=&channel=        — лента предпросмотра в виде Telegram или MAX
//   POST   /api/hr/bots/preview {sid, channel, input} — действие в ленте: /start с меткой, текст, кнопка, контакт
//   DELETE /api/hr/bots/preview?sid=                 — начать заново
//   GET    /api/hr/bots/outbox?channel=              — «Исходящие»: приглашение, напоминание и вопрос «Как дела на смене» так, как их увидит кандидат
// Предпросмотр — отдельный движок в памяти с офлайн-помощником (server/channels/preview.ts): в мессенджер ничего
// не уходит, заявки, вопросы и источники в базу не пишутся. Доступ — requireHr на каждом маршруте.

export type ChannelState = {
  /** running — адаптер поднят; failed — токен задан, но адаптер не поднялся; off — токена нет */
  state: 'running' | 'failed' | 'off'
  /** Как бот получает сообщения: вебхук (задан PUBLIC_URL) или опрос API */
  via: 'webhook' | 'polling' | null
  /** Имя бота для ссылок (TELEGRAM_BOT_USERNAME, MAX_BOT_NICK) */
  name: string | null
}

export type BotsStatus = {
  /** Сайт отвечает: этот ответ пришёл от него. engine — чат на сайте и боты работают на движке диалогов */
  site: { engine: boolean }
  telegram: ChannelState
  max: ChannelState
  assistant: 'gigachat' | 'offline'
}

/**
 * Сообщение HR кандидату в бот — как его отправляет очередь уведомлений (server/notify, sendBot):
 * текст по шаблону и кнопка «Меню». Совпадение сверяет scripts/tests/w2-channels-outbox.test.ts
 */
export const notifyMessage = (text: string): OutMessage => ({ text, buttons: [[{ kind: 'action', text: 'Меню', action: 'm' }]] })

/** Какие сообщения показывают «Исходящие»: приглашение с временем и напоминание накануне */
export const outboxKeys: TemplateKey[] = ['interview', 'reminder']

/** key — шаблон сообщения HR или checkin: вопрос «Как дела на смене» (server/adaptation), у него свои кнопки ответа */
export type OutboxEntry = { key: TemplateKey | 'checkin'; title: string; hint: string; enabled: boolean; items: ViewItem[] }

/** Пример заявки для подстановок: имя, номер, вакансия; собеседование — завтра в 11:00 по Москве */
export function outboxSample(now = Date.now()) {
  const tomorrow = new Date(now + 3 * 3600e3 + 864e5).toISOString().slice(0, 10)
  return {
    app: { name: 'Аня', id: 'K7Q2M4', vacancyId: paidPractice[0]?.id ?? '', source: null },
    interview: { startsAt: new Date(`${tomorrow}T11:00:00+03:00`).toISOString(), ...interviewDefaults },
  }
}

const SID_RE = /^[A-Za-z0-9_-]{8,40}$/
const PAYLOAD_RE = /^[A-Za-z0-9_-]{0,64}$/

/** Разбор действия из тела запроса; null — такого действия не бывает */
export function parsePreviewInput(raw: unknown): PreviewInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.type) {
    case 'start': {
      const payload = typeof r.payload === 'string' ? r.payload.trim() : ''
      return PAYLOAD_RE.test(payload) ? { type: 'start', ...(payload ? { payload } : {}) } : null
    }
    case 'text':
      return typeof r.text === 'string' && r.text.trim() && r.text.length <= 1000 ? { type: 'text', text: r.text.trim() } : null
    case 'press': {
      const ref = r.ref as { turn?: unknown; msg?: unknown } | undefined
      const ok =
        ref &&
        Number.isInteger(ref.turn) &&
        Number.isInteger(ref.msg) &&
        (ref.turn as number) >= 0 &&
        (ref.msg as number) >= 0 &&
        typeof r.action === 'string' &&
        r.action &&
        Buffer.byteLength(r.action) <= 64 &&
        typeof r.label === 'string' &&
        r.label.length <= 128
      return ok ? { type: 'press', ref: { turn: ref.turn as number, msg: ref.msg as number }, action: r.action as string, label: r.label as string } : null
    }
    case 'contact':
      return { type: 'contact' }
    default:
      return null
  }
}

export function botsStatus({ bots, engine, env }: Pick<ApiDeps, 'bots' | 'engine' | 'env'>): BotsStatus {
  const active = bots.active()
  const failed = bots.failed()
  const via = env.PUBLIC_URL?.trim() ? 'webhook' : 'polling'
  const names = botNamesFromEnv(env)
  const state = (channel: PreviewChannel): ChannelState => {
    const s = active.includes(channel) ? 'running' : failed.includes(channel) ? 'failed' : 'off'
    return { state: s, via: s === 'running' ? via : null, name: names[channel] }
  }
  return {
    site: { engine: Boolean(engine) },
    telegram: state('telegram'),
    max: state('max'),
    assistant: env.GIGACHAT_AUTH_KEY ? 'gigachat' : 'offline',
  }
}

export function routes({ repo, bots, engine, env }: ApiDeps): Hono {
  const app = new Hono()
  const hr = requireHr(repo)
  const json = bodyLimit({ maxSize: 8 * 1024 })
  const siteUrl = env.SITE_URL?.trim() || 'http://localhost:5180'
  const preview = createPreview({ siteUrl })

  /** Сессия предпросмотра своя у каждого сотрудника и вкладки браузера */
  const key = (c: Context, sid: string) => `${c.get('hrUser').id}:${sid}`
  const channelOf = (v: unknown): PreviewChannel | null => (previewChannels.includes(v as PreviewChannel) ? (v as PreviewChannel) : null)

  app.get('/api/hr/bots', hr, (c) => c.json(botsStatus({ bots, engine, env })))

  app.get('/api/hr/bots/preview', hr, (c) => {
    const sid = c.req.query('sid') ?? ''
    const channel = channelOf(c.req.query('channel'))
    if (!SID_RE.test(sid) || !channel) return c.json({ error: 'invalid_request' }, 400)
    return c.json(preview.feed(key(c, sid), channel))
  })

  app.post('/api/hr/bots/preview', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sid?: unknown; channel?: unknown; input?: unknown } | null
    const sid = typeof body?.sid === 'string' ? body.sid : ''
    const channel = channelOf(body?.channel)
    const input = parsePreviewInput(body?.input)
    if (!SID_RE.test(sid) || !channel || !input) return c.json({ error: 'invalid_request' }, 400)
    return c.json(await preview.send(key(c, sid), channel, input))
  })

  app.get('/api/hr/bots/outbox', hr, async (c) => {
    const channel = channelOf(c.req.query('channel')) ?? 'telegram'
    const { app: sample, interview } = outboxSample()
    const entries: OutboxEntry[] = []
    for (const key of outboxKeys) {
      const template = await repo.template(key)
      if (!template) continue
      const meta = templateKeys.find((t) => t.id === key)!
      const text = renderTemplate(template.text, sample, interview)
      entries.push({ key, title: meta.label, hint: meta.hint, enabled: template.enabled, items: renderOutgoing(channel, [notifyMessage(text)]) })
    }
    // Вопрос новичку после первой смены — как его отправляет очередь (deliverCheckin), с кнопками ответа
    entries.push({
      key: 'checkin',
      title: 'Как дела на смене',
      hint: 'Новичку на следующий день после первой смены, через неделю и через месяц, в 18:00 по Москве. «Тяжело» ставит задачу перезвонить',
      enabled: true,
      items: renderOutgoing(channel, [checkinMessage('shift1')]),
    })
    return c.json({ channel, sample: { name: sample.name, id: sample.id }, entries })
  })

  app.delete('/api/hr/bots/preview', hr, (c) => {
    const sid = c.req.query('sid') ?? ''
    if (!SID_RE.test(sid)) return c.json({ error: 'invalid_request' }, 400)
    preview.reset(key(c, sid))
    return c.json({ ok: true })
  })

  return app
}
