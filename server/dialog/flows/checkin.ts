import {
  CHECKIN_CALL_TEXT,
  checkinHardReply,
  checkinReasons,
  isCheckinAnswer,
  isCheckinReason,
  isCheckinStep,
  type CheckinAnswer,
  type CheckinReason,
  type CheckinStep,
} from '@shared/adaptation'
import { hrContactsLine } from '@shared/candidateStatus'
import { adaptationDeps, answerCheckin, applicationForUser, checkinMessage, checkinView, requestCall, type AdaptDeps } from '../../adaptation'
import { reply, type Ctx } from '../context'
import type { Button, DialogReply } from '../types'
import { btn, menuRow, msg } from '../ui'

// «Как дела на смене» в боте (shared/adaptation.ts). Вопрос приходит по расписанию из очереди (server/adaptation).
// Кнопки:
//   ci:<шаг>:ask                                     вопрос ещё раз — из «Моей заявки»
//   ci:<шаг>:ok | ci:<шаг>:question | ci:<шаг>:hard   ответ на вопрос
//   ci:<шаг>:r:<причина>                              что тяжелее всего — после «Тяжело»
//   ci:call                                          «Пусть HR позвонит»

const CALL_LABEL = 'Пусть HR позвонит'
const callRow = (): Button[] => [btn(CALL_LABEL, 'ci:call')]
const statusRow = (): Button[] => [btn('Моя заявка', 'm:status'), btn('Меню', 'm')]

const OK_TEXT = `Спасибо. Если что-то пойдёт не так, в «Моей заявке» есть кнопка «${CALL_LABEL}».`
const QUESTION_TEXT = `Спрашивай здесь своими словами: отвечу по справочнику студента. Если нужен человек из отдела персонала, нажми «${CALL_LABEL}».`
const CLOSED_TEXT = `Вопросы о первых неделях уже не актуальны. Если нужна помощь, позвони в отдел персонала: ${hrContactsLine}.`

/** Кнопки причин после «Тяжело»: по две в ряд */
function reasonRows(step: CheckinStep): Button[][] {
  const rows: Button[][] = []
  checkinReasons.forEach((r, i) => {
    if (i % 2 === 0) rows.push([])
    rows.at(-1)!.push(btn(r.label, `ci:${step}:r:${r.id}`))
  })
  return rows
}

const via = (ctx: Ctx) => ctx.user.channel

async function answer(ctx: Ctx, deps: AdaptDeps, id: string, step: CheckinStep, a: CheckinAnswer, reason: CheckinReason | ''): Promise<DialogReply> {
  const r = await answerCheckin(deps, id, step, a, reason, via(ctx))
  if (!r.ok) return reply(msg(CLOSED_TEXT, { buttons: [statusRow()] }))
  if (a === 'ok') return reply(msg(OK_TEXT, { buttons: [statusRow()] }), 'Ответ передан')
  if (a === 'question') return reply(msg(QUESTION_TEXT, { buttons: [callRow(), statusRow()] }), 'Ответ передан')
  if (!reason) return reply(msg('**Что тяжелее всего?**', { buttons: [...reasonRows(step), statusRow()] }), 'Ответ передан')
  return reply(msg(checkinHardReply(reason), { buttons: [statusRow()] }))
}

export async function route(ctx: Ctx, parts: string[]): Promise<DialogReply> {
  const deps = adaptationDeps(ctx.storage)
  // Хранилище в памяти (симулятор бота): записать ответ некуда — честно отправляем к HR
  if (!deps) return reply(msg(`Ответ здесь не сохранится. Расскажи отделу персонала: ${hrContactsLine}.`, { buttons: [menuRow()] }))
  const id = await applicationForUser(deps, ctx.user, ctx.meta)
  if (!id) {
    const where = ctx.user.channel === 'web' ? 'из этого браузера' : 'из этого чата'
    return reply(msg(`Заявки ${where} я не вижу. Если нужна помощь, позвони в отдел персонала: ${hrContactsLine}.`, { buttons: [menuRow()] }))
  }

  if (parts[1] === 'call') {
    const r = await requestCall(deps, id)
    if (!r.ok) return reply(msg(CLOSED_TEXT, { buttons: [statusRow()] }))
    return reply(msg(r.repeated ? `Просьба уже у отдела персонала: тебе позвонят в рабочее время.` : CHECKIN_CALL_TEXT, { buttons: [statusRow()] }), r.repeated ? undefined : 'Передано HR')
  }

  const step = parts[1]
  if (!isCheckinStep(step)) return reply(msg(CLOSED_TEXT, { buttons: [statusRow()] }))
  if (parts[2] === 'ask') {
    const app = await deps.workflow.get(id)
    if (!app || checkinView(app).step !== step) return reply(msg(CLOSED_TEXT, { buttons: [statusRow()] }))
    return reply(checkinMessage(step))
  }
  if (parts[2] === 'r' && isCheckinReason(parts[3])) return answer(ctx, deps, id, step, 'hard', parts[3])
  if (isCheckinAnswer(parts[2])) return answer(ctx, deps, id, step, parts[2], '')
  return reply(msg(CLOSED_TEXT, { buttons: [statusRow()] }))
}

/**
 * Кнопки для «Моей заявки» в боте: вопрос, который ждёт ответа, и «Пусть HR позвонит».
 * Нет заявки «К оформлению» или «На смене» с датой первой смены — пусто
 */
export async function checkinRows(ctx: Ctx): Promise<Button[][]> {
  const deps = adaptationDeps(ctx.storage)
  if (!deps) return []
  const id = await applicationForUser(deps, ctx.user, ctx.meta).catch(() => null)
  const app = id ? await deps.workflow.get(id).catch(() => null) : null
  if (!app) return []
  const view = checkinView(app)
  const rows: Button[][] = []
  if (view.step) rows.push([btn(view.question, `ci:${view.step}:ask`)])
  if (view.call) rows.push(callRow())
  return rows
}
