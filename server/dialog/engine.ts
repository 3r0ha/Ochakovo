import { candidateStatus, hrContactsLine, type CandidateStatus } from '@shared/candidateStatus'
import { defaultWorkSettings } from '@shared/workdays'
import { createAssistant } from '../assistant/assistant'
import type { Assistant } from '../assistant/types'
import { gigaChatFromEnv } from '../llm/gigachat'
import { offlineProvider } from '../llm/offline'
import type { BookingHandler, Ctx, EngineOptions } from './context'
import { reply, siteBase } from './context'
import * as apply from './flows/apply'
import * as checkin from './flows/checkin'
import * as companyQuiz from './flows/companyQuiz'
import * as friend from './flows/friend'
import * as ask from './flows/ask'
import * as game from './flows/game'
import * as menu from './flows/menu'
import * as money from './flows/money'
import * as myth from './flows/myth'
import * as practice from './flows/practice'
import * as quiz from './flows/quiz'
import * as remind from './flows/remind'
import * as status from './flows/status'
import * as tour from './flows/tour'
import * as vacancies from './flows/vacancies'
import { wantsToApply } from './intent'
import { isProgressQuestion, mergeSiteProgress } from './progress'
import { botLinkToken, type Storage } from './storage'
import { btn, link, menuRow, msg } from './ui'
import type { DialogEngine, DialogEvent, DialogReply, DialogUser, HandleMeta } from './types'

// Мозг бота «Квасыч». Не знает про Telegram и MAX: получает DialogEvent, отвечает DialogReply.
//
// Карта действий (Button.action, до 64 байт):
//   m                 меню             m:prac m:vac m:quiz m:game m:money m:myth m:tour m:cq m:apply m:ask m:friend m:status — разделы
//   x                 отмена текущего сценария → меню
//   pr:free pr:docs   бесплатная практика и документы по практике (m:prac — оплачиваемая)
//   cq:<id>:<вариант> «Что ты знаешь об „Очаково“» cq:next — следующий вопрос
//   rm:<направление>  «Напомнить о наборе» (m:remind — выбор), rm:off — «Не присылать»
//   del:ask del:yes   «Удалить мои данные» с подтверждением (и команда /delete)
//   b:…               самозапись на собеседование — сценарий server/dialog/flows/booking.ts (пакет самозаписи)
//   ci:…              «Как дела на смене»: ответ новичка и «Пусть HR позвонит» — server/dialog/flows/checkin.ts
//   v:list:<стр>      список вакансий  v:open:<id> — карточка вакансии
//   q:<шаг>:<ответ>   подбор работы
//   mo:r:<роль>       «Собери лето»    mo:m:<месяц> — отметить месяц, mo:done — итог
//   my:<id>:t|f       «Правда или миф» my:next — следующая карточка; id — карточки колоды (shared/content/content.ts)
//   g:go              «Поймай брак»    g:<раунд>:<номер бутылки> — ответ (4 бутылки, с третьего раунда — 6)
//   t:<этап>          «Путь кваса»     t:v:<этап> — вакансии этапа
//   a:start[:<id>]    заявка           a:name a:nostudy a:m:<месяц> a:mdone a:mnone a:sr:<готовность> a:sm:<месяц> a:v:<id|any> a:vl
//                                      a:noportfolio a:friend a:fskip a:nofriend a:practice a:stay a:edit a:e:<поле> a:ok
// Команды: /start [метка | ref_<код> | remind[-<метка>] | app_<токен>], /menu, /help, /stop, /delete, /cancel.
// /stop отвязывает заявки с сайта и выключает напоминания, /delete стирает данные человека после подтверждения.
// Свободный текст вне заявки отвечает помощник (server/assistant): GigaChat или офлайн-режим.

export type { EngineOptions } from './context'

