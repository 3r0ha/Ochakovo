import type { CandidateStatus } from '@shared/candidateStatus'
import type { Assistant } from '../assistant/types'
import type { Session, Storage } from './storage'
import type { DialogReply, DialogUser, HandleMeta, OutMessage } from './types'

/** Сценарий самозаписи: кнопки b:… (server/dialog/flows/booking.ts) */
export type BookingHandler = (ctx: Ctx, parts: string[]) => Promise<DialogReply> | DialogReply

export type EngineOptions = {
  /** Адрес сайта для ссылок из бота */
  siteUrl: string
  /** Помощник для свободного текста; по умолчанию GigaChat из переменных окружения или офлайн-режим */
  assistant?: Assistant
  /** Случайные числа для колоды «Правда или миф» и раундов «Поймай брак»; проверки подставляют повторяемые */
  random?: () => number
  /** Сценарий самозаписи вместо server/dialog/flows/booking.ts — для проверок маршрутизации кнопок b:… */
  booking?: BookingHandler
}

/** Всё, что нужно сценарию на одном шаге. session меняется на месте и сохраняется движком */
export type Ctx = {
  user: DialogUser
  session: Session
  storage: Storage
  opts: EngineOptions
  assistant: Assistant
  /** У человека уже есть заявка: в меню «Моя заявка» вместо «Откликнуться» */
  hasApplication: boolean
  /** Статус его заявки глазами кандидата или null, если заявки нет. Запрашивается один раз за шаг */
  candidate: () => Promise<CandidateStatus | null>
  /** Данные запроса веб-чата: прогресс со страницы, заявка и код приглашения браузера. В мессенджерах пусто */
  meta: HandleMeta
  random: () => number
  /** Данные человека удалены в этом шаге: движок не записывает сессию заново */
  erased?: boolean
}

export const reply = (messages: OutMessage | OutMessage[], notice?: string): DialogReply => ({
  messages: Array.isArray(messages) ? messages : [messages],
  ...(notice ? { notice } : {}),
})

/** Состояние конкретного сценария внутри session.data */
export function state<T>(ctx: Ctx, key: string): T | undefined {
  return ctx.session.data[key] as T | undefined
}

export function setState<T>(ctx: Ctx, key: string, value: T | undefined) {
  if (value === undefined) delete ctx.session.data[key]
  else ctx.session.data[key] = value
}

export const siteBase = (ctx: Ctx) => ctx.opts.siteUrl.replace(/\/$/, '')

export function siteLink(ctx: Ctx) {
  const base = siteBase(ctx)
  return `${base}/${base.includes('?') ? '&' : '?'}src=${ctx.user.channel}`
}

/** Картинка к сообщению, если она есть: без sharp или при сбое отрисовки сообщение уходит текстом */
export const withImage = (path: string | null) => (path ? { image: { path } } : {})