/** Метка источника из диплинка: только латиница, цифры, _ и -, до 64 символов */
const cleanSource = (payload?: string) => {
  const s = (payload ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return s || null
}

/** Данные, которые переживают сброс сценария: история помощника и личный код «Позвать друга» */
const PERSISTENT_KEYS = [ask.ASK_KEY, friend.REF_KEY, status.APPLIED_KEY]

/** Сбросить сценарий. История разговора с помощником, профиль и код приглашения сохраняются */
function resetFlow(ctx: Ctx) {
  ctx.session.flow = null
  const kept: Record<string, unknown> = {}
  for (const key of PERSISTENT_KEYS) if (ctx.session.data[key] !== undefined) kept[key] = ctx.session.data[key]
  ctx.session.data = kept
}

/** «remind» и «remind-<метка>» — подписка «Напомнить о наборе»: undefined — это не она, null — без метки, строка — метка */
function remindPayload(payload: string): string | null | undefined {
  const m = /^remind(?:-([A-Za-z0-9_-]{1,57}))?$/.exec(payload)
  return m ? (m[1] ?? null) : undefined
}

/** Метка источника из start-параметра: ref_<код> → friend-<код>, свою же ссылку не засчитываем */
function sourceFromPayload(ctx: Ctx, payload?: string) {
  const source = cleanSource(payload)
  const code = friend.codeFromPayload(source)
  if (!code) return source
  const own = code === ctx.session.data[friend.REF_KEY] || (ctx.user.channel === 'web' && code === ctx.meta.refCode)
  return own ? null : `friend-${code}`
}

const HELP_LEAD =
  'Я Квасыч: расскажу про практику и вакансии, подберу работу под учёбу, посчитаю заработок и приму заявку. Вопросы пиши своими словами.'

let bookingModule: Promise<BookingHandler | null> | null = null

/** Модуль самозаписи подгружается при первой кнопке b:… Нет модуля — null, и бот честно отправляет к HR */
function loadBooking(): Promise<BookingHandler | null> {
  const path = './flows/booking'
  bookingModule ??= import(/* @vite-ignore */ path).then(
    (m: { route?: BookingHandler }) => (typeof m.route === 'function' ? m.route : null),
    () => null,
  )
  return bookingModule
}

async function booking(ctx: Ctx, parts: string[]): Promise<DialogReply> {
  const route = ctx.opts.booking ?? (await loadBooking())
  if (route) return route(ctx, parts)
  return reply(
    msg(`Время собеседования назначает отдел персонала после звонка. Связаться: ${hrContactsLine}.`, {
      buttons: [[btn('Моя заявка', 'm:status')], menuRow()],
    }),
  )
}

/** start=app_<токен>: заявка с сайта начинает получать ответы HR в этот чат. Метка источника не меняется */
async function linkFromSite(ctx: Ctx, token: string): Promise<DialogReply> {
  resetFlow(ctx)
  const app = ctx.user.channel !== 'web' && ctx.storage.linkBotApplication ? await ctx.storage.linkBotApplication(token, ctx.user).catch(() => null) : null
  if (!app) {
    // Повторный, чужой и просроченный токен — один и тот же ответ, без номера и имени
    return reply(menu.menuMessage(ctx, 'Ссылка уже использована или устарела. Статус заявки с сайта видно на странице «Моя заявка».'))
  }
  ctx.session.data[status.APPLIED_KEY] = app.id
  ctx.hasApplication = true
  return reply(msg(`Заявка № ${app.id} у HR. Сообщения о ней придут сюда. Чтобы их отключить, отправь /stop.`, { buttons: [[btn('Моя заявка', 'm:status'), btn('Меню', 'm')]] }))
}

/** /stop: заявки с сайта отвязываются от чата, напоминания о наборе выключаются */
async function stop(ctx: Ctx): Promise<DialogReply> {
  resetFlow(ctx)
  const unlinked = (await ctx.storage.unlinkBot?.(ctx.user)) ?? 0
  const hadRemind = Boolean(ctx.session.remind)
  if (hadRemind) await ctx.storage.setRemind?.(ctx.user, null)
  ctx.session.remind = null
  if (unlinked) {
    // «Моя заявка» в меню пересчитается по базе: заявка из этого чата останется, отвязанная с сайта — нет
    delete ctx.session.data[status.APPLIED_KEY]
    ctx.hasApplication = false
  }
  const parts = [
    ...(unlinked ? ['Заявка с сайта отвязана: сообщения о ней сюда больше не придут.'] : []),
    ...(hadRemind ? ['Напоминания о наборе выключены.'] : []),
  ]
  return reply(menu.menuMessage(ctx, parts.length ? parts.join(' ') : 'В этом чате нет заявок с сайта и напоминаний о наборе, выключать нечего.'))
}

/** «Удалить мои данные»: сначала подтверждение, потом — заявки, диалог, имя, ник и подписка */
async function erase(ctx: Ctx, confirmed: boolean): Promise<DialogReply> {
  resetFlow(ctx)
  if (ctx.user.channel === 'web' || !ctx.storage.eraseUser) {
    return reply(
      msg(`Заявку с сайта удаляют на странице «Моя заявка» или через отдел персонала: ${hrContactsLine}.`, {
        buttons: [[link('Моя заявка', `${siteBase(ctx)}/apply`)], menuRow()],
      }),
    )
  }
  if (!confirmed) {
    return reply(
      msg(
        '**Удалить мои данные**\n\nСотру заявки из этого чата и привязанные к нему с сайта, историю разговора и подписку на напоминания. ' +
          'HR больше не увидит эти заявки, отменить удаление нельзя.',
        { buttons: [[btn('Да, удалить', 'del:yes')], [btn('Отмена', 'x')]] },
      ),
    )
  }
  const { applications } = await ctx.storage.eraseUser(ctx.user)
  ctx.erased = true
  const what = applications ? 'Заявки, история разговора и подписка удалены.' : 'История разговора и подписка удалены, заявок в этом чате не было.'
  return reply(msg(`${what} Чтобы начать заново, отправь /start.`))
}

async function onAction(ctx: Ctx, action: string): Promise<DialogReply> {
  const parts = action.split(':')
  const [head, sub] = parts

  // Любая кнопка вне заявки выводит из режима ввода текста
  if (head !== 'a' && ctx.session.flow === 'apply') ctx.session.flow = null

  switch (head) {
    case 'm':
      if (!sub) {
        resetFlow(ctx)
        return menu.menu(ctx)
      }
      if (sub === 'prac') return practice.paid(ctx)
      if (sub === 'remind') return remind.offer(ctx)
      if (sub === 'cq') return companyQuiz.start(ctx)
      if (sub === 'vac') return vacancies.list(ctx, 0)
      if (sub === 'quiz') return quiz.start(ctx)
      if (sub === 'game') return game.intro(ctx)
      if (sub === 'money') return money.start(ctx)
      if (sub === 'myth') return myth.start(ctx)
      if (sub === 'tour') return tour.stage(ctx, 0)
      if (sub === 'apply') return apply.start(ctx)
      if (sub === 'ask') return ask.intro()
      if (sub === 'friend') return friend.invite(ctx)
      if (sub === 'status') return status.show(ctx)
      return menu.menu(ctx)
    case 'x':
      resetFlow(ctx)
      return menu.menu(ctx, 'Отменено')
    case 'pr':
      return practice.route(ctx, parts)
    case 'rm':
      return remind.route(ctx, parts)
    case 'del':
      return erase(ctx, sub === 'yes')
    case 'b':
      return booking(ctx, parts)
    case 'ci':
      return checkin.route(ctx, parts)
    case 'cq':
      return companyQuiz.route(ctx, parts)
    case 'v':
      return vacancies.route(ctx, parts)
    case 'q':
      return quiz.route(ctx, parts)
    case 'mo':
      return money.route(ctx, parts)
    case 'my':
      return myth.route(ctx, parts)
    case 'g':
      return game.route(ctx, parts)
    case 't':
      return tour.route(ctx, parts)
    case 'a':
      return apply.route(ctx, parts)
    default:
      return menu.menu(ctx)
  }
}

/** Подписи кнопок меню, набранные текстом (или пришедшие текстом из клавиатуры), открывают раздел */
const menuLabels: Record<string, string> = {
  'практика': 'm:prac',
  'оплачиваемая практика': 'm:prac',
  'бесплатная практика': 'pr:free',
  'документы по практике': 'pr:docs',
  'что ты знаешь об очаково': 'm:cq',
  'контрольные вопросы': 'm:cq',
  'напомнить о наборе': 'm:remind',
  'удалить мои данные': 'del:ask',
  'вакансии и зарплаты': 'm:vac',
  'подобрать работу': 'm:quiz',
  'поймай брак': 'm:game',
  'собери лето': 'm:money',
  'правда или миф': 'm:myth',
  'путь кваса': 'm:tour',
  // Старое название раздела — люди могут набрать его по памяти
  'экскурсия по заводу': 'm:tour',
  'спросить квасыча': 'm:ask',
  'откликнуться': 'm:apply',
  'позвать друга': 'm:friend',
  'моя заявка': 'm:status',
}

async function onText(ctx: Ctx, text: string): Promise<DialogReply> {
  const t = text.trim()
  const lower = t.toLowerCase()
  if (lower.startsWith('/start')) return onEvent(ctx, { type: 'start', payload: t.slice(6).trim() })
  if (['/menu', 'меню', 'menu'].includes(lower)) {
    resetFlow(ctx)
    return menu.menu(ctx)
  }
  if (['/help', 'помощь', 'help', '/помощь'].includes(lower)) {
    resetFlow(ctx)
    return reply(menu.menuMessage(ctx, HELP_LEAD))
  }
  if (lower === '/stop') return stop(ctx)
  if (lower === '/delete') return erase(ctx, false)
  if (lower === 'отмена' || lower === '/cancel') {
    resetFlow(ctx)
    return menu.menu(ctx, 'Отменено')
  }
  // Незнакомая команда — коротко и меню, а не ответ помощника
  if (/^\/[a-zа-я_]+/i.test(lower)) {
    resetFlow(ctx)
    return reply(menu.menuMessage(ctx, 'Такой команды нет. Выбери раздел или задай вопрос своими словами.'))
  }
  // Набранная подпись раздела открывает его и из заявки: имени «Вакансии и зарплаты» не бывает
  const label = menuLabels[lower.replace(/[«».,!?]/g, '').replace(/ё/g, 'е').trim()]
  if (label) return onAction(ctx, label)
  if (ctx.session.flow === 'apply') return apply.text(ctx, t)
  if (!t) return menu.menu(ctx)
  // Прогресс заданий и заявку знает только движок, помощник их не видит — отвечаем здесь
  const asksStatus = status.statusIntent(t)
  if (asksStatus === 'personal' || (asksStatus === 'generic' && ctx.hasApplication)) return status.show(ctx)
  // «Хочу откликнуться», «где заявку оставить» — сразу заявка, а не рассказ о ней
  if (wantsToApply(t)) return onAction(ctx, 'm:apply')
  if (isProgressQuestion(t)) return menu.progress(ctx)
  return ask.answer(ctx, t)
}

async function onEvent(ctx: Ctx, event: DialogEvent): Promise<DialogReply> {
  switch (event.type) {
    case 'start': {
      const raw = (event.payload ?? '').trim()
      // app_<токен> — привязка заявки с сайта: разбирается до метки источника и в источник не попадает
      const token = botLinkToken(raw)
      if (token) return linkFromSite(ctx, token)
      // remind и remind-<метка>: подписка, а исходная метка остаётся источником
      const remindLabel = remindPayload(raw)
      const source = remindLabel === undefined ? sourceFromPayload(ctx, raw) : remindLabel ? sourceFromPayload(ctx, remindLabel) : null
      if (source && !ctx.session.source) ctx.session.source = source
      resetFlow(ctx)
      if (remindLabel !== undefined && remind.remindAvailable(ctx)) return remind.offer(ctx)
      return menu.start(ctx)
    }
    case 'action':
      return onAction(ctx, event.action)
    case 'text':
      return onText(ctx, event.text)
    case 'contact':
      if (ctx.session.flow === 'apply') return apply.contact(ctx, event.phone)
      return menu.help(ctx)
  }
}

/** Помощник по умолчанию: GigaChat, если задан GIGACHAT_AUTH_KEY, иначе офлайн-режим по базе знаний */
function defaultAssistant(storage: Storage): Assistant {
  const provider = gigaChatFromEnv() ?? offlineProvider()
  return createAssistant({ provider, logGap: storage.logGap ? (gap) => storage.logGap!(gap) : undefined })
}

/** Статус заявки человека: на сайте — по номеру и токену браузера, в мессенджерах — последняя заявка из этого чата */
function candidateLookup(storage: Storage, user: DialogUser, meta?: HandleMeta): () => Promise<CandidateStatus | null> {
  let cached: Promise<CandidateStatus | null> | null = null
  const load = async () => {
    if (user.channel === 'web' && meta?.application && storage.statusForToken) {
      const byToken = await storage.statusForToken(meta.application.id, meta.application.token).catch(() => null)
      if (byToken) return byToken
    }
    if (!storage.latestApplicationFor) return null
    const app = await storage.latestApplicationFor(user.channel, user.id).catch(() => null)
    if (!app) return null
    const settings = (await storage.workSettings?.().catch(() => undefined)) ?? defaultWorkSettings
    return candidateStatus(app, new Date(), settings)
  }
  return () => (cached ??= load())
}

/** Сбой сценария в журнал: канал, тип события и кнопка. Ни текста, ни телефона, ни id человека, ни текста ошибки — в нём бывают данные заявки */
function logFailure(user: DialogUser, event: DialogEvent, error: unknown) {
  // Только строки «at …» стека: в первых строках — текст ошибки, а в нём может быть телефон или имя
  const where = error instanceof Error ? (error.stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, 3) : []
  console.error('[dialog] сбой сценария', {
    channel: user.channel,
    event: event.type,
    ...(event.type === 'action' ? { action: event.action.slice(0, 64) } : {}),
    error: error instanceof Error ? error.name : typeof error,
    where,
  })
}

export function createEngine(storage: Storage, opts: EngineOptions): DialogEngine {
  const assistant = opts.assistant ?? defaultAssistant(storage)
  const random = opts.random ?? Math.random
  return {
    async handle(user, event, meta) {
      const session = await storage.getSession(user)
      // Веб-чат присылает задания, пройденные на странице: «Смена» в чате совпадает с сайтом
      if (user.channel === 'web' && meta?.siteProgress) mergeSiteProgress(session.progress, meta.siteProgress)
      const candidate = candidateLookup(storage, user, meta)
      // Заявка уже есть: отправлена из этого чата (отмечено в сессии), есть у браузера на сайте или нашлась в базе
      let hasApplication = Boolean(session.data[status.APPLIED_KEY])
      if (!hasApplication && (storage.latestApplicationFor || (user.channel === 'web' && meta?.application && storage.statusForToken))) {
        const found = await candidate()
        if (found) session.data[status.APPLIED_KEY] = found.id
        hasApplication = Boolean(found)
      }
      const ctx: Ctx = { user, session, storage, opts, assistant, hasApplication, candidate, meta: meta ?? {}, random }
      let result: DialogReply
      try {
        result = await onEvent(ctx, event)
      } catch (error) {
        logFailure(user, event, error)
        resetFlow(ctx)
        result = reply(menu.menuMessage(ctx, 'Что-то пошло не так, начнём с меню.'))
      }
      // После «Удалить мои данные» диалог не записываем заново
      if (!ctx.erased) await storage.saveSession(user, ctx.session)
      return result
    },
  }
}
